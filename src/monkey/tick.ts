import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import type { WSData } from "../ws/types";
import type { MonkeyState, Perch, MonkeyAction, UserEvent, TaskDetail, DOMSection, DashboardContext, ScheduledTaskInfo, RecentTaskInfo, NewNote } from "./types";
import { askMonkeyBrain, replyViaBrain, getLastUsage, resetConversation, getPersona } from "./brain";
import { terminalJsonSummary } from "../html/terminalJsonSummary";

const TICK_ACTIVE_MS = 10_000;
const TICK_IDLE_MS = 30_000;
const MAX_EVENT_BUFFER = 20;

export class MonkeyEngine {
  private clients = new Set<ServerWebSocket<WSData>>();
  private tickTimer: Timer | null = null;
  private state: MonkeyState = {
    x: 100,
    y: 60,
    surface: null,
    animation: "idle",
    facing: "right",
  };
  private lastPerches: Perch[] = [];
  private lastDOMSections: DOMSection[] = [];
  private recentEvents: UserEvent[] = [];
  private lastTaskDetail: TaskDetail | null = null;
  private lastDashboard: DashboardContext | null = null;
  private tickInFlight = false;
  private seenNoteIds = new Set<string>();
  private seenNotesInitialized = false;
  private lastContextFingerprint = "";
  private isIdle = false;
  // Where the user is typing right now — fed to greg so he can roast it.
  private currentFocus: { field: string; value: string; at: number } | null = null;

  constructor(private readonly db: Database, private readonly gregDb: Database) {}

  start(): void {
    if (this.tickTimer) return;
    this.resetForFreshStart();
    console.log("[monkey] Engine started — adaptive tick (10s active, 30s idle)");
    this.scheduleTick();
  }

  /** Wipe Greg's conversation session and persisted history on every boot. */
  private resetForFreshStart(): void {
    resetConversation();
    this.seenNoteIds.clear();
    this.seenNotesInitialized = false;
    this.lastContextFingerprint = "";
    try {
      this.gregDb.prepare("DELETE FROM monkey_usage").run();
    } catch (err) {
      console.warn("[monkey] could not clear usage history:", err);
    }
    console.log("[monkey] Reset — empty session and history");
  }

