import type { Transport, ImportResult, TaskEditFields, TransportCapabilities } from "./types";
import { socketURL, dashboardURL, httpBase as httpBaseOf, authHeaders, serverLabel, localServer, type ServerConfig } from "../servers";
import type {
  TransportEvent,
  TaskItem,
  Escalation,
  Note,
  Message,
  TimelineEntry,
  Artifact,
  AgentInstance,
  ActivityRow,
  Metrics,
} from "../model/types";
import { summarizeTerminalLine } from "../../html/terminalJsonSummary";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * This machine's daemon over two loopback sockets, both unauthenticated by
 * design (the daemon binds loopback; the local web UI has no auth either):
 *
 *   /connect/local          the Connect consumer protocol: state snapshot, fat
 *                           events, every write action, per-task output tails.
 *   /ws/ui?format=json      the dashboard lanes the web UI already pushes: the
 *                           live agent roster, the summarized global activity
 *                           feed, and header metrics.
 *
 * Both reconnect independently with backoff; the next snapshot resyncs.
 */
export class LocalTransport implements Transport {
  readonly label: string;
  private readonly server: ServerConfig;

  private onEvent: ((e: TransportEvent) => void) | null = null;
  private closed = false;

  private connect: Sock | null = null;
  private dash: Sock | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private subscribed = new Set<string>();
  /** Instance id → owning task title, so a remote roster row can name its task. */
  private taskTitles = new Map<string, string>();

  /**
   * `server` defaults to this machine's daemon. A remote server (Skipper
   * Connect integrator) uses the same frames over `wss://…/connect?token=`
   * and has no dashboard lane or loopback HTTP routes.
   */
  constructor(server: ServerConfig = localServer()) {
    this.server = server;
    this.label = serverLabel(server);
  }

  get remote(): boolean {
    return this.server.kind === "remote";
  }

  /** Loopback HTTP base, or null on a remote. */
  get httpBase(): string | null {
    return httpBaseOf(this.server);
  }

  capabilities(): TransportCapabilities {
    const local = !this.remote;
    return { remote: !local, globalFeed: local, fullTeamImport: local, editAnyStatus: local };
  }

