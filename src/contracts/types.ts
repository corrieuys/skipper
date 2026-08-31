// Wire-level DTO types shared by every output surface: the JSON data API
// (src/routes/data), server-rendered HTML (src/html), WS push (src/ws), MCP
// task tools and skipper connect. The data layer (src/data) returns these
// shapes; renderers and serializers consume them. Keep every field
// JSON-serializable (no Date, no Map, no class instances) — these types ARE
// the contract a remote/native client sees.
import type { RealtimeConfig } from "../realtime/config";

// --- Daemon ---

export interface DaemonStatus {
  state: "running" | "pausing" | "paused" | "stopped";
  uptime: number;
}

// --- Tasks ---

export interface TaskHealthSummary {
  liveRuntimeCount: number;
  activeDelegationCount: number;
  openEscalationCount: number;
  lastProgressAt: string | null;
  remediationEventCount: number;
}

export interface TaskData {
  id: string;
  title: string;
  description?: string;
  status: string;
  current_phase: number;
  team_id?: string;
  team_name?: string;
  created_at: string;
  result?: unknown;
  task_type?: string;
  task_config?: Record<string, unknown>;
  needs_review?: boolean | number;
  phases?: { name: string; prompt: string; review?: boolean }[];
  healthSummary?: TaskHealthSummary;
}

export interface TaskNoteData {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name?: string;
  content: string;
  source?: string;
  created_at: string;
  deleted_at?: string | null;
}

