/**
 * Bumped when the connect protocol gains capabilities. Advertised to the
 * integrator via the `connect:capabilities` event and in state snapshots.
 * v2: fat events (embedded entity projections), state/snapshot resource.
 * v3: unified task model on the wire, plus the `timeline` resource carrying
 * operator input entries. `status` is the raw stored status
 * (draft | active | settled) and `display_status` carries the presentation
 * state; task_type, iteration_count and unified_status are gone, as are the
 * legacy verbs (iterate/retry/resume/reopen/complete) and the legacy team
 * modes (regular/realtime).
 */
export const CONNECT_PROTOCOL_VERSION = 3;

/**
 * Task projection embedded in fat events and snapshots. Keeps the snake_case
 * keys the integrator web app already reads from REST task rows, and never
 * includes heavy fields (result, orchestration_state, description, task_config).
 */
export interface TaskListItem {
  id: string;
  title: string;
  /** Stored unified status: draft | active | settled. */
  status: string;
  /** Derived presentation status: draft/queued/working/idle/paused/review/blocked/completed/failed. */
  display_status: string;
  /** Task mode: workflow | conversational. */
  mode: string;
  /** Paused flag on active tasks ('paused' is no longer a stored status). */
  paused: boolean;
  team_id: string | null;
  team_name: string | null;
  current_phase: number;
  phase_count: number | null;
  needs_review: boolean;
  created_at: string;
  updated_at: string | null;
  /** When the task most recently entered `running` (null until it first runs).
   * Clients anchor a running task's elapsed time to this, not updated_at, which
   * ticks on every progress write. */
  started_at: string | null;
  /** Set when this task is a run of a recurring task; null for standalone tasks.
   * Lets clients present recurring runs separately (like the main UI, which
   * keeps non-active recurring runs out of the Active/Teams lists). */
  source_scheduled_task_id: string | null;
}

/**
 * Task detail projection returned by `tasks/read`. The list shape plus the
 * fields a task screen needs. Heavy internals (orchestration_state,
 * task_config) are still never shipped.
 */
export interface TaskDetailItem extends TaskListItem {
  description: string | null;
  /** Final result JSON of a settled run (carries `.error` on a failed run). */
  result: unknown | null;
  working_directory: string | null;
  /** Per-run input stamped on a recurring/webhook run; null otherwise. */
  run_input: string | null;
  completed_at: string | null;
  settled_at: string | null;
  regression_count: number;
  /** The assigned team's phase list, when the task has a team. */
  phases: { name: string; prompt: string; review?: boolean }[] | null;
}

