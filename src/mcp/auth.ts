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
 * Resolves an agent identity from a Bearer token.
 * Checks: 1) agent_instances (running), 2) agents (busy), 3) api_keys (external).
 */
export function resolveAgentFromToken(db: Database, token: string): AgentIdentity | null {
  if (!token || token.length < 8) return null;

  // Check agent_instances (covers both entrypoints and delegation children)
  const instance = db
    .prepare("SELECT id, template_agent_id, task_id FROM agent_instances WHERE id = ? AND status = 'running'")
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
