/**
 * Domain shapes the TUI renders. These mirror the daemon's dashboard JSON wire
 * shapes (see src/ws/ui-push.ts `broadcastJson` payloads + the WS-open
 * snapshot) but are declared here so the TUI never imports server/html types.
 * A future transport (Skipper Connect) maps its own projections onto these.
 */

export interface TaskRow {
  id: string;
  title: string;
  status: string; // running | approved | completed | failed | ...
  task_type?: string | null;
  created_at?: string | null;
}

export interface AgentRow {
  id: string;
  template_agent_name: string;
  task_id: string | null;
  task_title: string | null;
  status: string; // running | waiting_delegation | ...
  updated_at?: string | null;
}

export interface ActivityRow {
  agent_id: string;
  agent_name: string;
  kind: "message" | "tool" | "event" | "note";
  text: string;
  stream: string;
  created_at?: string | null;
}

/** The single focus task's phase progress (from dashboard:phase-indicator). */
export interface PhaseInfo {
  taskId: string;
  title: string;
  status: string;
  /** 0-based index of the current phase. */
  current: number;
  /** Total phase count (0 when the task has no defined phases). */
  total: number;
  needsReview: boolean;
  phaseName: string | null;
}

export interface Metrics {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  activeAgentCount: number;
}

/** Full state of the world at one instant. Hydration + reconnect resync. */
export interface Snapshot {
  tasks: TaskRow[];
  agents: AgentRow[];
  activity: ActivityRow[];
  phase: PhaseInfo | null;
  metrics: Metrics;
}

export type ConnStatus = "connecting" | "connected" | "reconnecting" | "closed";

/**
 * Normalized events every transport emits. Task/agent/message pushes carry the
 * FULL current set (replace-all), not deltas — the daemon owns the "active"
 * decision and the TUI mirrors it wholesale, so churn needs no client-side
 * add/remove bookkeeping. See src/ws/ui-push.ts.
 */
export type TransportEvent =
  | { kind: "snapshot"; snapshot: Snapshot }
  | { kind: "tasks"; tasks: TaskRow[] }
  | { kind: "agents"; agents: AgentRow[] }
  | { kind: "activity"; activity: ActivityRow[] }
  | { kind: "phase"; phase: PhaseInfo | null }
  | { kind: "metrics"; metrics: Metrics }
  | { kind: "status"; status: ConnStatus };

export const EMPTY_METRICS: Metrics = {
  running: 0,
  queued: 0,
  completed: 0,
  failed: 0,
  activeAgentCount: 0,
};