  stop(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private scheduleTick(): void {
    const delay = this.isIdle ? TICK_IDLE_MS : TICK_ACTIVE_MS;
    this.tickTimer = setTimeout(() => {
      this.tick().finally(() => this.scheduleTick());
    }, delay);
  }

  tryUpgrade(req: Request, server: Server): boolean {
    const url = new URL(req.url);
    if (url.pathname !== "/ws/monkey") return false;
    return server.upgrade(req, {
      data: { type: "monkey" as const } as WSData,
    });
  }

  readonly wsHandlers = {
    open: (ws: ServerWebSocket<WSData>) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({
        type: "init",
        state: this.state,
        persona: getPersona(),
      }));
    },
    message: (ws: ServerWebSocket<WSData>, message: string | Buffer) => {
      try {
        const msg = JSON.parse(typeof message === "string" ? message : message.toString());
        if (msg.type === "perches") {
          this.lastPerches = msg.perches as Perch[];
        }
        if (msg.type === "dom_map") {
          this.lastDOMSections = msg.sections as DOMSection[];
        }
        if (msg.type === "state_update") {
          this.state = { ...this.state, ...msg.state };
        }
        if (msg.type === "user_event") {
          this.handleUserEvent(msg.event as UserEvent);
        }
        if (msg.type === "user_typing") {
          this.currentFocus = { field: String(msg.field ?? "a field"), value: String(msg.value ?? ""), at: Date.now() };
          this.isIdle = false;
          this.maybeReactToTyping();
        }
        if (msg.type === "user_blur") {
          this.currentFocus = null;
        }
        if (msg.type === "user_reply") {
          this.handleUserReply(msg.reply as string, msg.context as string);
        }
      } catch {}
    },
    close: (ws: ServerWebSocket<WSData>) => {
      this.clients.delete(ws);
    },
  };

  private handleUserEvent(event: UserEvent): void {
    // Buffer the event so the next brain tick can react to it emergently.
    // No canned instant reactions — every word Greg says comes from the brain.
    this.recentEvents.push(event);
    if (this.recentEvents.length > MAX_EVENT_BUFFER) {
      this.recentEvents.shift();
    }
    this.isIdle = false;
  }

  // React promptly when the user is typing — fire an extra tick rather than
  // waiting up to 10s for the scheduled one. Rate-limited so a burst of typing
  // signals doesn't spam the brain. If a tick is already in flight or the
  // cooldown hasn't elapsed, remember that we wanted to react and fire on the
  // next opportunity — otherwise Greg silently misses fast typing bursts.
  private lastTypingReactAt = 0;
  private typingTickPending = false;
  private maybeReactToTyping(): void {
    const now = Date.now();
    if (this.tickInFlight) { this.typingTickPending = true; return; }
    if (now - this.lastTypingReactAt < 6000) { this.typingTickPending = true; return; }
    this.lastTypingReactAt = now;
    this.typingTickPending = false;
    this.tick().catch(() => {});
  }

  // Format the live typing signal for the brain, if recent (<20s old).
  private currentFocusLine(): string | null {
    const f = this.currentFocus;
    if (!f) return null;
    if (Date.now() - f.at > 20_000) { this.currentFocus = null; return null; }
    const val = f.value ? `"${f.value.slice(0, 160)}"` : "(empty)";
    return `USER TYPING in "${f.field}": ${val}`;
  }

  private async handleUserReply(reply: string, grugSaid: string): Promise<void> {
    const reaction = await replyViaBrain(reply, grugSaid, this.lastTaskDetail, this.lastPerches);
    this.recordUsage();
    // Reflect whatever greg actually chose (a reply can be a slide/jump, not
    // just talk) so server state matches the command the client executes.
    this.updateStateFromAction(reaction);
    this.broadcast({ type: "command", action: reaction, state: this.state, persona: getPersona() });
  }

  private async tick(): Promise<void> {
    if (this.clients.size === 0) return;
    if (this.tickInFlight) return;

    this.tickInFlight = true;
    try {
      this.lastDashboard = this.getDashboardContext();
      this.lastTaskDetail = this.lastDashboard.activeTask;
      let taskContext = this.formatDashboardContext(this.lastDashboard);

      // What the user is typing right now (recent only) — prime roast material.
      const focus = this.currentFocusLine();
      if (focus) taskContext += `\n${focus}`;

      // Detect idle: nothing changed in DOM, task context, or events
      const fp = JSON.stringify([
        this.lastDOMSections.map(s => s.id + s.label + (s.content || "").slice(0, 30)),
        taskContext,
        this.recentEvents.length,
      ]);
      const hasNewNotes = this.lastDashboard.newNotes.length > 0;
      this.isIdle = fp === this.lastContextFingerprint && !hasNewNotes;
      this.lastContextFingerprint = fp;

      const action = await askMonkeyBrain(
        this.state,
        this.lastPerches,
        taskContext,
        this.recentEvents,
        this.lastTaskDetail,
        this.lastDOMSections,
      );

      this.recordUsage();
      this.updateStateFromAction(action);
      this.broadcast({ type: "command", action, state: this.state, persona: getPersona() });

      if (this.recentEvents.length > 5) {
        this.recentEvents = this.recentEvents.slice(-5);
      }
    } finally {
      this.tickInFlight = false;
      // Drain pending typing tick: if typing arrived while we were busy or
      // inside the 6s cooldown, fire a follow-up now so Greg's reaction lands
      // within ~one Haiku call instead of waiting for the scheduled tick.
      if (this.typingTickPending) {
        this.typingTickPending = false;
        this.lastTypingReactAt = Date.now();
        queueMicrotask(() => { this.tick().catch(() => {}); });
      }
    }
  }

  private getDashboardContext(): DashboardContext {
    const ctx: DashboardContext = {
      activeTask: null,
      activeTasks: [],
      recentTasks: [],
      scheduledTasks: [],
      newNotes: [],
      totalAgentsRunning: 0,
      openEscalations: 0,
    };

    try {
      // All running tasks (full detail, scoped per task)
      const tasks = this.db.prepare(
        "SELECT id, title, status, current_phase FROM tasks WHERE status = 'running' ORDER BY updated_at DESC LIMIT 5",
      ).all() as { id: string; title: string; status: string; current_phase: number }[];

      for (const task of tasks) {
        const agentCount = (this.db.prepare(
          "SELECT COUNT(*) as c FROM agent_instances WHERE task_id = ? AND status = 'running'",
        ).get(task.id) as { c: number })?.c ?? 0;

        const delegationCount = (this.db.prepare(
          "SELECT COUNT(*) as c FROM delegation_groups WHERE task_id = ? AND status = 'running'",
        ).get(task.id) as { c: number })?.c ?? 0;

        // Scoped to this task's agent instances
        const recentOutputRow = this.db.prepare(
          `SELECT data FROM terminal_outputs
           WHERE agent_id IN (SELECT id FROM agent_instances WHERE task_id = ?) AND stream = 'stdout'
           ORDER BY id DESC LIMIT 1`,
        ).get(task.id) as { data: string } | null;
        let recentOutput: string | null = null;
        if (recentOutputRow?.data) {
          try {
            const parsed = JSON.parse(recentOutputRow.data);
            recentOutput = terminalJsonSummary(parsed);
          } catch {
            recentOutput = recentOutputRow.data.slice(0, 150).replace(/\n/g, " ");
          }
        }

        const notes = this.db.prepare(
          `SELECT COALESCE(a.name, n.agent_id) AS agent, n.content
           FROM task_notes n LEFT JOIN agents a ON a.id = n.agent_id
           WHERE n.task_id = ? ORDER BY n.created_at DESC LIMIT 5`,
        ).all(task.id) as Array<{ agent: string; content: string }>;

        const artifacts = this.db.prepare(
          `SELECT a.name, a.kind FROM task_artifacts a
           INNER JOIN (SELECT name, MAX(version) AS mv FROM task_artifacts WHERE task_id = ? GROUP BY name) l
           ON a.name = l.name AND a.version = l.mv
           WHERE a.task_id = ? ORDER BY a.created_at DESC LIMIT 8`,
        ).all(task.id, task.id) as Array<{ name: string; kind: string }>;

        const detail = {
          title: task.title,
          status: task.status,
          phase: task.current_phase,
          agentCount,
          delegationCount,
          recentOutput: recentOutput ?? "",
          notes,
          artifacts,
        };

        ctx.activeTasks.push(detail);
      }

      // Keep activeTask as first running task for backward compat (reply context etc.)
      ctx.activeTask = ctx.activeTasks[0] ?? null;

      // Recent tasks (completed/failed — grug can comment on what just happened)
      ctx.recentTasks = this.db.prepare(
        `SELECT title, status, updated_at AS updatedAt FROM tasks
         WHERE status IN ('completed', 'failed', 'approved', 'draft')
         ORDER BY updated_at DESC LIMIT 5`,
      ).all() as RecentTaskInfo[];

      // Scheduled tasks
      try {
        ctx.scheduledTasks = this.db.prepare(
          `SELECT title, status, schedule_amount, schedule_unit, next_run_at, last_run_at
           FROM scheduled_tasks ORDER BY next_run_at ASC LIMIT 5`,
        ).all().map((r: any) => ({
          title: r.title,
          status: r.status,
          scheduleAmount: r.schedule_amount,
          scheduleUnit: r.schedule_unit,
          nextRunAt: r.next_run_at,
          lastRunAt: r.last_run_at,
        })) as ScheduledTaskInfo[];
      } catch { }

      // Global agent count
      ctx.totalAgentsRunning = (this.db.prepare(
        "SELECT COUNT(*) as c FROM agent_instances WHERE status = 'running'",
      ).get() as { c: number })?.c ?? 0;

      // Open escalations
      ctx.openEscalations = (this.db.prepare(
        "SELECT COUNT(*) as c FROM escalations WHERE status = 'open'",
      ).get() as { c: number })?.c ?? 0;

      // New notes since last tick
      try {
        const allRecent = this.db.prepare(
          `SELECT n.id, COALESCE(a.name, n.agent_id) AS agent, n.content, n.created_at,
                  t.title AS task_title
           FROM task_notes n
           LEFT JOIN agents a ON a.id = n.agent_id
           LEFT JOIN tasks t ON t.id = n.task_id
           ORDER BY n.created_at DESC LIMIT 20`,
        ).all() as Array<{ id: string; agent: string; content: string; created_at: string; task_title: string }>;

        if (!this.seenNotesInitialized) {
          // First tick: seed seen set with existing notes so we don't dump history
          for (const row of allRecent) this.seenNoteIds.add(row.id);
          this.seenNotesInitialized = true;
        } else {
          for (const row of allRecent) {
            if (this.seenNoteIds.has(row.id)) continue;
            this.seenNoteIds.add(row.id);
            ctx.newNotes.push({
              id: row.id,
              agent: row.agent,
              content: row.content,
              taskTitle: row.task_title || "unknown task",
              createdAt: row.created_at,
            });
          }
        }
        // Cap memory — drop oldest tracked IDs if set grows too large
        if (this.seenNoteIds.size > 500) {
          const arr = [...this.seenNoteIds];
          this.seenNoteIds = new Set(arr.slice(-200));
        }
      } catch { }

    } catch (err) {
      console.warn("[monkey] getDashboardContext error:", err);
    }

    return ctx;
  }

  private formatDashboardContext(dc: DashboardContext): string {
    const p: string[] = [];

    if (dc.newNotes.length > 0) {
      p.push("NEW NOTES:");
      for (const n of dc.newNotes) {
        p.push(`${n.agent}@"${n.taskTitle}":"${n.content.slice(0, 100)}"`);
      }
    }

    if (dc.activeTasks.length > 0) {
      for (let i = 0; i < dc.activeTasks.length; i++) {
        const t = dc.activeTasks[i];
        p.push(`TASK[${i + 1}]:"${t.title}" p${t.phase + 1} ${t.status} ${t.agentCount}agents ${t.delegationCount}deleg`);
        if (t.recentOutput) p.push(`  out:"${t.recentOutput.slice(0, 80)}"`);
        for (const n of t.notes.slice(0, 2)) {
          p.push(`  ${n.agent}:"${n.content.slice(0, 60)}"`);
        }
        if (t.artifacts.length > 0) p.push(`  art:${t.artifacts.map(a => a.name).join(",")}`);
      }
    } else {
      p.push("no task");
    }

    if (dc.recentTasks.length > 0) {
      p.push("recent:" + dc.recentTasks.map(t => `${t.title}(${t.status})`).join(","));
    }

    if (dc.scheduledTasks.length > 0) {
      p.push("sched:" + dc.scheduledTasks.map(s => `${s.title}/${s.scheduleAmount}${s.scheduleUnit[0]}`).join(","));
    }

    if (dc.totalAgentsRunning > 0) p.push(`${dc.totalAgentsRunning}agents`);
    if (dc.openEscalations > 0) p.push(`${dc.openEscalations}esc!`);

    return p.join("\n");
  }

  private updateStateFromAction(action: MonkeyAction): void {
    switch (action.type) {
      case "walk":
        this.state.facing = action.direction;
        this.state.animation = "walking";
        break;
      case "jump":
        this.state.animation = "jumping";
        break;
      case "slide":
        this.state.animation = "sliding";
        break;
      case "idle":
        this.state.animation = "idle";
        break;
      case "say":
        this.state.animation = "talking";
        break;
    }
  }

  private recordUsage(): void {
    const usage = getLastUsage();
    if (!usage) return;
    try {
      this.gregDb.prepare(
        `INSERT INTO monkey_usage (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, request_type, conversation_length, response_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.cost_usd, usage.request_type, usage.conversation_length, usage.response_text);
    } catch {}
  }

  private broadcast(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      try { ws.send(payload); } catch { this.clients.delete(ws); }
    }
  }
}
