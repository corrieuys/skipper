import type {
  TaskItem,
  TaskDetail,
  AgentInstance,
  ActivityRow,
  Escalation,
  Note,
  Message,
  TimelineEntry,
  Artifact,
  Metrics,
  TransportEvent,
  ConnStatus,
} from "./types";
import { EMPTY_METRICS } from "./types";

/** Everything loaded for one task beyond its list projection. */
export interface TaskBundle {
  detail: TaskDetail | null;
  notes: Note[];
  messages: Message[];
  timeline: TimelineEntry[];
  artifacts: Artifact[];
  /** Answered escalations for this task (question + your response), oldest first. */
  resolvedEscalations: Escalation[];
  /** Live output tail (summarized), oldest first, capped. */
  output: ActivityRow[];
  loadedAt: number | null;
  loading: boolean;
  error: string | null;
}

const OUTPUT_CAP = 400;

function emptyBundle(): TaskBundle {
  return { detail: null, notes: [], messages: [], timeline: [], artifacts: [], resolvedEscalations: [], output: [], loadedAt: null, loading: false, error: null };
}

/**
 * World state. Hydrated by a snapshot, then patched by fat events (each carries
 * the changed entity's projection), exactly like the web/native stores. Pure
 * domain data — no focus/scroll/UI state lives here.
 */
export class Store {
  private tasks = new Map<string, TaskItem>();
  private escalations = new Map<string, Escalation>();
  private bundles = new Map<string, TaskBundle>();
  private agents: AgentInstance[] = [];
  private activity: ActivityRow[] = [];
  private metrics: Metrics = { ...EMPTY_METRICS };
  private status: ConnStatus = "connecting";
  private hydrated = false;
  private _version = 0;
  titleGeneratorConfigured = false;
  /** Permanent auth failure message (remote), shown in the header. */
  authError: string | null = null;
  protocolVersion = 0;
  features: string[] = [];

  /** Monotonic change counter; bumps on every applied event. */
  get version(): number {
    return this._version;
  }

  get isHydrated(): boolean {
    return this.hydrated;
  }

  apply(event: TransportEvent): boolean {
    const changed = this.fold(event);
    if (changed) this._version++;
    return changed;
  }

  private fold(event: TransportEvent): boolean {
    switch (event.kind) {
      case "status":
        if (this.status === event.status) return false;
        this.status = event.status;
        return true;
      case "auth_failed":
        this.authError = event.message;
        this.status = "closed";
        return true;
      case "capabilities":
        this.protocolVersion = event.protocolVersion;
        this.features = event.features;
        return true;
      case "snapshot": {
        this.tasks = new Map(event.tasks.map((t) => [t.id, t]));
        this.escalations = new Map(event.escalations.filter((e) => e.status === "open").map((e) => [e.id, e]));
        this.titleGeneratorConfigured = event.titleGeneratorConfigured;
        this.hydrated = true;
        // Bundles survive a resync (they re-validate by loadedAt on reselect).
        return true;
      }
      case "task": {
        this.tasks.set(event.task.id, event.task);
        const b = this.bundles.get(event.task.id);
        if (b?.detail) b.detail = { ...b.detail, ...event.task };
        return true;
      }
      case "task_deleted":
        this.bundles.delete(event.taskId);
        return this.tasks.delete(event.taskId);
      case "task_phase": {
        const t = this.tasks.get(event.taskId);
        if (!t) return false;
        this.tasks.set(event.taskId, { ...t, current_phase: event.newPhase });
        return true;
      }
      case "escalation":
        if (event.escalation.status === "open") this.escalations.set(event.escalation.id, event.escalation);
        else this.escalations.delete(event.escalation.id);
        return true;
      case "escalation_resolved": {
        this.escalations.delete(event.escalationId);
        if (event.escalation) {
          const b = this.bundle(event.taskId || event.escalation.taskId);
          if (!b.resolvedEscalations.some((e) => e.id === event.escalation!.id)) b.resolvedEscalations.push(event.escalation);
        }
        return true;
      }
      case "note": {
        const b = this.bundle(event.note.taskId);
        if (b.notes.some((n) => n.id === event.note.id)) return false;
        b.notes.push(event.note);
        return true;
      }
      case "message": {
        const b = this.bundle(event.message.taskId);
        if (b.messages.some((m) => m.id === event.message.id)) return false;
        b.messages.push(event.message);
        return true;
      }
      case "timeline": {
        const b = this.bundle(event.entry.taskId);
        const i = b.timeline.findIndex((e) => e.id === event.entry.id);
        if (i >= 0) b.timeline[i] = event.entry;
        else b.timeline.push(event.entry);
        return true;
      }
      case "artifact": {
        const b = this.bundle(event.artifact.taskId);
        const i = b.artifacts.findIndex((a) => a.id === event.artifact.id);
        if (i >= 0) b.artifacts[i] = event.artifact;
        else b.artifacts.push(event.artifact);
        return true;
      }
      case "output": {
        const b = this.bundle(event.taskId);
        if (event.backfill) b.output = event.rows.slice(-OUTPUT_CAP);
        else {
          b.output.push(...event.rows);
          if (b.output.length > OUTPUT_CAP) b.output.splice(0, b.output.length - OUTPUT_CAP);
        }
        return event.rows.length > 0 || event.backfill;
      }
      case "agents":
        this.agents = event.agents;
        return true;
      case "instance": {
        const live = event.instance.status === "running" || event.instance.status === "waiting_delegation";
        const rest = this.agents.filter((a) => a.id !== event.instance.id);
        this.agents = live ? [event.instance, ...rest] : rest;
        return true;
      }
      case "activity":
        this.activity = event.activity;
        return true;
      case "metrics":
        this.metrics = event.metrics;
        return true;
    }
  }

