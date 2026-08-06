import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { z, type ZodTypeAny } from "zod";

/** One parameter row as the config form defines it. */
export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required: boolean;
}

export interface CustomTool {
  id: string;
  /** What the model calls. Unique — it shares a namespace with Skipper's own tools. */
  name: string;
  description: string;
  parameters: ToolParameter[];
  /** Function body. Receives `args`, `ctx`, `console`, `fetch`. */
  code: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export type CustomToolInput = Omit<CustomTool, "id" | "createdAt" | "updatedAt"> & { id?: string };

export const PARAM_TYPES: ToolParameter["type"][] = ["string", "number", "boolean", "array", "object"];

/** Providers accept `[A-Za-z0-9_-]{1,64}` as a function name. */
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 120_000;

/**
 * Tool names Skipper already uses. A custom tool that shadowed one would be
 * registered over it on the same MCP session and quietly replace it.
 */
const RESERVED_NAMES = new Set([
  "delegate", "delegate_batch", "delegate_resume", "check_delegation", "check_delegation_group",
  "list_delegations", "complete_phase", "regress_phase", "complete_task", "escalate",
  "check_escalation", "create_note", "list_notes", "create_artifact", "get_artifact",
  "list_artifacts", "post_message", "set_global_value", "get_global_value", "query_global_store",
  "delete_global_value", "consensus_merge", "consensus_pick",
  "slack_send_message", "slack_send_dm", "slack_read_channel",
  "read_file", "search_replace", "list_dir", "glob", "grep", "load_skill",
]);

interface ToolRow {
  id: string;
  name: string;
  description: string;
  parameters: string;
  code: string;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

function rowToTool(row: ToolRow): CustomTool {
  let parameters: ToolParameter[] = [];
  try {
    const parsed = JSON.parse(row.parameters);
    if (Array.isArray(parsed)) parameters = parsed as ToolParameter[];
  } catch { /* a corrupt row degrades to no parameters rather than breaking the page */ }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parameters,
    code: row.code,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCustomTools(db: Database): CustomTool[] {
  return (db
    .prepare("SELECT * FROM custom_tools ORDER BY name COLLATE NOCASE")
    .all() as ToolRow[]).map(rowToTool);
}

export function getCustomTool(db: Database, id: string): CustomTool | null {
  const row = db.prepare("SELECT * FROM custom_tools WHERE id = ?").get(id) as ToolRow | null;
  return row ? rowToTool(row) : null;
}

export function getCustomToolByName(db: Database, name: string): CustomTool | null {
  const row = db.prepare("SELECT * FROM custom_tools WHERE name = ?").get(name) as ToolRow | null;
  return row ? rowToTool(row) : null;
}

/** Tools by name, for building a session's tool set. Unknown names are dropped. */
export function getCustomToolsByName(db: Database, names: string[]): CustomTool[] {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  return listCustomTools(db).filter((t) => wanted.has(t.name));
}

export function normalizeToolInput(input: CustomToolInput): CustomToolInput {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Name is required");
  if (!NAME_PATTERN.test(name)) {
    throw new Error("Name must start with a letter and contain only letters, digits, underscores or hyphens");
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`"${name}" is the name of a built-in Skipper tool. Choose another.`);
  }

  const description = (input.description ?? "").trim();
  if (!description) {
    // The description is the only thing telling a model when to reach for this,
    // so an empty one makes the tool dead weight in every prompt that carries it.
    throw new Error("Description is required — it is how the model decides when to use the tool");
  }

  const seen = new Set<string>();
  const parameters: ToolParameter[] = [];
  for (const raw of input.parameters ?? []) {
    const pName = (raw?.name ?? "").trim();
    if (!pName) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pName)) {
      throw new Error(`Parameter "${pName}" is not a valid identifier`);
    }
    if (seen.has(pName)) throw new Error(`Duplicate parameter "${pName}"`);
    seen.add(pName);
    parameters.push({
      name: pName,
      type: PARAM_TYPES.includes(raw.type) ? raw.type : "string",
      description: (raw.description ?? "").trim(),
      required: raw.required !== false,
    });
  }

  const code = input.code ?? "";
  if (!code.trim()) throw new Error("The function body is empty");

  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.trunc(input.timeoutMs) : 10_000;
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Timeout must be between ${MIN_TIMEOUT_MS}ms and ${MAX_TIMEOUT_MS}ms`);
  }

  return { ...(input.id ? { id: input.id } : {}), name, description, parameters, code, timeoutMs };
}

function assertNameFree(db: Database, name: string, exceptId?: string): void {
  const row = db.prepare("SELECT id FROM custom_tools WHERE name = ?").get(name) as { id: string } | null;
  if (row && row.id !== exceptId) throw new Error(`Another tool is already called "${name}"`);
}

export function createCustomTool(db: Database, input: CustomToolInput): CustomTool {
  const n = normalizeToolInput(input);
  assertNameFree(db, n.name);
  const id = n.id?.trim() || randomUUID();
  db.prepare(
    "INSERT INTO custom_tools (id, name, description, parameters, code, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, n.name, n.description, JSON.stringify(n.parameters), n.code, n.timeoutMs);
  return getCustomTool(db, id)!;
}

export function updateCustomTool(db: Database, id: string, input: CustomToolInput): CustomTool {
  if (!getCustomTool(db, id)) throw new Error(`Custom tool not found: ${id}`);
  const n = normalizeToolInput(input);
  assertNameFree(db, n.name, id);
  db.prepare(
    `UPDATE custom_tools SET name = ?, description = ?, parameters = ?, code = ?, timeout_ms = ?,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(n.name, n.description, JSON.stringify(n.parameters), n.code, n.timeoutMs, id);
  return getCustomTool(db, id)!;
}

export function deleteCustomTool(db: Database, id: string): boolean {
  return db.prepare("DELETE FROM custom_tools WHERE id = ?").run(id).changes > 0;
}

/**
 * Parameter rows → the Zod raw shape the MCP server registers with.
 *
 * Derived rather than stored, so the rows stay the single source of truth and
 * the schema cannot drift from the form. A raw shape (not a `z.object`) is what
 * `McpServer.tool` takes — the same thing Skipper's own tools pass.
 */
export function toolZodShape(tool: Pick<CustomTool, "parameters">): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const p of tool.parameters) {
    let field: ZodTypeAny;
    switch (p.type) {
      case "number": field = z.number(); break;
      case "boolean": field = z.boolean(); break;
      case "array": field = z.array(z.unknown()); break;
      case "object": field = z.record(z.string(), z.unknown()); break;
      default: field = z.string();
    }
    if (p.description) field = field.describe(p.description);
    shape[p.name] = p.required ? field : field.optional();
  }
  return shape;
}
