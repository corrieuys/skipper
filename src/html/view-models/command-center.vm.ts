import type { Database } from "bun:sqlite";
import { isTeamVisible, isExperimental } from "../../config/feature-flags";
import {
  getBoolSetting, SETTING_PARALLEL_TASKS,
  SETTING_SKIPPER_CONNECT_ENABLED, getStringSetting, SETTING_SKIPPER_CONNECT_KEY,
} from "../../config/app-settings";
import { getOpenEscalationCount } from "../../data/queries";
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
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface CommandCenterViewModel {
  isIdle: boolean;
  mission: ActiveMissionData | null;
  missionsByTask: Map<string, ActiveMissionData>;
  metrics: MetricsData;
  agentTree: AgentTreeNode[];
  delegationSummary: string;
  queue: QueuedTask[];
  allTasks: TaskSummary[];
  scheduledTasks: ScheduledTaskSummary[];
  recentTasks: Array<{ id: string; title: string; status: string; completed_at: string | null }>;
  recentConversations: Array<{ id: string; title: string; status: string; updated_at: string }>;
  teams: Array<{ id: string; name: string }>;
  escalationCount: number;
  daemonState: string;
  daemonUptime: number;
  parallelExecution: boolean;
  skipperConnectEnabled: boolean;
  realtimeSessionActive: Map<string, boolean>;
}

