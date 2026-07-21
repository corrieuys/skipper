import type { Database } from "bun:sqlite";

export interface InternalAgentIdentity {
  type: "internal";
  runtimeId: string;
  templateAgentId: string;
  taskId: string | null;
}

export interface ExternalIdentity {
  type: "external";
  apiKeyId: string;
  apiKeyName: string;
}

export type AgentIdentity = InternalAgentIdentity | ExternalIdentity;

export function hashApiKey(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return hasher.digest("hex");
}

/**
 * Validate a plaintext API key (sk-...) against the api_keys table.
 * Shared by MCP external auth and the JSON data API guard (routes/data/auth.ts).
 */
export function resolveApiKey(db: Database, token: string): { id: string; name: string } | null {
  if (!token || token.length < 8) return null;
  const keyHash = hashApiKey(token);
  return db
    .prepare("SELECT id, name FROM api_keys WHERE key_hash = ?")
    .get(keyHash) as { id: string; name: string } | null;
}

/**
 * Diagnose WHY a bearer token failed to resolve, without leaking the token. The
 * MCP 401 path is otherwise silent, which makes "token expired mid-run" almost
 * impossible to debug: it only says the token no longer resolves, not that the
 * instance row exists but its `status` flipped off `running` (the common cause —
 * a live process whose instance was raced to `completed`/`stopped` by an exit
 * handler while a resume was in flight). Returns a compact, log-safe snapshot of
 * the row states the resolver checks, so the next occurrence is explainable.
 */
export function describeTokenState(db: Database, token: string): Record<string, unknown> {
  const out: Record<string, unknown> = { tokenPrefix: token ? token.slice(0, 8) : "(empty)", len: token?.length ?? 0 };
  try {
    const inst = db
      .prepare(
        `SELECT ai.status, ai.process_pid, ai.task_id, t.status AS task_status
         FROM agent_instances ai LEFT JOIN tasks t ON t.id = ai.task_id WHERE ai.id = ?`,
      )
      .get(token) as { status: string; process_pid: number | null; task_id: string | null; task_status: string | null } | null;
    if (inst) {
      out.instance = { status: inst.status, hasPid: inst.process_pid != null, taskStatus: inst.task_status ?? "(none)" };
    }
    const agent = db
      .prepare("SELECT status, current_task_id FROM agents WHERE id = ?")
      .get(token) as { status: string; current_task_id: string | null } | null;
    if (agent) {
      out.agent = { status: agent.status, hasTask: agent.current_task_id != null };
    }
    if (!inst && !agent) out.match = "none";
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/**
 * Resolves an agent identity from a Bearer token.
 * Checks: 1) agent_instances (running), 2) agents (busy), 3) api_keys (external).
 */
export function resolveAgentFromToken(db: Database, token: string): AgentIdentity | null {
  if (!token || token.length < 8) return null;

  // Check agent_instances (covers both entrypoints and delegation children).
  //
  // Validity is scoped to the TASK being live, not the instance's momentary
  // `status`. The instance id IS the bearer token, so it belongs to this task for
  // the task's lifetime — but `agent_instances.status` is a single bit written by
  // many concurrent actors (process-exit → 'completed'/'stopped'/'failed',
  // escalation resume → 'running', delegation-child completion resuming the same
  // parent → 'running', health-monitor, idle-poke). A live process routinely makes
  // an MCP call in a window where an exit handler's write briefly parked the row
  // off 'running' (e.g. a root awaiting delegations while resolving an escalation),
  // which surfaced to the agent as a spurious "token expired" 401 mid-run. Accepting
  // the token while the task is still 'running' removes that whole race class; the
  // old `status='running'` check is kept as an OR so task-less instances
  // (conversations/realtime with no task row) still resolve exactly as before, and
  // role-based tool gating is unchanged (locked at session create in server.ts).
  const instance = db
    .prepare(
      `SELECT ai.id, ai.template_agent_id, ai.task_id
       FROM agent_instances ai LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.id = ? AND (ai.status = 'running' OR t.status = 'running')`,
    )
    .get(token) as { id: string; template_agent_id: string; task_id: string | null } | null;

  if (instance) {
    return {
      type: "internal",
      runtimeId: instance.id,
      templateAgentId: instance.template_agent_id,
      taskId: instance.task_id,
    };
  }

  // Check agents table (entrypoint agents use their template ID as runtime ID)
  const agent = db
    .prepare("SELECT id, current_task_id FROM agents WHERE id = ? AND status = 'busy'")
    .get(token) as { id: string; current_task_id: string | null } | null;

  if (agent) {
    return {
      type: "internal",
      runtimeId: agent.id,
      templateAgentId: agent.id,
      taskId: agent.current_task_id,
    };
  }

  // Check API keys (external agents)
  const apiKey = resolveApiKey(db, token);

  if (apiKey) {
    return {
      type: "external",
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
    };
  }

  return null;
}
