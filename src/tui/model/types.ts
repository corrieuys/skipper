/**
 * Domain shapes the TUI renders. They mirror the daemon's Connect protocol v3
 * projections (src/connect/protocol.ts) and the dashboard WS JSON frames
 * (src/ws/ui-push.ts) but are declared here so the TUI never imports server
 * types. The transport maps wire frames onto these; the store folds them.
 */

export interface TaskItem {
  id: string;
  title: string;
  /** Stored unified status: draft | active | settled. */
  status: string;
  /** Derived presentation status: draft/queued/working/idle/paused/review/blocked/completed/failed. */
  display_status: string;
  /** workflow (autopilot on) | conversational (operator-driven). */
  mode: string;
  paused: boolean;
  memory_enabled: boolean;
  memory_mode: string;
  team_id: string | null;
  team_name: string | null;
  current_phase: number;
  phase_count: number | null;
  needs_review: boolean;
  starred: boolean;
  icon: string | null;
  icon_color: string | null;
  created_at: string;
  updated_at: string | null;
  started_at: string | null;
  source_scheduled_task_id: string | null;
}

export interface TaskDetail extends TaskItem {
  description: string | null;
  result: unknown | null;
  working_directory: string | null;
  run_input: string | null;
  completed_at: string | null;
  settled_at: string | null;
  regression_count: number;
  phases: { name: string; prompt: string; review?: boolean }[] | null;
  agent_tiles: AgentTile[];
}

export interface AgentTile {
  template_agent_id: string;
  agent_name: string;
  color: string | null;
  character: string | null;
  instance_count: number;
  is_active: boolean;
}

/** A live agent process (from the dashboard roster). */
export interface AgentInstance {
  id: string;
  template_agent_name: string;
  task_id: string | null;
  task_title: string | null;
  status: string; // running | waiting_delegation
  updated_at: string | null;
}

/** One parsed line of agent output (global feed or per-task tail). */
export interface ActivityRow {
  agent_id: string;
  agent_name: string;
  task_id?: string | null;
  kind: "message" | "tool" | "event" | "note";
  text: string;
  stream: string;
  created_at: string | null;
}