  // ── per-task bundle lifecycle (driven by the controller's loads) ────────

  bundle(taskId: string): TaskBundle {
    let b = this.bundles.get(taskId);
    if (!b) {
      b = emptyBundle();
      this.bundles.set(taskId, b);
    }
    return b;
  }

  peekBundle(taskId: string): TaskBundle | null {
    return this.bundles.get(taskId) ?? null;
  }

  setBundleLoading(taskId: string, loading: boolean): void {
    this.bundle(taskId).loading = loading;
    this._version++;
  }

  hydrateBundle(
    taskId: string,
    data: { detail: TaskDetail | null; notes: Note[]; messages: Message[]; timeline: TimelineEntry[]; artifacts: Artifact[]; resolvedEscalations?: Escalation[] },
  ): void {
    const b = this.bundle(taskId);
    b.detail = data.detail;
    b.notes = data.notes;
    b.messages = data.messages;
    b.timeline = data.timeline;
    b.artifacts = data.artifacts;
    if (data.resolvedEscalations) b.resolvedEscalations = data.resolvedEscalations;
    b.loadedAt = Date.now();
    b.loading = false;
    b.error = null;
    if (data.detail) this.tasks.set(taskId, stripDetail(data.detail));
    this._version++;
  }

  failBundle(taskId: string, error: string): void {
    const b = this.bundle(taskId);
    b.loading = false;
    b.error = error;
    this._version++;
  }

  clearOutput(taskId: string): void {
    const b = this.bundles.get(taskId);
    if (b) b.output = [];
  }

  // ── reads ───────────────────────────────────────────────────────────────

  task(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  allTasks(): TaskItem[] {
    return [...this.tasks.values()];
  }

  openEscalations(): Escalation[] {
    return [...this.escalations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  escalationsFor(taskId: string): Escalation[] {
    return this.openEscalations().filter((e) => e.taskId === taskId);
  }

  agentInstances(): AgentInstance[] {
    return this.agents;
  }

  agentsFor(taskId: string): AgentInstance[] {
    return this.agents.filter((a) => a.task_id === taskId);
  }

  recentActivity(): ActivityRow[] {
    return this.activity;
  }

  /** Global activity narrowed to one task via the live agent roster. */
  activityFor(taskId: string): ActivityRow[] {
    const ids = new Set(this.agents.filter((a) => a.task_id === taskId).map((a) => a.id));
    return this.activity.filter((r) => (r.task_id ? r.task_id === taskId : ids.has(r.agent_id)));
  }

  metricsNow(): Metrics {
    return this.metrics;
  }

  connStatus(): ConnStatus {
    return this.status;
  }

  /** Derived header counts from the task set (works before the dashboard socket reports). */
  counts(): Record<string, number> {
    const c: Record<string, number> = {};
    for (const t of this.tasks.values()) c[t.display_status] = (c[t.display_status] ?? 0) + 1;
    c.escalations = this.escalations.size;
    c.agents = this.agents.length;
    return c;
  }
}

function stripDetail(d: TaskDetail): TaskItem {
  const {
    description: _d,
    result: _r,
    working_directory: _w,
    run_input: _ri,
    completed_at: _c,
    settled_at: _s,
    regression_count: _rc,
    phases: _p,
    agent_tiles: _t,
    ...item
  } = d;
  return item;
}
