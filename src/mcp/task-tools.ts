import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { AgentIdentity } from "./auth";
import type { DaemonDeps } from "./tools";
import type { Task } from "../tasks/scheduler";
import { ScheduledTaskScheduler, type ScheduledTask } from "../tasks/scheduled-scheduler";

/**
 * Where a tool is exposed:
 *  - "internal": daemon agents (authenticated by their runtime instance id)
 *  - "external": API-key integrators
 *  - "both": registered in either kind of session
 *
 * This is the single knob for tool visibility. Each spec in TASK_TOOLS declares
 * its audience, and `registerTaskTools` (called once per session with that
 * session's audience) registers only the matching tools. Flip a spec's audience
 * to change who can see it — no other wiring needed.
 */
export type ToolAudience = "internal" | "external" | "both";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
}

const NOT_AUTHENTICATED = { content: [{ type: "text" as const, text: "Error: not authenticated" }] };

type ToolResult = ReturnType<typeof ok>;

interface TaskToolSpec {
  name: string;
  description: string;
  audience: ToolAudience;
  schema: ZodRawShape;
  // args is validated by the SDK against `schema`; typed loosely here so the
  // declarative table stays readable.
  handler: (args: any, deps: DaemonDeps, identity: AgentIdentity) => ToolResult | Promise<ToolResult>;
}

/** Statuses that count as "active" (running or queued) for list_active_tasks. */
const ACTIVE_STATUSES = new Set(["approved", "running", "paused"]);

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Page a task list (already ordered latest-first) into a stable envelope so a
 * caller with hundreds of tasks pulls them in bounded chunks. Out-of-range pages
 * return an empty `tasks` array (not an error). `page` is 1-based.
 */
function pagedTasks(tasks: Task[], page?: number, pageSize?: number) {
  const size = Math.min(Math.max(1, Math.floor(pageSize ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const p = Math.max(1, Math.floor(page ?? 1));
  const total = tasks.length;
  const start = (p - 1) * size;
  const rows = tasks.slice(start, start + size).map(taskRow);
  return ok({
    tasks: rows,
    pagination: {
      page: p,
      page_size: size,
      total,
      total_pages: Math.ceil(total / size),
      has_more: start + size < total,
    },
  });
}

/** Compact list-row view. */
function taskRow(t: Task) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    team_id: t.team_id,
    current_phase: t.current_phase,
    created_at: t.created_at,
  };
}

/** Human-readable cadence for a recurring task. */
function scheduleSummary(s: ScheduledTask): string {
  if (s.schedule_matrix) return "weekly matrix";
  if (s.schedule_unit && s.schedule_amount) return `every ${s.schedule_amount} ${s.schedule_unit}`;
  return "manual"; // no interval — only runs via run_recurring_task
}

/** Compact recurring-task view. */
function recurringRow(s: ScheduledTask) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    schedule: scheduleSummary(s),
    team_id: s.team_id,
    next_run_at: s.next_run_at,
    last_run_at: s.last_run_at,
  };
}

/** Fuller single-task view. */
function taskDetail(t: Task) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    team_id: t.team_id,
    working_directory: t.working_directory,
    current_phase: t.current_phase,
    task_type: t.task_type,
    result: t.result ?? null,
    created_at: t.created_at,
    approved_at: t.approved_at,
    started_at: t.started_at,
    completed_at: t.completed_at,
    updated_at: t.updated_at,
  };
}

/**
 * The task-management tool set, each tagged with its audience. Today every entry
 * is "external" (integrator-facing); lifecycle actions are deliberately NOT given
 * to internal agents, which drive tasks through delegation/phase tools instead.
 */
