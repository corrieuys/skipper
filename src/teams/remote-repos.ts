import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { basename, isAbsolute, join, sep } from "path";
import type { Database } from "bun:sqlite";
import { eventBus } from "../events/bus";
import { agentSpawnPath, getDataDir } from "../paths";
import { isCustomAgentType } from "../agents/types";
import { isSingleAgentRefType } from "../single-agents/store";
import {
  type LocalTeam,
  type LocalTeamInput,
  createLocalTeam,
  deleteLocalTeam,
  getLocalTeam,
  updateLocalTeam,
} from "./local-teams";
import {
  deleteRemoteTeamLink,
  getRemoteTeamLink,
  listRepoTeamIds,
  markRemoteTeamRemoved,
  upsertRemoteTeamLink,
} from "./remote-links";
import { toTeamInput } from "./team-input";

// ---------------------------------------------------------------------------
// Remote team repos: a GitHub repository of team configs the daemon clones and
// loads into local_teams as READ-ONLY teams.
//
//   skipper-teams.json      { "version": 1, "name": "...", "teams": ["teams/a.json"] }
//   teams/a.json            one team, same shape as the /api/teams export
//
// Without a manifest every teams/*.json file loads. Git runs as the daemon's
// user, so the machine's own credentials (credential helper, gh, ssh-agent)
// authenticate the clone; Skipper never sees a token.
//
// Trust: a repo's prompts steer agents that have shell access. What the repo
// may NOT bring is stripped here: shell hooks, Slack bindings, custom-tool
// grants and references to machine-local library agents.
// ---------------------------------------------------------------------------

export const REMOTE_TEAMS_MANIFEST = "skipper-teams.json";
const MANIFEST_VERSION = 1;
const MAX_TEAM_FILE_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

export type RemoteRepoStatus = "pending" | "syncing" | "ok" | "error";

export interface RemoteTeamFileError {
  path: string;
  error: string;
}

export interface RemoteTeamRepo {
  id: string;
  url: string;
  ref: string | null;
  name: string | null;
  status: RemoteRepoStatus;
  lastCommit: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  teamErrors: RemoteTeamFileError[];
  createdAt: string;
  updatedAt: string;
}

interface RepoRow {
  id: string;
  url: string;
  ref: string | null;
  name: string | null;
  status: string;
  last_commit: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  team_errors: string;
  created_at: string;
  updated_at: string;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>`. Injectable so tests never touch the network. */
export type GitRunner = (args: string[]) => Promise<GitResult>;

// ---------------------------------------------------------------------------
// URL + ref validation
// ---------------------------------------------------------------------------

const SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const HTTPS_URL = new RegExp(`^https://github\\.com/(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`);
const SSH_URL = new RegExp(`^(?:ssh://)?git@github\\.com[:/](${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`);
const SHORTHAND = new RegExp(`^(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?$`);

export interface ParsedRepoUrl {
  /** Canonical clone URL (https or scp-style ssh, always ending `.git`). */
  url: string;
  /** Stable id: the same repo gets the same id over https, ssh and re-adds. */
  id: string;
  slug: string;
}

/**
 * Accept only GitHub repository URLs (https, ssh, or `owner/repo`). No userinfo,
 * no other host, no leading dash: the value reaches `git` as an argv element.
 */
export function parseRepoUrl(raw: string): ParsedRepoUrl {
  const value = raw.trim();
  const https = HTTPS_URL.exec(value) ?? SHORTHAND.exec(value);
  const ssh = https ? null : SSH_URL.exec(value);
  const match = https ?? ssh;
  if (!match) {
    throw new Error("Enter a GitHub repository URL: https://github.com/owner/repo or git@github.com:owner/repo");
  }
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/, "");
  if (!repo) throw new Error("Enter a GitHub repository URL: https://github.com/owner/repo");
  const slug = `${owner}/${repo}`;
  const id = createHash("sha256").update(slug.toLowerCase()).digest("hex").slice(0, 8);
  const url = ssh ? `git@github.com:${slug}.git` : `https://github.com/${slug}.git`;
  return { url, id, slug };
}