/** One run of a recurring task, for the recurring series' run strip. */
export interface RecurringRunItem {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

/** A recurring task (series) plus its most recent runs. `recurring/list`. */
export interface RecurringSeriesItem {
  id: string;
  title: string;
  description: string | null;
  teamId: string | null;
  teamName: string | null;
  scheduleUnit: string | null;
  scheduleAmount: number | null;
  scheduleMatrix: string | null;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runs: RecurringRunItem[];
}

export interface EscalationItem {
  id: string;
  taskId: string;
  agentId: string;
  agentName: string | null;
  type: string;
  status: string;
  question: string;
  response: string | null;
  createdAt: string;
}

export interface NoteItem {
  id: string;
  taskId: string;
  agentName: string | null;
  content: string;
  createdAt: string;
}

/**
 * Operator message projection (agent → human progress update). Shares NoteItem's
 * shape but is a distinct register: messages are operator-only and never fed back
 * into any agent prompt. Carried by the `task:message_posted` fat event and the
 * `messages/list` resource.
 */
export interface MessageItem {
  id: string;
  taskId: string;
  agentName: string | null;
  content: string;
  /** Body format: 'text' | 'markdown' | 'html'. Null on legacy rows (= text). */
  format: string | null;
  createdAt: string;
}

/**
 * One operator-input entry from `realtime_timeline`: typed composer text, a
 * transcribed audio digest, or an input-pipeline error. This is the operator's
 * own side of a task's conversation, so remote clients need it to render a task
 * timeline that is not agent-only. Carried by the `timeline/list` resource and
 * by the `realtime:timeline_updated` fat event.
 */
export interface TimelineEntryItem {
  id: string;
  taskId: string;
  /**
   * 'text' = typed operator input, 'summary' = audio transcript digest,
   * 'error' = pipeline error, 'image' / 'file' = a file artifact, either an
   * operator upload or one an agent attached (see `artifact.source` /
   * `artifact.authorName`; `content` is then the caption, else the filename).
   */
  entryType: string;
  content: string;
  /** False while the entry is still queued and has not reached the agent. */
  fedToSkipper: boolean;
  createdAt: string;
  /** File artifact behind an 'image' / 'file' entry. Metadata only; bytes via `artifacts/read-bytes`. */
  artifact?: TimelineArtifactRef;
}

/** Metadata-only reference to the file artifact behind an upload timeline entry. */
export interface TimelineArtifactRef {
  id: string;
  name: string;
  version: number;
  kind: string;
  storage: string;
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  /** 'operator' / 'connect:<clientId>' for an operator upload, else the id of the agent that attached the file. */
  source: string;
  /** Display name of the attaching agent; null for operator sources (clients label the card "You"). */
  authorName: string | null;
}

/** Artifact projection without the body. */
export interface ArtifactItem {
  id: string;
  taskId: string;
  name: string;
  kind: string;
  version: number;
  description: string | null;
  /** Body format: 'html' | 'markdown' | 'text'. Null on legacy rows (heuristic). */
  format: string | null;
  createdAt: string;
  publishedAt: string | null;
  publicUrl: string | null;
  /** 'inline' (text body via artifacts/read) or 'file' (bytes via artifacts/read-bytes, never a body). */
  storage: string;
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  /** File artifacts: 'operator' / 'connect:<clientId>' or the attaching agent's id. Null for inline artifacts. */
  source: string | null;
}

/**
 * Push/feature flags this daemon supports. Sent as the `connect:capabilities`
 * event when the daemon attaches to the integrator AND carried in every
 * `state/snapshot`, because a consumer that connects later never sees the
 * one-shot event.
 */
export const CONNECT_FEATURES = ["snapshot", "fat_events", "output_tail", "messages", "timeline", "artifact_files"] as const;

export interface StateSnapshot {
  protocolVersion: number;
  /** Same list as `connect:capabilities.features`. */
  features: string[];
  ts: string;
  tasks: TaskListItem[];
  escalations: EscalationItem[];
  reviews: TaskListItem[];
  counts: { openEscalations: number; pendingReviews: number };
  /** True when a task-title generator agent is configured, so a remote client
   *  may create a task with a blank title (the daemon fills it in async). */
  titleGeneratorConfigured: boolean;
}

/** One coalesced agent-output line inside an output_batch frame. */
export interface OutputBatchEntry {
  /**
   * terminal_outputs.id — present on backfill entries only. It is the cursor
   * for `outputs/list` `beforeId`, so a client can page older history below
   * the backfill window. Live entries carry no id (the row is written before
   * the event fires, but the tail never reads it back).
   */
  id?: number;
  agentId: string;
  agentName: string | null;
  stream: "stdout" | "stderr";
  data: string;
  ts: string;
}

export type ClientMessage =
  | { type: "result"; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: "response"; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: "event"; event: string; payload: unknown; ts: string; source: "skipper" }
  // Coalesced live output for one task; only sent while the server reports
  // at least one subscribed consumer (see output-tail.ts). seq is
  // per-connection and informational (gap hint), not for reassembly.
  // `backfill: true` marks the one-shot history frame sent immediately on
  // subscribe (recent terminal output up to the subscribe point); live frames
  // that follow omit it. Lets the integrator seed a task's timeline from a
  // single subscribe with no separate read and no read-then-subscribe gap.
  | { type: "output_batch"; taskId: string; seq: number; entries: OutputBatchEntry[]; backfill?: boolean }
  | { type: "pong" };

export type ServerMessage =
  | { type: "auth_ok" }
  | { type: "auth_error"; message: string }
  | { type: "command"; id: string; tool: ConnectTool; args: Record<string, unknown> }
  | { type: "request"; id: string; resource: string; action: string; params: Record<string, unknown> }
  // Integrator-side consumer demand for a task's live output tail. Sent on
  // 0→1 / 1→0 subscriber transitions; older servers never send these.
  | { type: "output_subscribe"; taskId: string }
  | { type: "output_unsubscribe"; taskId: string }
  | { type: "ping" };

export const CONNECT_TOOLS = [
  "create-task",
  "delete-task",
  "list-draft-tasks",
  "approve-task",
  "run-recurring-task",
] as const;

export type ConnectTool = (typeof CONNECT_TOOLS)[number];
