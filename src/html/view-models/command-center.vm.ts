import type { Database } from "bun:sqlite";
import { isTeamVisible } from "../../config/feature-flags";
import {
  getBoolSetting,
  SETTING_SKIPPER_CONNECT_ENABLED, getStringSetting, SETTING_SKIPPER_CONNECT_KEY,
} from "../../config/app-settings";
import { getOpenEscalationCount, isDaemonPaused } from "../../data/queries";
import {
  fetchCommandCenterTasks,
  fetchActiveInstanceRows,
  fetchDelegationsByChildInstance,
  fetchRunningDelegationGroupCounts,
  fetchTeamPhasesById,
  fetchStandardTaskTeams,
  fetchOpenEscalationCountsByTask,
  hasDaemonOwner,
  fetchTokenTotalsByTask,
  fetchScheduledTaskRows,
  fetchRealtimeSessionActive,
  fetchRecentScheduledRuns,
  type CommandCenterTaskRow,
  type DelegationPillInfo,
  type ScheduledRunRow,
} from "../../data/command-center";
import type { ActiveMissionData } from "../panels/active-mission.panel";
import type { MetricsData } from "../panels/metrics-bar.panel";
import type { QueuedTask } from "../panels/task-queue.panel";
import type { AgentTreeNode } from "../fragments/tree-node.fragment";
import type { PhaseStepData } from "../fragments/phase-step.fragment";

export interface TaskSummary {
  id: string;
  title: string;
  description: string | null;
  status: string;
  task_type: string;
  team_id: string | null;
  team_name: string | null;
  working_directory: string;
  created_at: string;
  completed_at: string | null;
  result_summary: string | null;
  needs_review: number;
  source_scheduled_task_id: string | null;
  /** True when the task has an open escalation or a pending phase review — drives the sidebar attention dot. */
  has_attention: boolean;
  /** Number of open escalations on the task — drives the task-header escalation label. */
  open_escalation_count: number;
  tokens: {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  };
}

export interface ScheduledTaskSummary {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  team_name: string | null;
  schedule_unit: string | null;
  schedule_amount: number | null;
  /** Weekly matrix as its raw JSON string (7x24 of 0/1); null = interval/manual mode. */
  schedule_matrix?: string | null;
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  /** Webhook trigger secret (null = disabled). Only populated on the detail view. */
  webhook_key?: string | null;
  /** Full public trigger URL; null when connect is unconfigured. */
  webhook_url?: string | null;
  /** Webhook debounce window in minutes (floor 1). Detail view only. */
  webhook_debounce_minutes?: number | null;
  /** Global-store usage contract injected into every run's prompt. Detail view only. */
  global_store_instructions?: string | null;
  /** Parsed per-task config (e.g. the Slack slash-command binding). Detail view only. */
  task_config?: Record<string, unknown>;
}

export interface CommandCenterViewModel {
  isIdle: boolean;
  mission: ActiveMissionData | null;
  missionsByTask: Record<string, ActiveMissionData>;
  metrics: MetricsData;
  agentTree: AgentTreeNode[];
  delegationSummary: string;
  queue: QueuedTask[];
  allTasks: TaskSummary[];
  scheduledTasks: ScheduledTaskSummary[];
  /** Last 5 runs per recurring task, newest first — the v2 sidebar run strip. */
  scheduledRuns: Record<string, ScheduledRunRow[]>;
  recentTasks: Array<{ id: string; title: string; status: string; completed_at: string | null }>;
  teams: Array<{ id: string; name: string }>;
  escalationCount: number;
  daemonState: string;
  daemonUptime: number;
  skipperConnectEnabled: boolean;
  realtimeSessionActive: Record<string, boolean>;
}

