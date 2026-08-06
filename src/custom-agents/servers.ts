import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { readAllMcpServers } from "../config-readers/mcp";

/**
 * An MCP server a custom agent can be granted tools from. Skipper's own
 * registry — see the migration for why it is not the Claude/Codex configs.
 */
export interface McpServerRecord {
  id: string;
  /** Namespaces this server's tools as `<slug>__<tool>`. Unique. */
  slug: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  /** Tools cached at the last successful refresh. */
  toolCatalogue: CatalogueEntry[];
  /** Why the last refresh failed, or null. Surfaced in the config panel. */
  catalogueError: string | null;
  catalogueRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogueEntry {
  name: string;
  description: string;
}

export type McpServerInput = Omit<
  McpServerRecord,
  "id" | "toolCatalogue" | "catalogueError" | "catalogueRefreshedAt" | "createdAt" | "updatedAt"
> & { id?: string };

/**
 * Separator between a server's slug and its tool name.
 *
 * Double underscore so a single underscore in either half stays unambiguous,
 * and the whole thing still matches what providers accept as a function name
 * (`[A-Za-z0-9_-]{1,64}`). Same shape Claude Code uses for MCP tools.
 */
export const SERVER_TOOL_SEPARATOR = "__";

export function qualifyToolName(slug: string, toolName: string): string {
  return `${slug}${SERVER_TOOL_SEPARATOR}${toolName}`;
}

/** Split a qualified name back into slug + tool, or null when it is not one. */
export function splitQualifiedToolName(qualified: string): { slug: string; tool: string } | null {
  const idx = qualified.indexOf(SERVER_TOOL_SEPARATOR);
  if (idx <= 0) return null;
  const tool = qualified.slice(idx + SERVER_TOOL_SEPARATOR.length);
  if (!tool) return null;
  return { slug: qualified.slice(0, idx), tool };
}

/** Providers cap function names at 64 chars, so the slug has to leave room. */
export const MAX_SLUG_LENGTH = 24;

export function slugifyServerName(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}

interface ServerRow {
  id: string;
  slug: string;
  name: string;
  transport: string;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  tool_catalogue: string;
  catalogue_error: string | null;
  catalogue_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function rowToServer(row: ServerRow): McpServerRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    transport: row.transport === "stdio" ? "stdio" : "http",
    command: row.command,
    args: parseJson<string[]>(row.args, []),
    env: parseJson<Record<string, string>>(row.env, {}),
    url: row.url,
    headers: parseJson<Record<string, string>>(row.headers, {}),
    toolCatalogue: parseJson<CatalogueEntry[]>(row.tool_catalogue, []),
    catalogueError: row.catalogue_error,
    catalogueRefreshedAt: row.catalogue_refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMcpServers(db: Database): McpServerRecord[] {
  return (db
    .prepare("SELECT * FROM custom_agent_mcp_servers ORDER BY name COLLATE NOCASE")
    .all() as ServerRow[]).map(rowToServer);
}

export function getMcpServer(db: Database, id: string): McpServerRecord | null {
  const row = db.prepare("SELECT * FROM custom_agent_mcp_servers WHERE id = ?").get(id) as ServerRow | null;
  return row ? rowToServer(row) : null;
}

export function getMcpServerBySlug(db: Database, slug: string): McpServerRecord | null {
  const row = db.prepare("SELECT * FROM custom_agent_mcp_servers WHERE slug = ?").get(slug) as ServerRow | null;
  return row ? rowToServer(row) : null;
}

/**
 * Validate + normalize. Throws with an operator-readable message; the routes
 * surface it directly, so a missing command is caught at save time rather than
 * mid-run when an agent reaches for a tool.
 */
export function normalizeServerInput(input: McpServerInput): McpServerInput {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Name is required");

  const slug = slugifyServerName(input.slug || name);
  if (!slug) throw new Error("Name must contain at least one letter or digit");

  const transport = input.transport === "stdio" ? "stdio" : "http";

  const pairs = (raw: Record<string, string> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      const k = key.trim();
      if (!k) continue;
      out[k] = String(value ?? "");
    }
    return out;
  };

  let command = (input.command ?? "").trim();
  let args = Array.isArray(input.args) ? input.args.map((a) => String(a)).filter((a) => a !== "") : [];
  let url = (input.url ?? "").trim();

