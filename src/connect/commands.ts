import type { TaskScheduler } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { ConnectTool } from "./protocol";

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function executeCommand(
  tool: ConnectTool,
  args: Record<string, unknown>,
  taskScheduler: TaskScheduler,
  scheduledTaskScheduler: ScheduledTaskScheduler,
): CommandResult {
  try {
    switch (tool) {
      case "create-task": {
        const task = taskScheduler.createTask({
          title: String(args.title ?? ""),
          description: args.description != null ? String(args.description) : undefined,
          teamId: args.teamId != null ? String(args.teamId) : undefined,
          workingDirectory: args.workingDirectory != null ? String(args.workingDirectory) : process.cwd(),
        });
        return { ok: true, data: { id: task.id, title: task.title, status: task.status } };
      }
      case "delete-task": {
        const deleted = taskScheduler.deleteTask(String(args.id ?? ""));
        return { ok: true, data: { deleted } };
      }
      case "list-draft-tasks": {
        const tasks = taskScheduler.listTasks().filter((t) => t.status === "draft");
        return { ok: true, data: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })) };
      }
      case "approve-task": {
        const task = taskScheduler.approveTask(String(args.id ?? ""));
        return { ok: true, data: { id: task.id, title: task.title, status: task.status } };
      }
      case "run-recurring-task": {
        const task = scheduledTaskScheduler.runTaskNow(String(args.id ?? ""), taskScheduler);
        return { ok: true, data: { id: task.id, title: task.title, status: task.status } };
      }
      default:
        return { ok: false, error: `Unknown tool: ${String(tool)}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