export function buildCommandCenterViewModel(
  db: Database,
  opts?: { includeTaskId?: string },
): CommandCenterViewModel {
  // Tasks with team names and result summaries
  // Show running/approved scheduled runs in the main list; hide completed/failed
  // ones. `includeTaskId` force-includes a specific task (e.g. a finished
  // scheduled run being opened directly) so its detail view can render.
  const allTasks = db.prepare(
    `SELECT t.id, t.title, t.description, t.status, t.current_phase, t.team_id, t.task_type, t.needs_review,
            t.working_directory, t.created_at, t.completed_at, t.result, t.task_config,
            t.source_scheduled_task_id,
            tm.name AS team_name
     FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id
     WHERE t.source_scheduled_task_id IS NULL
        OR t.status IN ('running', 'approved', 'paused')
        OR t.id = ?
     ORDER BY t.created_at DESC`
  ).all(opts?.includeTaskId ?? null) as Array<{
    id: string; title: string; description: string | null; status: string; current_phase: number; team_id: string | null;
    task_type: string; needs_review: number; working_directory: string; created_at: string; completed_at: string | null;
    result: string | null; task_config: string | null; team_name: string | null; source_scheduled_task_id: string | null;
  }>;

  const runningTasks = allTasks.filter((t) => t.status === "running");
  const runningTask = runningTasks[0] ?? null;
  const queuedTasks = allTasks.filter((t) => t.status === "approved");
  const recentTasks = allTasks.filter((t) => t.status === "completed" || t.status === "failed").slice(0, 5);

  // Metrics
  const running = allTasks.filter((t) => t.status === "running").length;
  const queued = queuedTasks.length;
  const completed = allTasks.filter((t) => t.status === "completed").length;
  const failed = allTasks.filter((t) => t.status === "failed").length;

  // Active agents — include recently completed to show full tree
  const runningInstances = db.prepare(
    `SELECT ai.id, ai.template_agent_id,
            CASE WHEN json_valid(ai.state_metadata) AND json_extract(ai.state_metadata, '$.role') = 'consensus_reviewer'
                 THEN COALESCE(a.name, ai.template_agent_id) || ' (Reviewer)'
                 ELSE COALESCE(a.name, ai.template_agent_id)
            END AS agent_name,
            ai.parent_instance_id, ai.root_instance_id, ai.status, ai.process_pid, ai.task_id,
            ai.input_tokens, ai.output_tokens,
            ai.cache_creation_tokens, ai.cache_read_tokens
     FROM agent_instances ai
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     WHERE ai.status IN ('running', 'waiting_delegation', 'pending')
        OR (ai.status IN ('completed', 'failed') AND ai.task_id IN (SELECT id FROM tasks WHERE status = 'running'))
     ORDER BY ai.created_at`
  ).all() as Array<{
    id: string; template_agent_id: string; agent_name: string;
    parent_instance_id: string | null; root_instance_id: string | null;
    status: string; process_pid: number | null; task_id: string;
    input_tokens: number; output_tokens: number;
    cache_creation_tokens: number; cache_read_tokens: number;
  }>;

  // Build agent tree
  const agentTree = buildAgentTree(runningInstances);

  // Delegation summary
  const groups = db.prepare(
    "SELECT settled_count, expected_count, failed_count FROM delegation_groups WHERE status = 'running'"
  ).all() as Array<{ settled_count: number; expected_count: number; failed_count: number }>;
  const delegationSummary = groups.length > 0
    ? `${groups.length} group${groups.length > 1 ? "s" : ""}, ${groups.reduce((a, g) => a + g.settled_count, 0)}/${groups.reduce((a, g) => a + g.expected_count, 0)} settled`
    : "";

  // Mission data — build for running task, and also provide a lookup for any task
  let mission: ActiveMissionData | null = null;
  if (runningTask) {
    mission = buildMissionForTask(db, runningTask);
  }

  function buildMissionForTask(db: Database, t: typeof allTasks[0]): ActiveMissionData | null {
    const team = t.team_id
      ? db.prepare("SELECT name, phases FROM teams WHERE id = ?").get(t.team_id) as { name: string; phases: string } | null
      : null;

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

  // Build missions map for all tasks that have teams with phases
  const missionsByTask = new Map<string, ActiveMissionData>();
  for (const t of allTasks) {
    const m = buildMissionForTask(db, t);
    if (m) missionsByTask.set(t.id, m);
  }

  // Recent conversations — all active. The sidebar list scrolls (mc-sidebar__list
  // has overflow-y:auto) so unbounded count is fine; an archived conversation
  // drops out via status='active' filter when the user archives it.
  const recentConversations = db.prepare(
    "SELECT id, title, status, updated_at FROM conversations WHERE status = 'active' ORDER BY updated_at DESC"
  ).all() as Array<{ id: string; title: string; status: string; updated_at: string }>;

  // Teams for draft editing — exclude the Real Time team (it's only selectable
  // through the real-time task flow, not for standard task edits).
  const rtTeam = db.prepare("SELECT id FROM teams WHERE lower(name) = 'real time' LIMIT 1").get() as { id: string } | undefined;
  const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
    .filter((t) => !rtTeam || t.id !== rtTeam.id)
    .filter((t) => isTeamVisible(t.id));

  // Escalation count + per-task open-escalation set (drives the sidebar
  // attention dot alongside pending phase reviews).
  const openEscalationTaskIds = new Set(
    (db.prepare("SELECT DISTINCT task_id FROM escalations WHERE status = 'open'").all() as Array<{ task_id: string }>)
      .map((r) => r.task_id),
  );
  const escalationCount = getOpenEscalationCount(db);

  // Daemon
  const daemonRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'owner_pid'").get() as { value: string } | null;
  const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
  const daemonState = pausedRow?.value === "true" ? "paused" : daemonRow ? "running" : "stopped";

  // Token usage totals per task (sum across all instances regardless of status)
  const tokenRows = db
    .prepare(
      `SELECT task_id,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read
       FROM agent_instances GROUP BY task_id`,
    )
    .all() as Array<{ task_id: string; input: number; output: number; cache_creation: number; cache_read: number }>;
  const tokensByTask = new Map<string, { input: number; output: number; cache_creation: number; cache_read: number }>();
  for (const row of tokenRows) {
    tokensByTask.set(row.task_id, {
      input: row.input, output: row.output, cache_creation: row.cache_creation, cache_read: row.cache_read,
    });
  }

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
      has_attention: t.needs_review === 1 || openEscalationTaskIds.has(t.id),
      tokens: tokensByTask.get(t.id) ?? { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    };
  });

  let scheduledTasks: ScheduledTaskSummary[] = [];
  if (isExperimental()) {
    try {
      scheduledTasks = db.prepare(
        `SELECT st.id, st.title, st.description, st.team_id, st.schedule_unit, st.schedule_amount,
                st.status, st.next_run_at, st.last_run_at, st.created_at,
                tm.name AS team_name
         FROM scheduled_tasks st LEFT JOIN teams tm ON tm.id = st.team_id
         ORDER BY CASE st.status WHEN 'approved' THEN 0 ELSE 1 END, st.created_at DESC`
      ).all() as ScheduledTaskSummary[];
    } catch { /* table may not exist yet */ }
  }

  const realtimeSessionActive = new Map<string, boolean>();
  const rtRunning = allTasks.filter(t => t.task_type === "real_time" && t.status === "running");
  if (rtRunning.length > 0) {
    try {
      const rows = db.prepare(
        "SELECT task_id, cadence_timer_active FROM realtime_pipeline_state WHERE task_id IN (" +
        rtRunning.map(() => "?").join(",") + ")"
      ).all(...rtRunning.map(t => t.id)) as Array<{ task_id: string; cadence_timer_active: number }>;
      for (const row of rows) {
        realtimeSessionActive.set(row.task_id, row.cadence_timer_active === 1);
      }
      for (const t of rtRunning) {
        if (!realtimeSessionActive.has(t.id)) {
          realtimeSessionActive.set(t.id, false);
        }
      }
    } catch { /* table may not exist */ }
  }

  return {
    isIdle: runningTasks.length === 0,
    mission,
    missionsByTask,
    metrics: { running, queued, activeAgents: runningInstances.length, completed, failed },
    agentTree,
    delegationSummary,
    allTasks: taskSummaries,
    scheduledTasks,
    queue: queuedTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, created_at: t.created_at })),
    recentTasks: recentTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, completed_at: t.completed_at })),
    recentConversations,
    teams,
    escalationCount,
    daemonState,
    daemonUptime: process.uptime(),
    parallelExecution: getBoolSetting(db, SETTING_PARALLEL_TASKS, true),
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
  delegationsByChild?: Map<string, { id: string; status: string; promptPreview: string }>,
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
      const delegation = delegationsByChild?.get(child.id);
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
