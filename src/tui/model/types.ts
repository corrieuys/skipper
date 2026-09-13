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
  status: string;
  starred: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  memoryMode: string;
  runs: RecurringRun[];
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
  | { kind: "snapshot"; tasks: TaskItem[]; escalations: Escalation[]; titleGeneratorConfigured: boolean }
  | { kind: "task"; task: TaskItem; created?: boolean; started?: boolean }
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
