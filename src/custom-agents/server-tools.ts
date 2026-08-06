import type { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "ai";
import { agentSpawnPath } from "../paths";
import { wrapMcpTools } from "./mcp-tools";
import { resolveHeaders } from "./store";
import {
  qualifyToolName,
  saveToolCatalogue,
  splitQualifiedToolName,
  type CatalogueEntry,
  type McpServerRecord,
} from "./servers";

const CLIENT_NAME = "skipper-custom-agent";
/** A server that will not answer must not hold a run (or a config save) open. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Open a client against a registered server.
 *
 * `env` and `headers` go through `${ENV_VAR}` resolution here, at connect time,
 * so a token can live in the daemon's environment rather than the database.
 *
 * For stdio the resolved env is layered over `getDefaultEnvironment()` rather
 * than replacing it — the SDK drops the inherited environment entirely once you
 * pass `env`, which breaks any server that reads HOME or PATH. `agentSpawnPath()`
 * is applied for the same reason CLI agents get it: `npx` usually lives in
 * ~/.local/bin, which a daemon launched from a GUI context does not have.
 */
export async function openServerClient(server: McpServerRecord): Promise<Client> {
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" }, { capabilities: {} });

  const transport = server.transport === "stdio"
    ? new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: {
        ...getDefaultEnvironment(),
        PATH: agentSpawnPath(),
        ...resolveHeaders(server.env),
      },
      // Do not let a chatty server's stderr land in the daemon log.
      stderr: "ignore",
    })
    : new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: resolveHeaders(server.headers) },
    });

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to ${server.name}`);
  return client;
}

/**
 * Connect, list tools, cache them on the row, disconnect.
 *
 * Called from the config panel's save and Refresh. The cache is what the agent
 * form renders from, so a dead server shows a stale list plus its error rather
 * than hanging the page — which is the whole reason discovery is not live.
 */
export async function refreshServerCatalogue(
  db: Database,
  server: McpServerRecord,
): Promise<{ tools: CatalogueEntry[]; error: string | null }> {
  let client: Client | null = null;
  try {
    client = await openServerClient(server);
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing tools on ${server.name}`);
    const tools: CatalogueEntry[] = listed.tools.map((t) => ({
      name: t.name,
      description: (t.description ?? "").split("\n")[0] ?? "",
    }));
    saveToolCatalogue(db, server.id, tools, null);
    return { tools, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep whatever was cached before: a transient failure should not silently
    // strip an agent's tool checkboxes off the form.
    saveToolCatalogue(db, server.id, server.toolCatalogue, message);
    return { tools: server.toolCatalogue, error: message };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

export interface ServerToolBridge {
  tools: Record<string, Tool>;
  /** Qualified names that were enabled but the server did not offer. */
  missing: string[];
  close: () => Promise<void>;
}

/**
 * Build the tool map for a run from the enabled `<slug>__<tool>` names.
 *
 * Only servers with at least one enabled tool are contacted, so an agent that
 * uses none never spawns anything. A server that fails to connect contributes
 * its enabled names to `missing` instead of failing the run — the same call the
 * daemon loopback makes, for the same reason: an agent that can still do most of
 * its work should, and should say what it lost.
 */
export async function connectServerTools(
  servers: McpServerRecord[],
  enabledQualified: string[],
): Promise<ServerToolBridge> {
  const wanted = new Map<string, Set<string>>();
  const missing: string[] = [];

  for (const qualified of enabledQualified) {
    const split = splitQualifiedToolName(qualified);
    if (!split) continue;
    const set = wanted.get(split.slug) ?? new Set<string>();
    set.add(split.tool);
    wanted.set(split.slug, set);
  }
  if (wanted.size === 0) return { tools: {}, missing: [], close: async () => {} };

  const tools: Record<string, Tool> = {};
  const clients: Client[] = [];

  for (const [slug, toolNames] of wanted) {
    const server = servers.find((s) => s.slug === slug);
    if (!server) {
      // The server was deleted after the agent was configured.
      for (const t of toolNames) missing.push(qualifyToolName(slug, t));
      continue;
    }

    let client: Client;
    try {
      client = await openServerClient(server);
    } catch {
      for (const t of toolNames) missing.push(qualifyToolName(slug, t));
      continue;
    }
    clients.push(client);

    try {
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing tools on ${server.name}`);
      const offered = new Set(listed.tools.map((t) => t.name));
      for (const t of toolNames) if (!offered.has(t)) missing.push(qualifyToolName(slug, t));

      Object.assign(tools, wrapMcpTools(client, listed.tools, toolNames, (name) => qualifyToolName(slug, name)));
    } catch {
      for (const t of toolNames) missing.push(qualifyToolName(slug, t));
    }
  }

  return {
    tools,
    missing,
    close: async () => {
      // Closing a stdio client kills its child process. Every server started for
      // this run must go, or a cancelled task leaves servers behind.
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s ${what}`)), ms).unref?.(),
    ),
  ]);
}