  async start(onEvent: (e: TransportEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.connect = new Sock(socketURL(this.server), {
      headers: authHeaders(this.server),
      onOpen: () => this.emit({ kind: "status", status: "connected" }),
      onMessage: (raw) => this.handleConnectFrame(raw),
      onStatus: (s) => this.emit({ kind: "status", status: s }),
      onClose: (code) => {
        this.failPending("connection lost");
        // The integrator closes 4001 on a bad or revoked key (no auth_error frame).
        if (code === 4001) {
          this.connect?.stop();
          this.emit({ kind: "status", status: "closed" });
          this.emit({ kind: "auth_failed", message: "authentication failed: check the integrator key for this server" });
        }
      },
    });
    const dashURL = dashboardURL(this.server);
    if (dashURL) {
      this.dash = new Sock(dashURL, {
        onOpen: (ws) => {
          try {
            ws.send(JSON.stringify({ type: "subscribe", topics: ["dashboard"] }));
          } catch {
            /* race with close */
          }
        },
        onMessage: (raw) => {
          for (const ev of parseDashboardFrame(raw)) this.emit(ev);
        },
      });
    }
    this.connect.open();
    this.dash?.open();
  }

  resync(): void {
    if (this.closed) return;
    void this.requestSnapshot();
    this.dash?.bounce();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connect?.close();
    this.dash?.close();
    this.failPending("closed");
  }

  request<T = unknown>(resource: string, action: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.connect?.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const id = `tui-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${resource}/${action} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ type: "request", id, resource, action, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  subscribeOutputs(taskId: string): void {
    if (!taskId) return;
    this.subscribed.add(taskId);
    this.sendConnect({ type: "subscribe", channel: "outputs", taskId });
  }

  unsubscribeOutputs(taskId: string): void {
    if (!this.subscribed.delete(taskId)) return;
    this.sendConnect({ type: "unsubscribe", channel: "outputs", taskId });
  }

  async updateTask(taskId: string, fields: TaskEditFields): Promise<void> {
    const base = this.httpBase;
    if (!base) {
      // No loopback route on a remote: Connect's tasks/update is draft-only, so
      // try it and let the daemon's message explain when the task is not a draft.
      await this.request("tasks", "update", { id: taskId, ...fields });
      return;
    }
    const form = new FormData();
    if (fields.title !== undefined) form.set("title", fields.title);
    if (fields.description !== undefined) form.set("description", fields.description);
    if (fields.teamId !== undefined) form.set("teamId", fields.teamId);
    if (fields.workingDirectory !== undefined) form.set("workingDirectory", fields.workingDirectory);
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/update`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `update failed (${res.status})`);
    }
  }

  async importTeams(json: string): Promise<ImportResult> {
    let body: unknown;
    try {
      body = JSON.parse(json);
    } catch (err) {
      throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Accept one bare team object too (the export of a single team, unwrapped).
    if (body && typeof body === "object" && !Array.isArray(body) && !("teams" in (body as object))) body = [body];
    const base = this.httpBase;
    if (!base) return this.importTeamsOverConnect(body);
    const res = await fetch(`${base}/api/teams/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<ImportResult> & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `import failed (${res.status})`);
    return { imported: data.imported ?? 0, updated: data.updated ?? 0, errors: data.errors ?? [] };
  }

  /**
   * Remote import through `teams/create` / `teams/update` (name, phases, agents,
   * mode). The Connect verbs do not carry skipper_prompt, hooks or Slack config,
   * so those fields of the export are dropped; the toast says so.
   */
  private async importTeamsOverConnect(body: unknown): Promise<ImportResult> {
    const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { teams?: unknown }).teams) ? ((body as { teams: unknown[] }).teams) : null;
    if (!list) throw new Error("expected an array of teams or { teams: [...] }");
    const existing = await this.request<Array<{ id: string }>>("teams", "list-all").catch(() => [] as Array<{ id: string }>);
    const known = new Set(existing.map((t) => t.id));
    const result: ImportResult = { imported: 0, updated: 0, errors: [] };
    for (const raw of list) {
      const t = (raw ?? {}) as Record<string, unknown>;
      const label = String(t.id ?? t.name ?? "(unnamed)");
      const cfg = (t.config && typeof t.config === "object" ? t.config : {}) as Record<string, unknown>;
      const mode = cfg.mode === "conversational" || cfg.mode === "realtime" ? "conversational" : "workflow";
      const params = { name: t.name, phases: t.phases, agents: t.agents, mode };
      try {
        if (typeof t.id === "string" && known.has(t.id)) {
          await this.request("teams", "update", { id: t.id, ...params });
          result.updated++;
        } else {
          await this.request("teams", "create", params);
          result.imported++;
        }
      } catch (err) {
        result.errors.push({ team: label, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async exportTeams(teamId?: string): Promise<string> {
    const base = this.httpBase;
    if (!base) {
      // Remote: the Connect projection (no skipper_prompt/hooks); still re-importable.
      const teams = await this.request<Array<Record<string, unknown>>>("teams", "list-all");
      const pick = teamId ? teams.filter((t) => t.id === teamId) : teams;
      if (teamId && pick.length === 0) throw new Error("Team not found");
      return JSON.stringify({ teams: pick.map((t) => ({ id: t.id, name: t.name, phases: t.phases, agents: t.agents, config: { mode: t.mode, slackEnabled: t.slackEnabled, slashCommand: t.slashCommand } })) }, null, 2);
    }
    const url = `${base}/api/teams/export${teamId ? `?id=${encodeURIComponent(teamId)}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `export failed (${res.status})`);
    }
    return await res.text();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private emit(e: TransportEvent): void {
    this.onEvent?.(e);
  }

  private sendConnect(msg: Record<string, unknown>): void {
    const ws = this.connect?.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* race with close */
    }
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private async requestSnapshot(): Promise<void> {
    try {
      const snap = await this.request<Record<string, unknown>>("state", "snapshot");
      this.emit({
        kind: "snapshot",
        tasks: toTasks(snap.tasks),
        escalations: toEscalations(snap.escalations),
        titleGeneratorConfigured: snap.titleGeneratorConfigured === true,
      });
      if (Array.isArray(snap.features)) {
        this.emit({ kind: "capabilities", protocolVersion: num(snap.protocolVersion), features: snap.features.map(String) });
      }
    } catch {
      // the socket dropped mid-request; the reconnect re-snapshots
    }
  }

  private handleConnectFrame(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "auth_ok":
        void this.requestSnapshot();
        for (const taskId of this.subscribed) this.sendConnect({ type: "subscribe", channel: "outputs", taskId });
        return;
      case "auth_error":
        this.emit({ kind: "status", status: "closed" });
        return;
      case "ping":
        this.sendConnect({ type: "pong" });
        return;
      case "pong":
        return;
      case "response": {
        const id = String(msg.id ?? "");
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(String(msg.error ?? "request failed")));
        return;
      }
      case "event": {
        const name = String(msg.event ?? "");
        const payload = (msg.payload ?? {}) as Record<string, unknown>;
        const ev = mapConnectEvent(name, payload);
        if (ev) this.emit(ev);
        // Without the dashboard lane the roster is rebuilt from per-instance
        // liveness events (the task projection rides along on the fat event).
        if (this.remote && name === "instance:state_changed") {
          const task = payload.task && typeof payload.task === "object" ? (payload.task as Record<string, unknown>) : null;
          const taskId = String(payload.taskId ?? "");
          if (task && typeof task.title === "string") this.taskTitles.set(taskId, task.title);
          const templateId = String(payload.templateAgentId ?? "agent");
          this.emit({
            kind: "instance",
            instance: {
              id: String(payload.instanceId ?? ""),
              template_agent_name: templateId.includes(":") ? templateId.slice(templateId.lastIndexOf(":") + 1) : templateId,
              task_id: taskId || null,
              task_title: this.taskTitles.get(taskId) ?? null,
              status: String(payload.status ?? ""),
              updated_at: typeof msg.ts === "string" ? msg.ts : null,
            },
          });
        }
        return;
      }
      case "output_batch": {
        const taskId = String(msg.taskId ?? "");
        const entries = Array.isArray(msg.entries) ? (msg.entries as Record<string, unknown>[]) : [];
        const rows: ActivityRow[] = [];
        for (const e of entries) {
          const data = String(e.data ?? "");
          const stream = String(e.stream ?? "stdout");
          for (const line of data.split("\n")) {
            const summarized = summarizeTerminalLine(stream, line);
            if (!summarized) continue;
            rows.push({
              agent_id: String(e.agentId ?? ""),
              agent_name: String(e.agentName ?? "agent"),
              task_id: taskId,
              kind: summarized.kind,
              text: summarized.text,
              stream,
              created_at: typeof e.ts === "string" ? e.ts : null,
            });
          }
        }
        this.emit({ kind: "output", taskId, rows, backfill: msg.backfill === true });
        return;
      }
      default:
        return; // subscribed / unsubscribed / sub_error acks
    }
  }
}

// ── reconnecting socket ──────────────────────────────────────────────────────

interface SockHandlers {
  /** Extra request headers (Bun extension; the token also rides in the URL). */
  headers?: Record<string, string>;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (raw: string) => void;
  onStatus?: (s: "connecting" | "reconnecting" | "closed") => void;
  onClose?: (code: number) => void;
}

class Sock {
  socket: WebSocket | null = null;
  private closed = false;
  private backoffMs = 250;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private everOpened = false;

  constructor(
    private readonly url: string,
    private readonly h: SockHandlers,
  ) {}

  open(): void {
    if (this.closed) return;
    this.h.onStatus?.(this.everOpened ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      const headers = this.h.headers && Object.keys(this.h.headers).length ? this.h.headers : undefined;
      ws = headers ? new WebSocket(this.url, { headers } as unknown as string[]) : new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.addEventListener("open", () => {
      this.backoffMs = 250;
      this.everOpened = true;
      this.h.onOpen?.(ws);
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") this.h.onMessage(ev.data);
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      if (this.socket === ws) this.socket = null;
      this.h.onClose?.(ev.code);
      if (this.closed) return;
      this.h.onStatus?.("reconnecting");
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  /** Stop reconnecting for good (permanent auth failure). */
  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drop and reconnect (fresh snapshot on the other side). */
  bounce(): void {
    try {
      this.socket?.close();
    } catch {
      /* the close handler reconnects */
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 5000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }
}

// ── wire → domain ───────────────────────────────────────────────────────────

export function mapConnectEvent(name: string, p: Record<string, unknown>): TransportEvent | null {
  switch (name) {
    case "connect:capabilities":
      return { kind: "capabilities", protocolVersion: num(p.protocolVersion), features: Array.isArray(p.features) ? p.features.map(String) : [] };
    case "task:created":
    case "task:state_changed":
    case "task:run_completed":
    case "task:run_failed":
    case "task:wake_requested":
    case "task:needs_review_changed":
    case "instance:state_changed": {
      if (name === "task:state_changed" && p.newStatus === "deleted") return { kind: "task_deleted", taskId: String(p.taskId ?? "") };
      if (p.task && typeof p.task === "object") {
        const task = toTask(p.task as Record<string, unknown>);
        if (name === "task:created") return { kind: "task", task, created: true };
        if (name === "task:state_changed" && p.previousStatus === "draft" && p.newStatus === "active") return { kind: "task", task, started: true };
        return { kind: "task", task };
      }
      return null;
    }
    case "task:phase_changed":
      if (p.task && typeof p.task === "object") return { kind: "task", task: toTask(p.task as Record<string, unknown>) };
      return { kind: "task_phase", taskId: String(p.taskId ?? ""), newPhase: num(p.newPhase) };
    case "escalation:created":
      if (p.escalation && typeof p.escalation === "object") return { kind: "escalation", escalation: toEscalation(p.escalation as Record<string, unknown>) };
      return null;
    case "escalation:resolved":
      return {
        kind: "escalation_resolved",
        escalationId: String(p.escalationId ?? ""),
        taskId: String(p.taskId ?? ""),
        ...(p.escalation && typeof p.escalation === "object" ? { escalation: toEscalation(p.escalation as Record<string, unknown>) } : {}),
      };
    case "task:note_added":
      if (p.note && typeof p.note === "object") return { kind: "note", note: toNote(p.note as Record<string, unknown>) };
      return null;
    case "task:message_posted":
      if (p.message && typeof p.message === "object") return { kind: "message", message: toMessage(p.message as Record<string, unknown>) };
      return null;
    case "realtime:timeline_updated":
      if (p.entry && typeof p.entry === "object") return { kind: "timeline", entry: toTimelineEntry(p.entry as Record<string, unknown>) };
      return null;
    case "artifact:created":
    case "artifact:published":
    case "artifact:unpublished":
      if (p.artifact && typeof p.artifact === "object") return { kind: "artifact", artifact: toArtifact(p.artifact as Record<string, unknown>) };
      return null;
    default:
      return null;
  }
}

/** Dashboard JSON frames → the roster / activity / metrics lanes. */
export function parseDashboardFrame(raw: string): TransportEvent[] {
  let msg: { resource?: string; data?: unknown; type?: string };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return [];
  }
  if (msg.type === "ping" || msg.type === "pong") return [];
  const data = (msg.data ?? {}) as Record<string, unknown>;
  switch (msg.resource) {
    case "dashboard:snapshot":
      return [
        { kind: "agents", agents: toAgents(data.running_instances) },
        { kind: "activity", activity: toActivity(data.activity) },
        { kind: "metrics", metrics: toMetrics(data.metrics) },
      ];
    case "dashboard:instances":
      return [{ kind: "agents", agents: toAgents(data.running_instances) }];
    case "dashboard:activity":
      return [{ kind: "activity", activity: toActivity(data.activity) }];
    case "dashboard:metrics":
      return [{ kind: "metrics", metrics: toMetrics(data) }];
    default:
      return [];
  }
}

export function toTask(o: Record<string, unknown>): TaskItem {
  return {
    id: String(o.id ?? ""),
    title: String(o.title ?? ""),
    status: String(o.status ?? ""),
    display_status: String(o.display_status ?? o.status ?? ""),
    mode: String(o.mode ?? "workflow"),
    paused: o.paused === true,
    memory_enabled: o.memory_enabled === true,
    memory_mode: String(o.memory_mode ?? "off"),
    team_id: str(o.team_id),
    team_name: str(o.team_name),
    current_phase: num(o.current_phase),
    phase_count: o.phase_count == null ? null : num(o.phase_count),
    needs_review: o.needs_review === true,
    starred: o.starred === true,
    icon: str(o.icon),
    icon_color: str(o.icon_color),
    created_at: String(o.created_at ?? ""),
    updated_at: str(o.updated_at),
    started_at: str(o.started_at),
    source_scheduled_task_id: str(o.source_scheduled_task_id),
  };
}

function toTasks(v: unknown): TaskItem[] {
  return Array.isArray(v) ? v.map((r) => toTask(r as Record<string, unknown>)) : [];
}

export function toEscalation(o: Record<string, unknown>): Escalation {
  return {
    id: String(o.id ?? ""),
    taskId: String(o.taskId ?? o.task_id ?? ""),
    agentId: String(o.agentId ?? o.agent_id ?? ""),
    agentName: str(o.agentName ?? o.agent_name),
    type: String(o.type ?? ""),
    status: String(o.status ?? "open"),
    question: String(o.question ?? ""),
    response: str(o.response),
    createdAt: String(o.createdAt ?? o.created_at ?? ""),
  };
}

function toEscalations(v: unknown): Escalation[] {
  return Array.isArray(v) ? v.map((r) => toEscalation(r as Record<string, unknown>)) : [];
}

export function toNote(o: Record<string, unknown>): Note {
  return {
    id: String(o.id ?? ""),
    taskId: String(o.taskId ?? o.task_id ?? ""),
    agentName: str(o.agentName ?? o.agent_name),
    source: str(o.source),
    content: String(o.content ?? ""),
    createdAt: str(o.createdAt ?? o.created_at),
    deletedAt: str(o.deletedAt),
  };
}

export function toMessage(o: Record<string, unknown>): Message {
  return {
    id: String(o.id ?? ""),
    taskId: String(o.taskId ?? ""),
    agentName: str(o.agentName),
    content: String(o.content ?? ""),
    format: str(o.format),
    createdAt: String(o.createdAt ?? ""),
  };
}

export function toTimelineEntry(o: Record<string, unknown>): TimelineEntry {
  const art = o.artifact && typeof o.artifact === "object" ? (o.artifact as Record<string, unknown>) : null;
  return {
    id: String(o.id ?? ""),
    taskId: String(o.taskId ?? ""),
    entryType: String(o.entryType ?? "text"),
    content: String(o.content ?? ""),
    fedToSkipper: o.fedToSkipper === true,
    createdAt: String(o.createdAt ?? ""),
    artifactName: art ? str(art.name) : null,
  };
}

export function toArtifact(o: Record<string, unknown>): Artifact {
  return {
    id: String(o.id ?? ""),
    taskId: String(o.taskId ?? ""),
    name: String(o.name ?? ""),
    kind: String(o.kind ?? ""),
    version: num(o.version),
    description: str(o.description),
    format: str(o.format),
    createdAt: String(o.createdAt ?? ""),
    publishedAt: str(o.publishedAt),
    publicUrl: str(o.publicUrl),
    storage: String(o.storage ?? "inline"),
    mime: str(o.mime),
    bytes: o.bytes == null ? null : num(o.bytes),
  };
}

function toAgents(v: unknown): AgentInstance[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      template_agent_name: String(o.template_agent_name ?? o.template_agent_id ?? "agent"),
      task_id: str(o.task_id),
      task_title: str(o.task_title),
      status: String(o.status ?? ""),
      updated_at: str(o.updated_at),
    };
  });
}

const ACTIVITY_KINDS = new Set(["message", "tool", "event", "note"]);

function toActivity(v: unknown): ActivityRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    const kind = typeof o.kind === "string" && ACTIVITY_KINDS.has(o.kind) ? o.kind : "event";
    return {
      agent_id: String(o.agent_id ?? ""),
      agent_name: String(o.agent_name ?? "agent"),
      kind: kind as ActivityRow["kind"],
      text: String(o.text ?? ""),
      stream: String(o.stream ?? "stdout"),
      created_at: str(o.created_at),
    };
  });
}

function toMetrics(v: unknown): Metrics {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    running: num(o.running),
    queued: num(o.queued),
    completed: num(o.completed),
    failed: num(o.failed),
    activeAgentCount: num(o.activeAgentCount),
  };
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
