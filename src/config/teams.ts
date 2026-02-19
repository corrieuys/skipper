import { getDb } from "../db/connection";
import { isTeamVisible } from "./feature-flags";

const REALTIME_TEAM_NAME = "real time";

export interface TeamOption {
  id: string;
  name: string;
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
  const rtId = getRealtimeTeamId();
  return all.filter((t) => (rtId ? t.id !== rtId : true) && isTeamVisible(t.id));
}

export function listAllTeams(): TeamOption[] {
  return getDb()
    .prepare("SELECT id, name FROM teams ORDER BY name")
    .all() as TeamOption[];
}
