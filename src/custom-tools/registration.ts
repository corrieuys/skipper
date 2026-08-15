import type { Database } from "bun:sqlite";
import { logError } from "../logging";
import { isCustomAgentType } from "../agents/types";
import { getCustomAgentByType } from "../custom-agents/store";
import { getEntrypointAgentId } from "../agents/skipper";
import { getLocalTeam, namespacedAgentId, type LocalTeam } from "../teams/local-teams";
import { executeCustomTool, formatExecution, type ToolContext } from "./runtime";
import { getCustomToolsByName, toolZodShape, type CustomTool } from "./store";

interface InstanceRow {
  task_id: string | null;
  template_agent_id: string;
  state_metadata: string;
}

/**
 * Which custom tools a session may call, as the union of two grants:
 *
 * - the **custom agent definition** (`/custom-agents/:id`) — tools that agent
 *   has wherever it is used
 * - the **team agent** (the team map's agent modal) — tools granted to this
 *   agent on this team, which is how a CLI agent gets one at all
 *
 * Union rather than override because the two answer different questions, and an
 * operator who ticked a box in either place means it.
 */
export function resolveSessionCustomTools(db: Database, runtimeId: string): CustomTool[] {
  const names = new Set<string>();

  let instance: InstanceRow | null = null;
  try {
    instance = db
      .prepare("SELECT task_id, template_agent_id, state_metadata FROM agent_instances WHERE id = ?")
      .get(runtimeId) as InstanceRow | null;
  } catch (err) {
    logError(db, "custom_tools.resolve_instance", { runtimeId }, err);
  }
  if (!instance) return [];

  // Provider comes from the instance's own resolved type, not the template row —
  // a machine-scoped override means those can differ.
  let providerType = "";
  try {
    providerType = (JSON.parse(instance.state_metadata || "{}") as { provider_type?: string }).provider_type ?? "";
  } catch { /* metadata is best-effort */ }
  if (!providerType) {
    const row = db.prepare("SELECT type FROM agents WHERE id = ?").get(instance.template_agent_id) as { type: string } | null;
    providerType = row?.type ?? "";
  }

  if (isCustomAgentType(providerType)) {
    for (const name of getCustomAgentByType(db, providerType)?.enabledCustomTools ?? []) names.add(name);
  }

  for (const name of teamAgentCustomTools(db, instance)) names.add(name);

  return getCustomToolsByName(db, [...names]);
}

function teamAgentCustomTools(db: Database, instance: InstanceRow): string[] {
  if (!instance.task_id) return [];
  try {
    const task = db.prepare("SELECT team_id FROM tasks WHERE id = ?").get(instance.task_id) as { team_id: string | null } | null;
    if (!task?.team_id) return [];
    const team: LocalTeam | null = getLocalTeam(db, task.team_id);
    if (!team) return [];
    // Spawned members carry the shared-layer NAMESPACED id (`<teamId>:<authorId>`);
    // the local team stores the bare author id. Match either form.
    const member = team.agents?.find(
      (a) => a.id === instance.template_agent_id || namespacedAgentId(team.id, a.id) === instance.template_agent_id,
    );
    if (member) return member.customTools ?? [];
    // Skipper is the implicit entrypoint — never in agents[] — so its grant
    // lives on the team config instead of an agent card.
    if (getEntrypointAgentId(db, instance.task_id) === instance.template_agent_id) {
      return team.config?.skipperCustomTools ?? [];
    }
    return [];
  } catch (err) {
    logError(db, "custom_tools.resolve_team", { taskId: instance.task_id }, err);
    return [];
  }
}

/** Minimal shape of the MCP server object, matching how `mcp/tools.ts` uses it. */
interface ToolRegistrar {
  tool(
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  ): void;
}

export interface CustomToolRegistrationDeps {
  db: Database;
  /** The instance this session belongs to; null for external (API-key) sessions. */
  runtimeId: string | null;
  workingDir?: string;
}

/**
 * Register a session's custom tools on the MCP server.
 *
 * They go on the MCP server rather than straight into the custom-agent runner's
 * tool map so that a CLI agent can be granted one too — that is the whole reason
 * the execution path is shared. A custom agent reaches them through the same
 * loopback client it already uses for `create_note`.
 *
 * External (API-key) sessions get none: those are not an agent working on a task,
 * so there is nothing to resolve a grant from.
 */
export function registerCustomTools(server: ToolRegistrar, deps: CustomToolRegistrationDeps): string[] {
  if (!deps.runtimeId) return [];

  const tools = resolveSessionCustomTools(deps.db, deps.runtimeId);
  const registered: string[] = [];

  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      toolZodShape(tool),
      async (args: Record<string, unknown>) => {
        const ctx = buildContext(deps.db, deps.runtimeId!, deps.workingDir);
        const execution = await executeCustomTool(tool, args ?? {}, ctx);
        if (!execution.ok) {
          logError(
            deps.db,
            "custom_tool.failed",
            { tool: tool.name, runtimeId: deps.runtimeId, timedOut: execution.timedOut, durationMs: execution.durationMs },
            new Error(execution.output),
          );
        }
        // A failure comes back as tool-result text, not a thrown error: the model
        // can read it and try something else, which is more useful than killing
        // the turn.
        return { content: [{ type: "text" as const, text: formatExecution(execution) }] };
      },
    );
    registered.push(tool.name);
  }
  return registered;
}

function buildContext(db: Database, runtimeId: string, workingDir?: string): ToolContext {
  const row = db
    .prepare("SELECT task_id, template_agent_id FROM agent_instances WHERE id = ?")
    .get(runtimeId) as { task_id: string | null; template_agent_id: string } | null;
  return {
    taskId: row?.task_id ?? null,
    agentId: row?.template_agent_id ?? null,
    instanceId: runtimeId,
    workingDir: workingDir ?? process.cwd(),
  };
}