export interface DelegationData {
  id: string;
  parent_agent_id: string;
  child_agent_id: string;
  parent_agent_name?: string;
  child_agent_name?: string;
  task_id: string;
  prompt: string;
  result: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

// --- Agents ---

export interface AgentData {
  id: string;
  name: string;
  type: string;
  model: string;
  status: string;
  capabilities: string[];
  config: Record<string, unknown>;
  process_pid: number | null;
  current_task_id: string | null;
  running_instance_count?: number;
}

export interface AgentInstanceSummary {
  id: string;
  status: string;
  task_id: string;
  task_title: string | null;
  created_at: string;
  can_steer?: boolean;
  disabled_reason?: string | null;
  session_id?: string | null;
}

/** One orb in the dashboard team roster (mirrors zen mode's team orbs). */
export interface AgentTile {
  template_agent_id: string;
  agent_name: string;
  /** Has ≥1 running/waiting instance for the current context. */
  is_active: boolean;
  /** Number of active instances (drives the count badge). */
  instance_count: number;
  /** Chosen identity color (hex) — tints the orb + this agent's timeline output. */
  color?: string | null;
  /** Chosen creature character id — shown in the orb instead of the cube. */
  character?: string | null;
}

// --- Teams ---

export interface TeamData {
  id: string;
  name: string;
  entrypoint_agent_id: string | null;
  entrypoint_agent_name?: string;
  goal?: string;
  phases: { name: string; prompt: string; review?: boolean }[];
}

export interface TeamAgentData {
  agent_id: string;
  agent_name: string;
  role: string | null;
  level: number;
  capabilities: string[];
}

// --- Escalations ---

export interface EscalationData {
  id: string;
  agent_id: string;
  task_id: string;
  type: string;
  question: string;
  response: string | null;
  status: string;
  created_at: string;
  task_status?: string;
}

// --- Forensics ---

export interface ForensicsTimelineEntry {
  source: "checkpoint" | "escalation" | "remediation" | "delegation";
  created_at: string;
  // checkpoint fields
  checkpoint_type?: string;
  context_snapshot?: string;
  sequence?: number;
  // escalation fields
  escalation_type?: string;
  severity?: string;
  escalation_status?: string;
  question?: string;
  // remediation/event fields
  event_type?: string;
  event_payload?: string;
}

export interface ForensicsAgentInstance {
  id: string;
  task_id: string;
  template_agent_id: string;
  agent_name: string | null;
  parent_instance_id: string | null;
  root_instance_id: string | null;
  status: string;
  process_pid: number | null;
  session_id: string | null;
  exit_code: number | null;
  attempt: number;
  created_at: string;
  updated_at: string;
}

export interface ForensicsTerminalTail {
  instance_id: string;
  lines: { stream: string; data: string }[];
}

export interface ForensicsDelegation {
  id: string;
  parent_agent_name: string | null;
  child_agent_name: string | null;
  prompt: string;
  result: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export interface ForensicsDelegationGroup {
  id: string;
  task_id: string;
  parent_instance_id: string;
  policy: string;
  expected_count: number;
  settled_count: number;
  failed_count: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  delegations: ForensicsDelegation[];
}

export interface ForensicsEscalation {
  id: string;
  agent_id: string;
  agent_name: string | null;
  type: string;
  severity: string;
  question: string;
  response: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface ForensicsTokenUsage {
  instance_id: string;
  agent_name: string | null;
  status: string;
  // Aggregated from terminal_outputs result/turn.completed/step_finish events
  input_tokens: number | null;
  cache_read_input_tokens: number | null; // claude: cache_read, codex: cached_input
  cache_creation_input_tokens: number | null; // claude only
  output_tokens: number | null;
  num_turns: number | null; // claude: from result, codex: count of turn.completed
  duration_ms: number | null; // claude only
  // From agent_states (ephemeral, may be null for completed instances)
  context_compact_needed: boolean;
  nudge_count: number;
}

export interface ForensicsData {
  timeline: ForensicsTimelineEntry[];
  instances: ForensicsAgentInstance[];
  delegationGroups: ForensicsDelegationGroup[];
  escalations: ForensicsEscalation[];
  tokenUsage: ForensicsTokenUsage[];
  terminalTails: ForensicsTerminalTail[];
}

// --- Dashboard ---

export type PollIntervalSeconds = 3 | 8;

export interface RecentLogEntry {
  agent_id: string;
  agent_name: string;
  stream: string;
  data: string;
  created_at: string;
}

export interface DashboardData {
  tasks: {
    id: string;
    title: string;
    status: string;
    task_type?: string;
    description?: string | null;
    created_at?: string;
  }[];
  teams?: { id: string; name: string }[];
  phaseIndicatorTask?: {
    id: string;
    title: string;
    status: string;
    current_phase: number;
    needs_review?: boolean | number;
    task_type?: string;
    phases?: { name: string; prompt: string; review?: boolean }[] | null;
  } | null;
  pollIntervalSeconds?: PollIntervalSeconds;
  realtimeConfig?: RealtimeConfig;
  realtimeTimeline?: {
    taskId: string;
    taskTitle: string;
    entries: {
      id: string;
      entry_type: string;
      content: string;
      priority?: string;
      created_at: string;
    }[];
  } | null;
  agents: {
    id: string;
    name: string;
    status: string;
    current_task_id: string | null;
  }[];
  daemon: DaemonStatus;
  runningInstances?: {
    id: string;
    template_agent_id: string;
    template_agent_name: string;
    task_id: string;
    task_title: string | null;
    status: string;
    parent_instance_id: string | null;
    root_instance_id: string | null;
    created_at: string;
    updated_at: string;
  }[];
  activeTeamAgents?: {
    id: string;
    name: string;
    template_agent_id: string;
    is_active: number;
  }[];
  activeTeamName?: string | null;
  activeDelegationGroups?: {
    id: string;
    task_id: string;
    parent_instance_id: string;
    settled_count: number;
    expected_count: number;
    failed_count: number;
    status: string;
    created_at: string;
    completed_at?: string | null;
  }[];
  recentLogs?: RecentLogEntry[];
  dashboardSteeringOptions?: {
    template_agent_id: string;
    agent_name: string;
    runtime_id: string;
    task_id: string;
    task_title: string | null;
    session_id: string | null;
    process_pid: number | null;
    can_steer: boolean;
    disabled_reason: string | null;
    latest_message?: string | null;
  }[];
  openEscalations?: {
    id: string;
    agent_id: string;
    task_id: string;
    question: string;
    created_at: string;
  }[];
}

// --- Realtime tasks ---

export interface RunningAgentInstance {
  id: string;
  template_agent_id: string;
  agent_name: string;
  status: string;
  created_at: string;
}

export interface TaskNote {
  id: string;
  agent_id: string;
  agent_name: string | null;
  content: string;
  created_at: string;
}

export interface TimelineEntry {
  id: string;
  task_id: string;
  entry_type: string;
  content: string;
  source_segment_ids: string;
  fed_to_skipper: number;
  priority?: string;
  created_at: string;
}

export interface PipelineStatus {
  task_id: string;
  analyst_instance_id: string | null;
  analyst_session_id: string | null;
  analyst_status: string;
  action_instance_id: string | null;
  action_status: string;
  last_summary_version: number;
  last_analyst_fed_version: number;
  queued_summary_versions: string;
  cadence_timer_active: number;
  recording_owner: string | null;
  recording_owner_label: string | null;
  recording_activity_at: string | null;
  updated_at: string;
  total_segments?: number;
  pending_transcription?: number;
  failed_transcription?: number;
  pending_summarization?: number;
  timeline_entry_count?: number;
}
