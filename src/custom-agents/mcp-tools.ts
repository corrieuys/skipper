import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dynamicTool, jsonSchema, type Tool } from "ai";

/**
 * Skipper's own MCP tools, reached over the daemon's `/mcp` endpoint on
 * localhost with the running instance's id as the bearer token.
 *
 * Going over the loopback rather than calling `mcp/tools.ts` directly is the
 * whole point: the daemon already decides which tools a session may see from the
 * instance row (root gets phase control, a delegated child does not), and every
 * call still goes through `signal-bridge` so MCP-originated actions dedup against
 * stdout markers exactly as they do for a CLI agent. Calling the impls in-process
 * would fork both of those rules.
 */
export interface McpToolBridge {
  tools: Record<string, Tool>;
  /** Names the daemon offered this session, before the enabled-list filter. */
  available: string[];
  close: () => Promise<void>;
}

export interface McpBridgeOptions {
  port: number;
  /** `agent_instances.id` — the daemon's bearer token for an internal agent. */
  runtimeId: string;
  /** Tool names to expose. Anything the daemon offers that is not listed is dropped. */
  enabled: string[];
}

const CLIENT_NAME = "skipper-custom-agent";

/**
 * Daemon tools are exposed to the model as `mcp__skipper-daemon__<tool>` — the
 * name a CLI agent sees and the name every injected prompt template uses
 * (`prompts/commands-*.md`, `mcp-tools-*.md`). Before this rename the prompt
 * said `mcp__skipper-daemon__create_note` while the tool map said `create_note`,
 * and a model taking the prompt literally called a tool that did not exist.
 *
 * The enabled list and the daemon wire name stay bare — only the model-facing
 * key is prefixed. Names that would exceed the 64-char cap providers put on
 * function names keep their bare name instead (long operator-defined tools).
 */
export const DAEMON_TOOL_PREFIX = "mcp__skipper-daemon__";

export function daemonToolName(name: string): string {
  const prefixed = `${DAEMON_TOOL_PREFIX}${name}`;
  return prefixed.length <= 64 ? prefixed : name;
}

/**
 * Connect, list, and wrap. Returns an empty bridge (never throws) when the
 * daemon is unreachable or the token is rejected — a custom agent that cannot
 * reach the MCP server should still run with its local tools and say so in its
 * output, rather than failing the task at spawn.
 */
export async function connectMcpTools(options: McpBridgeOptions): Promise<McpToolBridge> {
  const enabled = new Set(options.enabled);
  if (enabled.size === 0) {
    return { tools: {}, available: [], close: async () => {} };
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${options.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${options.runtimeId}` } } },
  );
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);

  const listed = await client.listTools();
  const available = listed.tools.map((t) => t.name);

  return {
    tools: wrapMcpTools(client, listed.tools, enabled, daemonToolName),
    available,
    close: async () => {
      try { await client.close(); } catch { /* transport already gone */ }
    },
  };
}

/** What `listTools()` returns per tool, narrowed to what the wrapper needs. */
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * MCP tool specs → an AI SDK tool map, keeping only the enabled names.
 *
 * Shared by the daemon loopback above and the registered-server bridge in
 * `server-tools.ts`, which differ only in how the client was opened and whether
 * names get a `<slug>__` prefix.
 *
 * Schemas are passed through with `jsonSchema()` rather than restated as zod, so
 * a tool's contract is always whatever its server declares.
 */
export function wrapMcpTools(
  client: Pick<Client, "callTool">,
  specs: McpToolSpec[],
  enabled: Set<string> | string[],
  rename: (name: string) => string = (name) => name,
): Record<string, Tool> {
  const allow = enabled instanceof Set ? enabled : new Set(enabled);
  const tools: Record<string, Tool> = {};

  for (const spec of specs) {
    if (!allow.has(spec.name)) continue;
    tools[rename(spec.name)] = dynamicTool({
      description: spec.description ?? spec.name,
      inputSchema: jsonSchema((spec.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>),
      execute: async (args) => {
        const result = await client.callTool({
          name: spec.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });
        return flattenToolResult(result);
      },
    });
  }
  return tools;
}

/** MCP content blocks → the plain string an LLM tool result wants. */
export function flattenToolResult(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result);

  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else parts.push(JSON.stringify(block));
  }
  return parts.join("\n");
}
