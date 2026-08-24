import { getDb } from "../db/connection";
import { isTeamVisible } from "./feature-flags";
import { listLocalTeams } from "../teams/local-teams";

const REALTIME_TEAM_NAME = "real time";

export interface TeamOption {
  id: string;
  name: string;
}

/**
 * Ids of every real-time team: operator teams flagged `config.mode === 'realtime'`
 * plus the built-in "Real Time" team. Used to keep real-time teams out of the
 * standard-task picker and to populate the real-time picker.
 */
function realtimeTeamIdSet(): Set<string> {
  const ids = new Set<string>();
  for (const t of listLocalTeams(getDb())) {
    if (t.config?.mode === "realtime") ids.add(t.id);
  }
  const builtin = getRealtimeTeamId();
  if (builtin) ids.add(builtin);
  return ids;
}

/** Operator-selectable real-time teams (for the real-time task picker). */
export function listRealtimeTeams(): TeamOption[] {
  const all = getDb().prepare("SELECT id, name FROM teams ORDER BY name").all() as TeamOption[];
  const rt = realtimeTeamIdSet();
  return all.filter((t) => rt.has(t.id) && isTeamVisible(t.id));
}

export function getRealtimeTeamId(): string | null {
  const db = getDb();
  const configured = db
    .prepare("SELECT value FROM realtime_config WHERE key = 'realtime_team_id'")
    .get() as { value: string } | undefined;
  if (configured?.value) {
    const exists = db.prepare("SELECT id FROM teams WHERE id = ?").get(configured.value) as { id: string } | undefined;
    if (exists) return exists.id;
  }
  const row = db
    .prepare("SELECT id FROM teams WHERE lower(name) = ? LIMIT 1")
    .get(REALTIME_TEAM_NAME) as { id: string } | undefined;
  return row?.id ?? null;
}

export function setRealtimeTeamId(teamId: string): void {
  getDb()
    .prepare("INSERT INTO realtime_config (key, value) VALUES ('realtime_team_id', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .run(teamId, teamId);
}

export function listTeamsForStandardTasks(): TeamOption[] {
  const all = getDb()
    .prepare("SELECT id, name FROM teams ORDER BY name")
    .all() as TeamOption[];
  const rt = realtimeTeamIdSet();
  return all.filter((t) => !rt.has(t.id) && isTeamVisible(t.id));
}

export function listAllTeams(): TeamOption[] {
  return getDb()
    .prepare("SELECT id, name FROM teams ORDER BY name")
    .all() as TeamOption[];
}