export interface Escalation {
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

export interface Note {
  id: string;
  taskId: string;
  agentName: string | null;
  source?: string | null;
  content: string;
  createdAt: string | null;
  deletedAt?: string | null;
}

export interface Message {
  id: string;
  taskId: string;
  agentName: string | null;
  content: string;
  format: string | null;
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  taskId: string;
  entryType: string; // text | summary | transcript | error | image | file
  content: string;
  fedToSkipper: boolean;
  createdAt: string;
  artifactName?: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  name: string;
  kind: string;
  version: number;
  description: string | null;
  format: string | null;
  createdAt: string;
  publishedAt: string | null;
  publicUrl: string | null;
  storage: string;
  mime: string | null;
  bytes: number | null;
}

export interface TeamAgent {
  id: string;
  name: string;
  type: string;
  model: string;
  instruction: string;
  role: string | null;
}

export interface Team {
  id: string;
  name: string;
  mode: string;
  phaseCount: number;
  agentCount: number;
  phases: { name: string; prompt: string; review: boolean }[];
  agents: TeamAgent[];
  slackEnabled: boolean;
  slashCommand: string;
  /** Extra context for the root Skipper on this team (web: the team map's Skipper card). */
  skipperPrompt: string;
  /** Set when a remote team repo owns the team: read-only (no edit; delete only once removed upstream). */
  remote: { repoId: string; path: string; removedUpstream: boolean } | null;
}

/** A linked GitHub repo of team configs (`remote-team-repos/list`, experimental). */
export interface RemoteTeamRepo {
  id: string;
  url: string;
  ref: string | null;
  name: string | null;
  status: string;
  lastCommit: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  teamErrors: { path: string; error: string }[];
  teamIds: string[];
}

export interface RecurringRun {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export interface RecurringSeries {
  id: string;
  title: string;
  description: string | null;
  teamId: string | null;
  teamName: string | null;
  scheduleUnit: string | null;
  scheduleAmount: number | null;
  /**
   * Weekly hour grid as the daemon sends it (JSON: 7 days x 24 hours of 0/1,
   * Monday first); null for an interval or manual series. The TUI cannot edit
   * the grid: an edit that keeps "weekly" sends this value back unchanged.
   */
  scheduleMatrix: string | null;
  status: string;
  starred: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  memoryMode: string;
  runs: RecurringRun[];
}

/**
 * A staged team-config improvement (experimental `improvements` feature), as
 * the Connect summary projection carries it: list rows and every fat event.
 * No texts; `read` brings the detail. Mirrors src/connect/improvements.ts.
 */
export interface ImprovementSummary {
  id: string;
  /** phase_prompt | agent_instruction | lead_instructions | recurring_description | skill_suggestion */
  kind: string;
  /** pending | approved | rejected */
  status: string;
  /** ready | conflict | missing | suggestion | decided (derived now on the daemon) */
  state: string;
  targetKey: string;
  targetLabel: string;
  teamId: string | null;
  teamName: string | null;
  scheduledTaskId: string | null;
  phaseIndex: number | null;
  phaseName: string | null;
  agentRef: string | null;
  skillName: string | null;
  /** Cut to 280 characters; the detail carries the full reason. */
  reason: string;
  sourceTaskId: string | null;
  sourceTaskTitle: string | null;
  /** Library agent targets only: how many teams use the agent. */
  usedByTeams: number | null;
  baseRevision: string | null;
  liveRevision: string | null;
  editedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementDiffLine {
  op: "same" | "add" | "del";
  text: string;
}

/** `improvements/read`: the summary plus the texts and a line diff. */
export interface ImprovementDetail extends ImprovementSummary {
  proposedText: string;
  beforeText: string;
  /** The live text now (null when decided, missing or a skill suggestion). */
  liveText: string | null;
  diff: ImprovementDiffLine[] | null;
  /** live: live → proposed · before: before → proposed (decided) · null: no diff. */
  diffBase: "live" | "before" | null;
}

export interface Metrics {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  activeAgentCount: number;
}

export const EMPTY_METRICS: Metrics = { running: 0, queued: 0, completed: 0, failed: 0, activeAgentCount: 0 };

export type ConnStatus = "connecting" | "connected" | "reconnecting" | "closed";

/**
 * Normalized events every transport emits. State arrives as a full snapshot
 * on (re)connect and is then patched by fat events carrying the changed
 * entity's projection — the same contract the web and native apps use.
 */
export type TransportEvent =
  | { kind: "status"; status: ConnStatus }
  | { kind: "capabilities"; protocolVersion: number; features: string[] }
  | { kind: "auth_failed"; message: string }
  | { kind: "snapshot"; tasks: TaskItem[]; escalations: Escalation[]; titleGeneratorConfigured: boolean; pendingImprovements?: number }
  /**
   * A recurring series or team changed on the daemon. `row` is the wire projection (absent when deleted); the controller maps it into its cached list.
   * `improvements` (experimental): the pending improvements in that scope, state recomputed (a manual edit flips them to conflict).
   */
  | { kind: "recurring_changed"; id: string; deleted: boolean; row: Record<string, unknown> | null; improvements?: ImprovementSummary[] }
  | { kind: "team_changed"; id: string; deleted: boolean; row: Record<string, unknown> | null; improvements?: ImprovementSummary[] }
  /** Improvement summaries to upsert by id (`improvement:changed` row + siblings, `library_agent:changed`). */
  | { kind: "improvements"; improvements: ImprovementSummary[] }
  /** The improvements auto-approve gate. */
  | { kind: "improvement_settings"; autoApprove: boolean }
  /** A remote team repo was linked, moved sync status, or was unlinked. An open repos browser reloads. */
  | { kind: "remote_repo_changed"; id: string; deleted: boolean }
  /** `edited`: a same-status change (edit, rename, star, toggle): fields outside the list row may have moved. */
  | { kind: "task"; task: TaskItem; created?: boolean; started?: boolean; edited?: boolean }
  | { kind: "task_deleted"; taskId: string }
  | { kind: "task_phase"; taskId: string; newPhase: number }
  | { kind: "escalation"; escalation: Escalation }
  | { kind: "escalation_resolved"; escalationId: string; taskId: string; escalation?: Escalation }
  | { kind: "note"; note: Note }
  | { kind: "message"; message: Message }
  | { kind: "timeline"; entry: TimelineEntry }
  | { kind: "artifact"; artifact: Artifact }
  | { kind: "output"; taskId: string; rows: ActivityRow[]; backfill: boolean }
  /** One agent instance changed state (remote roster; the local roster comes from `agents`). */
  | { kind: "instance"; instance: AgentInstance }
  // dashboard socket lanes
  | { kind: "agents"; agents: AgentInstance[] }
  | { kind: "activity"; activity: ActivityRow[] }
  | { kind: "metrics"; metrics: Metrics };
