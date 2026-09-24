import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Link rows marking a local_teams row as owned by a remote team repo. Kept free
// of any local-teams import so local-teams.ts can read it for its read-only
// guard without a cycle. The sync that writes these lives in remote-repos.ts.
// ---------------------------------------------------------------------------

export interface RemoteTeamLink {
  repoId: string;
  /** Repo-relative path of the team's JSON file. */
  path: string;
  /** The repo no longer ships this team (or the repo was unlinked); kept because tasks still reference it. */
  removedUpstream: boolean;
}

interface LinkRow {
  team_id: string;
  repo_id: string;
  source_path: string;
  removed_upstream: number;
}

function linksTableExists(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_team_links'")
    .get() as { name: string } | null;
  return !!row;
}

function toLink(row: LinkRow): RemoteTeamLink {
  return { repoId: row.repo_id, path: row.source_path, removedUpstream: row.removed_upstream === 1 };
}

export function getRemoteTeamLink(db: Database, teamId: string): RemoteTeamLink | null {
  if (!linksTableExists(db)) return null;
  const row = db.prepare("SELECT * FROM remote_team_links WHERE team_id = ?").get(teamId) as LinkRow | null;
  return row ? toLink(row) : null;
}

/** Every link, keyed by team id. */
export function listRemoteTeamLinks(db: Database): Map<string, RemoteTeamLink> {
  const out = new Map<string, RemoteTeamLink>();
  if (!linksTableExists(db)) return out;
  const rows = db.prepare("SELECT * FROM remote_team_links").all() as LinkRow[];
  for (const row of rows) out.set(row.team_id, toLink(row));
  return out;
}

/** Team ids owned by one repo. */
export function listRepoTeamIds(db: Database, repoId: string): string[] {
  if (!linksTableExists(db)) return [];
  const rows = db
    .prepare("SELECT team_id FROM remote_team_links WHERE repo_id = ? ORDER BY team_id")
    .all(repoId) as { team_id: string }[];
  return rows.map((r) => r.team_id);
}

export function upsertRemoteTeamLink(db: Database, teamId: string, repoId: string, path: string): void {
  db.prepare(
    `INSERT INTO remote_team_links (team_id, repo_id, source_path, removed_upstream)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(team_id) DO UPDATE SET repo_id = excluded.repo_id, source_path = excluded.source_path, removed_upstream = 0`,
  ).run(teamId, repoId, path);
}

export function markRemoteTeamRemoved(db: Database, teamId: string): void {
  db.prepare("UPDATE remote_team_links SET removed_upstream = 1 WHERE team_id = ?").run(teamId);
}

export function deleteRemoteTeamLink(db: Database, teamId: string): void {
  if (!linksTableExists(db)) return;
  db.prepare("DELETE FROM remote_team_links WHERE team_id = ?").run(teamId);
}