const TASK_TOOLS: TaskToolSpec[] = [
  {
    name: "create_task",
    description: "Create a new task in Skipper (created as draft — approve separately)",
    audience: "external",
    schema: {
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task description"),
      team_id: z.string().optional().describe("Team ID (use list_teams to discover)"),
      working_directory: z.string().optional().describe("Working directory path"),
    },
    handler: ({ title, description, team_id, working_directory }, deps) => {
      const task = deps.taskScheduler.createTask({
        title,
        description,
        teamId: team_id,
        workingDirectory: working_directory || process.cwd(),
      });
      return ok({ id: task.id, title: task.title, status: task.status, team_id: task.team_id });
    },
  },
  {
    name: "get_task",
    description: "Retrieve a single task by id, with its full detail.",
    audience: "external",
    schema: { task_id: z.string().describe("Task ID") },
    handler: ({ task_id }, deps) => {
      const task = deps.taskScheduler.getTask(task_id);
      if (!task) throw new Error(`Task not found: ${task_id}`);
      return ok(taskDetail(task));
    },
  },
  {
    name: "list_tasks",
    description:
      "List tasks, newest first, paginated. Optionally filter by status. Returns { tasks, pagination } — use pagination.has_more / total_pages to page through large lists.",
    audience: "external",
    schema: {
      status: z.enum(["draft", "approved", "running", "paused", "completed", "failed"]).optional().describe("Filter by status"),
      page: z.number().int().min(1).optional().describe("1-based page number (default 1)"),
      page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Results per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
    },
    handler: ({ status, page, page_size }, deps) => {
      // listTasks() is oldest-first; reverse for newest-first, then filter/paginate.
      let tasks = deps.taskScheduler.listTasks().reverse();
      if (status) tasks = tasks.filter((t) => t.status === status);
      return pagedTasks(tasks, page, page_size);
    },
  },
  {
    name: "list_active_tasks",
    description:
      "List only active tasks — running or queued (approved/running/paused) — newest first, paginated. Returns { tasks, pagination }.",
    audience: "external",
    schema: {
      page: z.number().int().min(1).optional().describe("1-based page number (default 1)"),
      page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Results per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
    },
    handler: ({ page, page_size }, deps) => {
      const tasks = deps.taskScheduler.listTasks().reverse().filter((t) => ACTIVE_STATUSES.has(t.status));
      return pagedTasks(tasks, page, page_size);
    },
  },
  {
    name: "update_task",
    description:
      "Edit an existing DRAFT task (title/description/team/working directory). Only draft tasks can be edited; once approved a task is immutable. Omitted fields keep their current values.",
    audience: "external",
    schema: {
      task_id: z.string().describe("Task ID (must be a draft)"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      team_id: z.string().optional().describe("New team ID (use list_teams)"),
      working_directory: z.string().optional().describe("New working directory"),
    },
    handler: ({ task_id, title, description, team_id, working_directory }, deps) => {
      const existing = deps.taskScheduler.getTask(task_id);
      if (!existing) throw new Error(`Task not found: ${task_id}`);
      // Merge over current values so an omitted field is preserved (updateTask
      // treats an absent description/team as a clear). updateTask itself enforces
      // draft-only and throws a clear message otherwise.
      const updated = deps.taskScheduler.updateTask(task_id, {
        title: title ?? existing.title,
        description: description ?? existing.description ?? undefined,
        teamId: team_id ?? existing.team_id ?? undefined,
        workingDirectory: working_directory ?? existing.working_directory,
      });
      return ok(taskDetail(updated));
    },
  },
  {
    name: "approve_task",
    description: "Approve a draft task so Skipper's daemon picks it up and runs it.",
    audience: "external",
    schema: { task_id: z.string().describe("Task ID to approve") },
    handler: ({ task_id }, deps) => {
      const task = deps.taskScheduler.approveTask(task_id);
      return ok({ id: task.id, status: task.status, approved_at: task.approved_at });
    },
  },
  {
    name: "pause_task",
    description: "Pause a running task (running → paused). The daemon stops its agents; resume later with resume_task.",
    audience: "external",
    schema: { task_id: z.string().describe("Task ID to pause") },
    handler: ({ task_id }, deps) => {
      const task = deps.taskScheduler.pauseTask(task_id);
      return ok({ id: task.id, status: task.status });
    },
  },
  {
    name: "resume_task",
    description: "Resume a paused task (paused → running). Only paused tasks can be resumed.",
    audience: "external",
    schema: { task_id: z.string().describe("Task ID to resume") },
    handler: ({ task_id }, deps) => {
      const task = deps.taskScheduler.resumeFromPause(task_id);
      return ok({ id: task.id, status: task.status });
    },
  },
  {
    name: "cancel_task",
    description: "Cancel an active task (draft/approved/running/paused → failed). Completed/failed tasks cannot be cancelled.",
    audience: "external",
    schema: { task_id: z.string().describe("Task ID to cancel") },
    handler: ({ task_id }, deps) => {
      const task = deps.taskScheduler.cancelTask(task_id);
      return ok({ id: task.id, status: task.status });
    },
  },
  {
    name: "complete_task",
    description: "Mark a running task as completed (running → completed), optionally recording a result.",
    audience: "external",
    schema: {
      task_id: z.string().describe("Task ID to complete"),
      result: z.string().optional().describe("Optional result/summary to record on the task"),
    },
    handler: ({ task_id, result }, deps) => {
      const task = deps.taskScheduler.completeTask(task_id, result);
      return ok({ id: task.id, status: task.status });
    },
  },
  {
    name: "list_teams",
    description: "List available teams (needed for create_task/update_task team_id).",
    audience: "external",
    schema: {},
    handler: (_args, deps) => {
      const teams = deps.db.prepare("SELECT id, name FROM teams ORDER BY name").all() as { id: string; name: string }[];
      return ok(teams);
    },
  },
  {
    name: "list_recurring_tasks",
    description:
      "List recurring tasks with their id, status, and cadence. Use this to find the recurring_task_id for run_recurring_task. Only 'approved' ones can be run.",
    audience: "external",
    schema: {
      status: z.enum(["draft", "approved"]).optional().describe("Filter by status"),
    },
    handler: ({ status }, deps) => {
      let list = new ScheduledTaskScheduler(deps.db).listScheduledTasks();
      if (status) list = list.filter((s) => s.status === status);
      return ok(list.map(recurringRow));
    },
  },
  {
    name: "run_recurring_task",
    description:
      "Run an APPROVED recurring task immediately (a one-off 'Run Now'), independent of its schedule. Optionally pass a one-off prompt injected into this run only. Errors if the recurring task is missing or not approved.",
    audience: "external",
    schema: {
      recurring_task_id: z.string().describe("Recurring task ID (from list_recurring_tasks; must be approved)"),
      prompt: z.string().optional().describe("Optional one-off instruction injected into this run's prompt"),
    },
    handler: ({ recurring_task_id, prompt }, deps) => {
      // Pre-validate with recurring-worded messages (runTaskNow's own guards use
      // internal "scheduled" wording). A fresh scheduler instance is fine here —
      // it's DB-backed and stateless. runTaskNow stamps `prompt` as the run's run_input.
      const sched = new ScheduledTaskScheduler(deps.db);
      const rec = sched.getScheduledTask(recurring_task_id);
      if (!rec) throw new Error(`Recurring task not found: ${recurring_task_id}`);
      if (rec.status !== "approved") throw new Error("Recurring task must be approved to run");
      const run = sched.runTaskNow(recurring_task_id, deps.taskScheduler, prompt);
      return ok({ run_task_id: run.id, recurring_task_id, title: run.title, status: run.status });
    },
  },
];

/**
 * Register the task-management tools for a session of the given audience.
 * A spec registers when its audience matches (or is "both"). Errors thrown by a
 * handler are caught and returned as a tool error, so handlers can throw freely.
 */
export function registerTaskTools(
  server: McpServer,
  deps: DaemonDeps,
  getIdentity: () => AgentIdentity | null,
  audience: "internal" | "external",
): void {
  for (const spec of TASK_TOOLS) {
    if (spec.audience !== "both" && spec.audience !== audience) continue;
    server.tool(spec.name, spec.description, spec.schema, async (args: unknown) => {
      const identity = getIdentity();
      if (!identity) return NOT_AUTHENTICATED;
      try {
        return await spec.handler(args, deps, identity);
      } catch (err) {
        return errorResult(err);
      }
    });
  }
}

/** Tool names exposed to a given audience — handy for tests/docs. */
export function taskToolNamesFor(audience: "internal" | "external"): string[] {
  return TASK_TOOLS.filter((s) => s.audience === "both" || s.audience === audience).map((s) => s.name);
}
