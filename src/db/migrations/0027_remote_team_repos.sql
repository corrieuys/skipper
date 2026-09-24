-- Remote team repos: GitHub repositories the daemon clones (with the machine's
-- own git credentials) and loads team configs from. Machine-scoped, so runtime
-- DB. See src/teams/remote-repos.ts.
CREATE TABLE IF NOT EXISTS remote_team_repos (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  -- Branch or tag to track. NULL = the remote's default branch.
  ref TEXT,
  -- Display name from the manifest (NULL until the first good sync).
  name TEXT,
  -- pending | syncing | ok | error
  status TEXT NOT NULL DEFAULT 'pending',
  last_commit TEXT,
  last_sync_at TEXT,
  -- Whole-repo failure (git or manifest). Teams are left as they were.
  last_error TEXT,
  -- Per-file failures from the last sync: JSON [{ path, error }].
  team_errors TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Marks a local_teams row as owned by a remote repo (read-only in every UI).
-- No FK: a team that still has tasks outlives its repo row, flagged
-- removed_upstream, so the tasks keep a team to point at.
CREATE TABLE IF NOT EXISTS remote_team_links (
  team_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  removed_upstream INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_remote_team_links_repo ON remote_team_links(repo_id);
