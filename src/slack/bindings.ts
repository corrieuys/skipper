import type { Database } from "bun:sqlite";
import { listLocalTeams } from "../teams/local-teams";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { normalizeSlashCommand } from "./slash-command";

export interface SlashCommandConflict {
  kind: "team" | "scheduled";
  id: string;
  label: string;
}

/**
 * A slash command binds to at most one target. Return the existing team or
 * scheduled task already bound to `command` (excluding the record being edited),
 * or null if the command is free. Used to reject duplicate bindings at save time.
 */
export function findSlashCommandConflict(
  db: Database,
  command: string,
  exclude: { teamId?: string; scheduledTaskId?: string } = {},
): SlashCommandConflict | null {
  const want = normalizeSlashCommand(command);
  if (!want) return null;

  for (const team of listLocalTeams(db)) {
    if (team.id === exclude.teamId) continue;
    if (normalizeSlashCommand(team.config?.slashCommand) === want) {
      return { kind: "team", id: team.id, label: team.name };
    }
  }

  const scheduler = new ScheduledTaskScheduler(db);
  for (const task of scheduler.listScheduledTasks()) {
    if (task.id === exclude.scheduledTaskId) continue;
    const bound = task.task_config?.slashCommand;
    if (typeof bound === "string" && normalizeSlashCommand(bound) === want) {
      return { kind: "scheduled", id: task.id, label: task.title };
    }
  }

  return null;
}