/** A branch or tag name safe to pass to git. Empty = the default branch. */
export function parseRepoRef(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) || value.includes("..")) {
    throw new Error("Branch or tag may contain only letters, digits, and . _ / -");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function nowTs(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function parseTeamErrors(raw: string): RemoteTeamFileError[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RemoteTeamFileError[]) : [];
  } catch {
    return [];
  }
}

function rowToRepo(row: RepoRow): RemoteTeamRepo {
  return {
    id: row.id,
    url: row.url,
    ref: row.ref,
    name: row.name,
    status: row.status as RemoteRepoStatus,
    lastCommit: row.last_commit,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    teamErrors: parseTeamErrors(row.team_errors),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRemoteTeamRepos(db: Database): RemoteTeamRepo[] {
  const rows = db.prepare("SELECT * FROM remote_team_repos ORDER BY created_at, id").all() as RepoRow[];
  return rows.map(rowToRepo);
}

export function getRemoteTeamRepo(db: Database, id: string): RemoteTeamRepo | null {
  const row = db.prepare("SELECT * FROM remote_team_repos WHERE id = ?").get(id) as RepoRow | null;
  return row ? rowToRepo(row) : null;
}

/** The teams one repo currently owns (incl. those flagged removed upstream). */
export function listRepoTeams(db: Database, repoId: string): LocalTeam[] {
  return listRepoTeamIds(db, repoId)
    .map((id) => getLocalTeam(db, id))
    .filter((t): t is LocalTeam => t !== null);
}

interface RepoPatch {
  name?: string | null;
  status?: RemoteRepoStatus;
  last_commit?: string | null;
  last_sync_at?: string | null;
  last_error?: string | null;
  team_errors?: string;
}

function patchRepo(db: Database, id: string, patch: RepoPatch): void {
  const keys = Object.keys(patch) as (keyof RepoPatch)[];
  if (keys.length === 0) return;
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  const values = keys.map((k) => patch[k] ?? null);
  db.prepare(`UPDATE remote_team_repos SET ${sets} WHERE id = ?`).run(...values, nowTs(), id);
  eventBus.emit("remote_team_repo:changed", { repoId: id, change: "updated" });
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export function getRemoteTeamsRoot(): string {
  return join(getDataDir(), "remote-teams");
}

function cloneDir(repoId: string): string {
  // repoId is 8 hex chars from parseRepoUrl; refuse anything else so the rm
  // below can never leave the remote-teams root.
  if (!/^[a-f0-9]{8}$/.test(repoId)) throw new Error("remote repo: invalid id");
  return join(getRemoteTeamsRoot(), repoId);
}

const AUTH_FAILURE = /could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|Repository not found/i;

function gitFailure(step: string, result: GitResult): Error {
  const detail = result.stderr.trim().split("\n").slice(-4).join(" ").slice(-400) || "no output";
  const hint = AUTH_FAILURE.test(result.stderr)
    ? " Git on this machine has no access to the repository. Run `gh auth setup-git` (https) or load your SSH key, then refresh."
    : "";
  return new Error(`git ${step} failed: ${detail}${hint}`);
}

/** Default runner: the machine's git, never interactive, 60s cap. */
export const systemGit: GitRunner = async (args) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: agentSpawnPath(),
    // A missing credential must fail at once, never wait on a prompt.
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
  try {
    const proc = Bun.spawn(["git", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (proc.signalCode) return { ok: false, stdout, stderr: `${stderr}\ngit timed out after ${GIT_TIMEOUT_MS / 1000}s` };
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

/** Clone on first use, else fetch + hard reset (the clone is daemon-owned, never hand-edited). */
async function ensureCheckout(git: GitRunner, repo: RemoteTeamRepo, dir: string): Promise<void> {
  if (existsSync(join(dir, ".git"))) {
    const fetched = await git(["-C", dir, "fetch", "--depth", "1", "origin", repo.ref ?? "HEAD"]);
    if (!fetched.ok) throw gitFailure("fetch", fetched);
    const reset = await git(["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
    if (!reset.ok) throw gitFailure("reset", reset);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(getRemoteTeamsRoot(), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (repo.ref) args.push("--branch", repo.ref);
  args.push("--", repo.url, dir);
  const cloned = await git(args);
  if (!cloned.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw gitFailure("clone", cloned);
  }
}

// ---------------------------------------------------------------------------
// Manifest + team files
// ---------------------------------------------------------------------------

interface Manifest {
  name: string | null;
  paths: string[];
}

/** Resolve a repo-relative path, refusing anything (incl. a symlink) that leaves the clone. */
function resolveInside(dir: string, rel: string): string {
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new Error("path must be relative and stay inside the repository");
  }
  const full = join(dir, rel);
  if (!existsSync(full)) throw new Error("file not found");
  const root = realpathSync(dir);
  const real = realpathSync(full);
  if (!real.startsWith(root + sep)) throw new Error("path must stay inside the repository");
  return real;
}

function readJsonFile(dir: string, rel: string): unknown {
  const full = resolveInside(dir, rel);
  if (statSync(full).size > MAX_TEAM_FILE_BYTES) throw new Error("file is larger than 1 MB");
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch {
    throw new Error("invalid JSON");
  }
}

function readManifest(dir: string): Manifest {
  if (existsSync(join(dir, REMOTE_TEAMS_MANIFEST))) {
    let raw: unknown;
    try {
      raw = readJsonFile(dir, REMOTE_TEAMS_MANIFEST);
    } catch (e) {
      throw new Error(`${REMOTE_TEAMS_MANIFEST}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${REMOTE_TEAMS_MANIFEST}: expected an object`);
    }
    const m = raw as Record<string, unknown>;
    const version = m.version ?? MANIFEST_VERSION;
    if (version !== MANIFEST_VERSION) {
      throw new Error(`${REMOTE_TEAMS_MANIFEST}: version ${String(version)} is not supported by this Skipper (expected ${MANIFEST_VERSION})`);
    }
    if (!Array.isArray(m.teams) || !m.teams.every((p) => typeof p === "string")) {
      throw new Error(`${REMOTE_TEAMS_MANIFEST}: "teams" must be an array of file paths`);
    }
    return {
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : null,
      paths: [...new Set(m.teams as string[])],
    };
  }
  const teamsDir = join(dir, "teams");
  const files = existsSync(teamsDir)
    ? readdirSync(teamsDir).filter((f) => f.endsWith(".json")).sort().map((f) => `teams/${f}`)
    : [];
  if (files.length === 0) {
    throw new Error(`no ${REMOTE_TEAMS_MANIFEST} manifest and no teams/*.json files in the repository`);
  }
  return { name: null, paths: files };
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A team file is one team object, or the `{ teams: [...] }` export shape. */
function teamsInFile(raw: unknown): Record<string, unknown>[] {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).teams)
    ? ((raw as Record<string, unknown>).teams as unknown[])
    : [raw];
  return list.map((t) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("expected a team object");
    return t as Record<string, unknown>;
  });
}

/**
 * Build the stored input for a remote team. Only what a shared repo may set
 * survives: name, skipper prompt, phases, inline agents, and the mode / icon /
 * audio-summary config. Hooks, Slack bindings and custom-tool grants are
 * machine-local and dropped.
 */
function toRemoteTeamInput(raw: Record<string, unknown>, teamId: string): LocalTeamInput {
  const rawConfig = raw.config && typeof raw.config === "object" ? (raw.config as Record<string, unknown>) : {};
  const config: Record<string, unknown> = {};
  for (const key of ["mode", "icon", "iconColor", "realtime"]) {
    if (key in rawConfig) config[key] = rawConfig[key];
  }
  const input = toTeamInput({
    name: raw.name,
    skipper_prompt: raw.skipper_prompt,
    phases: raw.phases,
    agents: raw.agents,
    config,
  });
  for (const agent of input.agents ?? []) {
    if (isSingleAgentRefType(agent.type) || isCustomAgentType(agent.type)) {
      throw new Error(`agent "${agent.id}" references a library agent of this machine (${agent.type}); a remote team takes inline agents only`);
    }
    delete agent.customTools;
  }
  return { ...input, id: teamId, hooks: [] };
}

function contentOf(team: Pick<LocalTeamInput, "name" | "skipper_prompt" | "hooks" | "phases" | "agents" | "config">): string {
  return JSON.stringify([team.name, team.skipper_prompt ?? "", team.hooks ?? [], team.phases, team.agents ?? [], team.config ?? {}]);
}

function teamHasTasks(db: Database, teamId: string): boolean {
  if (db.prepare("SELECT 1 FROM tasks WHERE team_id = ? LIMIT 1").get(teamId)) return true;
  return !!db.prepare("SELECT 1 FROM scheduled_tasks WHERE team_id = ? LIMIT 1").get(teamId);
}

function upsertRemoteTeam(db: Database, repoId: string, path: string, input: LocalTeamInput): void {
  const teamId = input.id!;
  const existing = getLocalTeam(db, teamId);
  if (!existing) {
    // Link first so the team:changed row already carries its remote marker.
    upsertRemoteTeamLink(db, teamId, repoId, path);
    try {
      createLocalTeam(db, input);
    } catch (e) {
      deleteRemoteTeamLink(db, teamId);
      throw e;
    }
    return;
  }
  if (!existing.remote) throw new Error(`team id "${teamId}" is already used by a local team`);
  const wasRemoved = existing.remote.removedUpstream;
  if (contentOf(existing) !== contentOf(input)) {
    updateLocalTeam(db, teamId, input, { allowRemote: true });
    upsertRemoteTeamLink(db, teamId, repoId, path);
    if (wasRemoved) eventBus.emit("team:changed", { teamId, change: "updated" });
    return;
  }
  upsertRemoteTeamLink(db, teamId, repoId, path);
  if (wasRemoved) eventBus.emit("team:changed", { teamId, change: "updated" });
}

/**
 * A team the repo no longer ships: deleted, unless a task or recurring task
 * still points at it. Then it stays (assignable, read-only) flagged removed
 * upstream, and the operator may delete it.
 */
function retireRemoteTeam(db: Database, teamId: string): void {
  if (!teamHasTasks(db, teamId)) {
    deleteLocalTeam(db, teamId, { allowRemote: true });
    return;
  }
  const link = getRemoteTeamLink(db, teamId);
  if (link && !link.removedUpstream) {
    markRemoteTeamRemoved(db, teamId);
    eventBus.emit("team:changed", { teamId, change: "updated" });
  }
}

function applyManifest(db: Database, repo: RemoteTeamRepo, dir: string, manifest: Manifest): RemoteTeamFileError[] {
  const errors: RemoteTeamFileError[] = [];
  const seenIds = new Set<string>();
  const failedPaths = new Set<string>();

  for (const path of manifest.paths) {
    try {
      if (!path.endsWith(".json")) throw new Error("team files must be .json");
      const raws = teamsInFile(readJsonFile(dir, path));
      for (const raw of raws) {
        const authorId = slugify(typeof raw.id === "string" && raw.id.trim()
          ? raw.id
          : raws.length === 1 ? basename(path, ".json") : String(raw.name ?? ""));
        if (!authorId) throw new Error("team needs an id or a name");
        const teamId = `remote-${repo.id}-${authorId}`;
        if (seenIds.has(teamId)) throw new Error(`duplicate team id "${authorId}" in this repository`);
        upsertRemoteTeam(db, repo.id, path, toRemoteTeamInput(raw, teamId));
        seenIds.add(teamId);
      }
    } catch (e) {
      failedPaths.add(path);
      errors.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // A file that failed keeps its last good team; only a team whose file is gone
  // (or no longer lists it) is retired.
  for (const teamId of listRepoTeamIds(db, repo.id)) {
    if (seenIds.has(teamId)) continue;
    const link = getRemoteTeamLink(db, teamId);
    if (link && failedPaths.has(link.path)) continue;
    retireRemoteTeam(db, teamId);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/** Link a repo (row only, status `pending`). Follow with `syncRemoteTeamRepo`. */
export function addRemoteTeamRepo(db: Database, input: { url: string; ref?: string | null }): RemoteTeamRepo {
  const parsed = parseRepoUrl(input.url);
  const ref = parseRepoRef(input.ref);
  if (getRemoteTeamRepo(db, parsed.id)) throw new Error(`${parsed.slug} is already linked`);
  const ts = nowTs();
  db.prepare(
    `INSERT INTO remote_team_repos (id, url, ref, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(parsed.id, parsed.url, ref, ts, ts);
  eventBus.emit("remote_team_repo:changed", { repoId: parsed.id, change: "created" });
  return getRemoteTeamRepo(db, parsed.id)!;
}

const inFlight = new Map<string, Promise<RemoteTeamRepo | null>>();

/**
 * Pull the repo and load its teams. One sync per repo at a time: a second call
 * while one runs gets the same promise. Never throws; a failure lands on the
 * row (`status: error`, `lastError`) and leaves the stored teams untouched.
 */
export function syncRemoteTeamRepo(db: Database, repoId: string, git: GitRunner = systemGit): Promise<RemoteTeamRepo | null> {
  const running = inFlight.get(repoId);
  if (running) return running;
  const run = runSync(db, repoId, git).finally(() => inFlight.delete(repoId));
  inFlight.set(repoId, run);
  return run;
}

async function runSync(db: Database, repoId: string, git: GitRunner): Promise<RemoteTeamRepo | null> {
  const repo = getRemoteTeamRepo(db, repoId);
  if (!repo) return null;
  patchRepo(db, repoId, { status: "syncing" });
  try {
    const dir = cloneDir(repoId);
    await ensureCheckout(git, repo, dir);
    const head = await git(["-C", dir, "rev-parse", "HEAD"]);
    const manifest = readManifest(dir);
    // Unlinked while git ran: leave nothing behind.
    if (!getRemoteTeamRepo(db, repoId)) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    const teamErrors = applyManifest(db, repo, dir, manifest);
    patchRepo(db, repoId, {
      name: manifest.name,
      status: "ok",
      last_commit: head.ok ? head.stdout.trim() : null,
      last_sync_at: nowTs(),
      last_error: null,
      team_errors: JSON.stringify(teamErrors),
    });
  } catch (e) {
    if (!getRemoteTeamRepo(db, repoId)) return null;
    patchRepo(db, repoId, { status: "error", last_error: e instanceof Error ? e.message : String(e) });
  }
  return getRemoteTeamRepo(db, repoId);
}

/** Boot: pull every linked repo in the background. The stored teams already serve tasks meanwhile. */
export function syncAllRemoteTeamRepos(db: Database, git: GitRunner = systemGit): Promise<unknown> {
  return Promise.all(listRemoteTeamRepos(db).map((r) => syncRemoteTeamRepo(db, r.id, git)));
}

/** Unlink a repo: its teams go the same way as teams removed upstream, then the row + clone. */
export function removeRemoteTeamRepo(db: Database, repoId: string): boolean {
  if (!getRemoteTeamRepo(db, repoId)) return false;
  for (const teamId of listRepoTeamIds(db, repoId)) retireRemoteTeam(db, teamId);
  db.prepare("DELETE FROM remote_team_repos WHERE id = ?").run(repoId);
  try {
    rmSync(cloneDir(repoId), { recursive: true, force: true });
  } catch {
    /* clone dir already gone */
  }
  eventBus.emit("remote_team_repo:changed", { repoId, change: "deleted" });
  return true;
}

/** A local, editable copy of a (remote) team. */
export function duplicateTeamToLocal(db: Database, teamId: string): LocalTeam {
  const team = getLocalTeam(db, teamId);
  if (!team) throw new Error("Team not found");
  return createLocalTeam(db, {
    name: `${team.name} (copy)`,
    skipper_prompt: team.skipper_prompt,
    hooks: team.hooks,
    phases: team.phases,
    agents: team.agents,
    config: team.config,
  });
}
