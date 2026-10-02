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
  ImprovementSummary,
  ImprovementDetail,
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
  /** Improvements (experimental): summaries by id, upserted from list loads and fat events. */
  private improvements = new Map<string, ImprovementSummary>();
  /** `improvements/read` results by id; stale once the summary's updatedAt / liveRevision / state moves. */
  private improvementDetails = new Map<string, ImprovementDetail>();
  private improvementErrors = new Map<string, string>();
  /** The snapshot's pending count, used until the first list load. */
  private pendingImprovementsHint = 0;
  /** True once an `improvements/list` has been folded in. */
  improvementsLoaded = false;
  /** The auto-approve gate; null until `improvements/settings` answers. */
  autoApprove: boolean | null = null;

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
      case "recurring_changed":
      case "team_changed":
        // The lists live in the controller's UI cache (run.ts), not the store;
        // the pending improvements in that scope ride along and are upserted.
        return event.improvements?.length ? this.upsertImprovements(event.improvements) : false;
      case "remote_repo_changed":
        return false;
      case "improvements":
        return this.upsertImprovements(event.improvements);
      case "improvement_settings":
        if (this.autoApprove === event.autoApprove) return false;
        this.autoApprove = event.autoApprove;
        return true;
      case "capabilities":
        this.protocolVersion = event.protocolVersion;
        this.features = event.features;
        return true;
      case "snapshot": {
        this.tasks = new Map(event.tasks.map((t) => [t.id, t]));
        this.escalations = new Map(event.escalations.filter((e) => e.status === "open").map((e) => [e.id, e]));
        this.titleGeneratorConfigured = event.titleGeneratorConfigured;
        this.pendingImprovementsHint = event.pendingImprovements ?? 0;
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

  // ── improvements (experimental) ─────────────────────────────────────────

  private upsertImprovements(rows: ImprovementSummary[]): boolean {
    for (const r of rows) if (r.id) this.improvements.set(r.id, r);
    return rows.length > 0;
  }

  /**
   * Fold an `improvements/list` result. `scope` is what was asked for: rows of
   * that scope the answer no longer holds (decided or gone while this client
   * was away) are dropped, unless the answer hit its limit.
   */
  loadImprovements(rows: ImprovementSummary[], scope: "pending" | "all", limit: number): void {
    if (rows.length < limit) {
      const keep = new Set(rows.map((r) => r.id));
      for (const [id, r] of this.improvements) {
        if (keep.has(id)) continue;
        if (scope === "all" || r.status === "pending") this.improvements.delete(id);
      }
    }
    this.upsertImprovements(rows);
    this.improvementsLoaded = true;
    this._version++;
  }

  /** The daemon advertises the experimental `improvements` feature. */
  get hasImprovements(): boolean {
    return this.features.includes("improvements");
  }

  improvement(id: string): ImprovementSummary | undefined {
    return this.improvements.get(id);
  }

  /** Every known improvement, newest first. */
  allImprovements(): ImprovementSummary[] {
    return [...this.improvements.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  pendingImprovementCount(): number {
    if (!this.hasImprovements) return 0;
    if (!this.improvementsLoaded) return this.pendingImprovementsHint;
    let n = 0;
    for (const r of this.improvements.values()) if (r.status === "pending") n++;
    return n;
  }

  improvementDetail(id: string): ImprovementDetail | undefined {
    return this.improvementDetails.get(id);
  }

  /** No detail yet, or the summary moved since it was read. */
  improvementDetailStale(id: string): boolean {
    const d = this.improvementDetails.get(id);
    const s = this.improvements.get(id);
    if (!d) return true;
    if (!s) return false;
    return d.updatedAt !== s.updatedAt || d.liveRevision !== s.liveRevision || d.state !== s.state;
  }

  setImprovementDetail(detail: ImprovementDetail): void {
    this.improvementDetails.set(detail.id, detail);
    this.improvementErrors.delete(detail.id);
    this._version++;
  }

  improvementError(id: string): string | null {
    return this.improvementErrors.get(id) ?? null;
  }

  setImprovementError(id: string, error: string): void {
    this.improvementErrors.set(id, error);
    this._version++;
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

  /** Replace just the detail of an already-loaded bundle (after an edit event). */
  setDetail(taskId: string, detail: TaskDetail): void {
    const b = this.bundles.get(taskId);
    if (!b) return;
    b.detail = detail;
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