function buildMissionForTask(
  t: CommandCenterTaskRow,
  teamsById: Record<string, { name: string; phases: string }>,
): ActiveMissionData | null {
  const team = t.team_id ? teamsById[t.team_id] ?? null : null;

  let phases: PhaseStepData[] = [];
  if (team?.phases) {
    try {
      const parsed = JSON.parse(team.phases) as Array<{ name: string; review?: boolean }>;
      const isCompleted = t.status === "completed";
      const isFailed = t.status === "failed";
      phases = parsed.map((p, i) => ({
        name: p.name,
        index: i,
        status: isCompleted ? "completed" as const
          : isFailed ? (i <= t.current_phase ? (i === t.current_phase ? "failed" as const : "completed" as const) : "pending" as const)
          : i < t.current_phase ? "completed" as const
          : i === t.current_phase ? (t.needs_review ? "review" as const : "current" as const)
          : "pending" as const,
      }));
    } catch { /* ignore parse errors */ }
  }

  if (phases.length === 0) return null;

  return {
    taskId: t.id,
    title: t.title,
    status: t.status,
    teamName: team?.name ?? null,
    currentPhase: t.current_phase,
    phases,
    needsReview: t.needs_review === 1,
  };
}

export function buildCommandCenterViewModel(
  db: Database,
  opts?: { includeTaskId?: string },
): CommandCenterViewModel {
  const allTasks = fetchCommandCenterTasks(db, opts?.includeTaskId);

  const runningTasks = allTasks.filter((t) => t.status === "running");
  const runningTask = runningTasks[0] ?? null;
  const queuedTasks = allTasks.filter((t) => t.status === "approved");
  const recentTasks = allTasks.filter((t) => t.status === "completed" || t.status === "failed").slice(0, 5);

  // Metrics
  const running = allTasks.filter((t) => t.status === "running").length;
  const queued = queuedTasks.length;
  const completed = allTasks.filter((t) => t.status === "completed").length;
  const failed = allTasks.filter((t) => t.status === "failed").length;

  const runningInstances = fetchActiveInstanceRows(db);

  // Delegation-by-child map: unifies the agent tree with delegations so each
  // delegated instance shows a clickable pill (prompt preview + status) that
  // opens the full prompt in a modal. Keyed by the delegation's child_instance_id.
  const delegationsByChild = fetchDelegationsByChildInstance(db, runningInstances.map((i) => i.id));

  // Build agent tree
  const agentTree = buildAgentTree(runningInstances, delegationsByChild);

  // Delegation summary
  const groups = fetchRunningDelegationGroupCounts(db);
  const delegationSummary = groups.length > 0
    ? `${groups.length} group${groups.length > 1 ? "s" : ""}, ${groups.reduce((a, g) => a + g.settled_count, 0)}/${groups.reduce((a, g) => a + g.expected_count, 0)} settled`
    : "";

  // Mission data — one teams read serves every task (was a per-task lookup).
  const teamsById = fetchTeamPhasesById(db);
  const mission = runningTask ? buildMissionForTask(runningTask, teamsById) : null;

  // Build missions map for all tasks that have teams with phases
  const missionsByTask: Record<string, ActiveMissionData> = {};
  for (const t of allTasks) {
    const m = buildMissionForTask(t, teamsById);
    if (m) missionsByTask[t.id] = m;
  }

  // Teams for draft editing — exclude the Real Time team (it's only selectable
  // through the real-time task flow, not for standard task edits).
  const teams = fetchStandardTaskTeams(db).filter((t) => isTeamVisible(t.id));

  // Escalation count + per-task open-escalation set (drives the sidebar
  // attention dot alongside pending phase reviews).
  const openEscalationCounts = fetchOpenEscalationCountsByTask(db);
  const escalationCount = getOpenEscalationCount(db);

  // Daemon
  const daemonState = isDaemonPaused(db) ? "paused" : hasDaemonOwner(db) ? "running" : "stopped";

  const tokensByTask = fetchTokenTotalsByTask(db);

  // Build task summaries with result info
  const taskSummaries: TaskSummary[] = allTasks.map((t) => {
    let resultSummary: string | null = null;
    if (t.result) {
      try {
        const parsed = JSON.parse(t.result);
        resultSummary = typeof parsed === "string" ? parsed.slice(0, 200) : (parsed.summary ?? parsed.message ?? null);
      } catch {
        resultSummary = typeof t.result === "string" ? t.result.slice(0, 200) : null;
      }
    }
    return {
      id: t.id,
      title: t.title,
      description: t.description ?? null,
      status: t.status,
      task_type: t.task_type,
      team_id: t.team_id,
      team_name: t.team_name,
      working_directory: t.working_directory ?? "",
      created_at: t.created_at,
      completed_at: t.completed_at,
      result_summary: resultSummary,
      needs_review: t.needs_review ?? 0,
      source_scheduled_task_id: t.source_scheduled_task_id ?? null,
      has_attention: t.needs_review === 1 || (openEscalationCounts.get(t.id) ?? 0) > 0,
      open_escalation_count: openEscalationCounts.get(t.id) ?? 0,
      tokens: tokensByTask[t.id] ?? { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    };
  });

  const scheduledTasks: ScheduledTaskSummary[] = fetchScheduledTaskRows(db);
  const scheduledRuns = fetchRecentScheduledRuns(db);

  const realtimeSessionActive = fetchRealtimeSessionActive(
    db,
    allTasks.filter((t) => t.task_type === "real_time" && t.status === "running").map((t) => t.id),
  );

  return {
    isIdle: runningTasks.length === 0,
    mission,
    missionsByTask,
    metrics: { running, queued, activeAgents: runningInstances.length, completed, failed },
    agentTree,
    delegationSummary,
    allTasks: taskSummaries,
    scheduledTasks,
    scheduledRuns,
    queue: queuedTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, created_at: t.created_at })),
    recentTasks: recentTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, completed_at: t.completed_at })),
    teams,
    escalationCount,
    daemonState,
    daemonUptime: process.uptime(),
    skipperConnectEnabled: !!getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "") && getBoolSetting(db, SETTING_SKIPPER_CONNECT_ENABLED, false),
    realtimeSessionActive,
  };
}