  if (transport === "stdio") {
    if (!command) throw new Error("Command is required for a stdio server");
    url = "";
  } else {
    if (!url) throw new Error("URL is required for an HTTP server");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`URL is not valid: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL must be http or https");
    }
    command = "";
    args = [];
  }

  return {
    ...(input.id ? { id: input.id } : {}),
    slug,
    name,
    transport,
    command,
    args,
    env: pairs(input.env),
    url,
    headers: pairs(input.headers),
  };
}

function assertSlugFree(db: Database, slug: string, exceptId?: string): void {
  const row = db
    .prepare("SELECT id FROM custom_agent_mcp_servers WHERE slug = ?")
    .get(slug) as { id: string } | null;
  if (row && row.id !== exceptId) {
    throw new Error(`Another server already uses the name "${slug}". Names must be unique — they prefix the tools.`);
  }
}

export function createMcpServer(db: Database, input: McpServerInput): McpServerRecord {
  const n = normalizeServerInput(input);
  assertSlugFree(db, n.slug);
  const id = n.id?.trim() || randomUUID();
  db.prepare(
    `INSERT INTO custom_agent_mcp_servers (id, slug, name, transport, command, args, env, url, headers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, n.slug, n.name, n.transport, n.command, JSON.stringify(n.args), JSON.stringify(n.env), n.url, JSON.stringify(n.headers));
  return getMcpServer(db, id)!;
}

/**
 * Update in place. A blank env/header value keeps the stored one — the panel
 * renders secrets masked, so a save that never touched the field must not wipe
 * it (same contract as the custom agent's API key).
 */
export function updateMcpServer(db: Database, id: string, input: McpServerInput): McpServerRecord {
  const existing = getMcpServer(db, id);
  if (!existing) throw new Error(`MCP server not found: ${id}`);
  const n = normalizeServerInput(input);
  assertSlugFree(db, n.slug, id);

  const keepBlanks = (submitted: Record<string, string>, stored: Record<string, string>) => {
    const out = { ...submitted };
    for (const [k, v] of Object.entries(out)) if (v === "") out[k] = stored[k] ?? "";
    return out;
  };

  db.prepare(
    `UPDATE custom_agent_mcp_servers SET
       slug = ?, name = ?, transport = ?, command = ?, args = ?, env = ?, url = ?, headers = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    n.slug, n.name, n.transport, n.command,
    JSON.stringify(n.args),
    JSON.stringify(keepBlanks(n.env, existing.env)),
    n.url,
    JSON.stringify(keepBlanks(n.headers, existing.headers)),
    id,
  );
  return getMcpServer(db, id)!;
}

export function deleteMcpServer(db: Database, id: string): boolean {
  return db.prepare("DELETE FROM custom_agent_mcp_servers WHERE id = ?").run(id).changes > 0;
}

export function saveToolCatalogue(
  db: Database,
  id: string,
  tools: CatalogueEntry[],
  error: string | null,
): void {
  db.prepare(
    `UPDATE custom_agent_mcp_servers
     SET tool_catalogue = ?, catalogue_error = ?, catalogue_refreshed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(tools), error, id);
}

/**
 * Servers already configured for Claude Code / Codex, minus any Skipper has
 * already imported, for the config panel's import list.
 *
 * Cloud-managed entries are skipped: they carry no command or URL, so there is
 * nothing to copy. Import is a copy, never a live reference — see the migration.
 */
export function listImportableServers(db: Database): Array<{ name: string; slug: string; command: string; args: string[]; source: string }> {
  const taken = new Set(listMcpServers(db).map((s) => s.slug));
  const all = readAllMcpServers();
  const out: Array<{ name: string; slug: string; command: string; args: string[]; source: string }> = [];
  const seen = new Set<string>();

  for (const [source, entries] of [["claude-code", all.claudeCode], ["codex", all.codex]] as const) {
    for (const entry of entries) {
      if (!entry.command || entry.scope === "cloud") continue;
      const slug = slugifyServerName(entry.name);
      if (!slug || taken.has(slug) || seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name: entry.name, slug, command: entry.command, args: entry.args, source });
    }
  }
  return out;
}