/** Build a flat list of tree nodes with depth and connector info from agent instances */
export function buildAgentTree(
  instances: Array<{
    id: string; agent_name: string; parent_instance_id: string | null;
    status: string; process_pid: number | null; task_id: string;
    exit_reason?: string | null;
    input_tokens?: number; output_tokens?: number;
    cache_creation_tokens?: number; cache_read_tokens?: number;
  }>,
  delegationsByChild?: Record<string, DelegationPillInfo>,
): AgentTreeNode[] {
  const idSet = new Set(instances.map(i => i.id));
  const childMap = new Map<string | null, typeof instances>();
  for (const inst of instances) {
    // If parent isn't in the current set (already exited), treat as root
    const parentId = inst.parent_instance_id && idSet.has(inst.parent_instance_id)
      ? inst.parent_instance_id
      : null;
    const list = childMap.get(parentId) ?? [];
    list.push(inst);
    childMap.set(parentId, list);
  }

  const result: AgentTreeNode[] = [];

  function walk(parentId: string | null, depth: number): void {
    const children = childMap.get(parentId) ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const delegation = delegationsByChild?.[child.id];
      result.push({
        instanceId: child.id,
        agentName: child.agent_name,
        status: child.status,
        pid: child.process_pid,
        depth,
        connector: depth === 0 ? "" : isLast ? "└──" : "├──",
        taskId: child.task_id,
        exitReason: child.exit_reason ?? null,
        tokens: {
          input: child.input_tokens ?? 0,
          output: child.output_tokens ?? 0,
          cache_creation: child.cache_creation_tokens ?? 0,
          cache_read: child.cache_read_tokens ?? 0,
        },
        delegation: delegation ?? null,
      });
      walk(child.id, depth + 1);
    }
  }

  walk(null, 0);
  return result;
}
