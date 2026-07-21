import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveAgentFromToken, describeTokenState, type AgentIdentity } from "./auth";
import { registerDaemonTools, registerExternalTools, type DaemonDeps } from "./tools";
import { logError } from "../logging";

/**
 * MCP server that agents connect to for structured communication with the daemon.
 * Replaces stdout signal parsing with typed tool calls.
 *
 * Transport: Streamable HTTP (POST /mcp for messages, GET /mcp for SSE, DELETE /mcp for session end).
 * Auth: Bearer token = agent runtimeId.
 */
export class DaemonMcpServer {
  private db: Database;
  private deps: DaemonDeps;
  private sessions: Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport; identity: AgentIdentity | null }> = new Map();

  constructor(db: Database, deps: DaemonDeps) {
    this.db = db;
    this.deps = deps;
  }

  /**
   * Create a per-session McpServer + transport pair. The identity locked in
   * here determines which tools are registered (root Skipper sees the
   * phase-control tools; delegated children do not). The per-request
   * identity setter is still returned so tool bodies can pick up any later
   * identity refresh, but role-based tool *visibility* is fixed at session
   * creation — a runtime instance's parent-or-not status is stable for life.
   */
  private createSessionServer(identity: AgentIdentity): { server: McpServer; setIdentity: (id: AgentIdentity | null) => void } {
    const server = new McpServer({ name: "skipper-daemon", version: "1.0.0" });
    let currentIdentity: AgentIdentity | null = identity;

    if (identity.type === "external") {
      registerExternalTools(server, this.deps, () => currentIdentity);
    } else {
      const isDelegated = this.isDelegatedRuntime(identity.runtimeId);
      registerDaemonTools(server, this.deps, () => currentIdentity, { isDelegated });
    }

    return { server, setIdentity: (id) => { currentIdentity = id; } };
  }

  private isDelegatedRuntime(runtimeId: string): boolean {
    const row = this.db
      .prepare("SELECT parent_instance_id, json_extract(state_metadata, '$.oneshot') AS oneshot FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { parent_instance_id: string | null; oneshot: number | null } | null;
    // One-off runs (operator resume on a completed task) are treated like a
    // delegated session: phase-lifecycle tools are omitted so they cannot
    // advance/regress phases or complete the task.
    return !!row?.parent_instance_id || row?.oneshot === 1;
  }

  async handleRequest(req: Request): Promise<Response> {
    const method = req.method.toUpperCase();

    // Extract and validate auth
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    // Per RFC 6750 §3 — surface the Bearer auth scheme via WWW-Authenticate so
    // HTTP MCP clients (e.g. Claude Code) don't speculate OAuth on a bare 401
    // and synthesize fake authenticate / complete_authentication tools that
    // hide the real `mcp__skipper-daemon__*` tools from the LLM. The realm is
    // arbitrary but stable so any per-client cache keys remain consistent.
    const bearerChallenge = (errorCode?: string): string =>
      errorCode
        ? `Bearer realm="skipper-daemon", error="${errorCode}"`
        : `Bearer realm="skipper-daemon"`;

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": bearerChallenge(),
          },
        },
      );
    }

    const identity = resolveAgentFromToken(this.db, token);
    if (!identity) {
      // Log WHY the token failed (row states, not the token) — this path was
      // silent, which is why "token expired mid-run" (a live process whose
      // instance was raced off status='running') has been undiagnosable. The
      // method is included so we can tell a benign tools/list probe from a real
      // mid-turn tool call.
      logError(
        this.db,
        "mcp_auth_reject",
        { method, ...describeTokenState(this.db, token) },
        new Error("bearer did not resolve to a live agent identity"),
      );
      // RFC 6750 §3.1 — 401 + error="invalid_token" is the right signal for a
      // supplied-but-unknown bearer (was 403 here which masks "Bearer scheme"
      // from clients that scan WWW-Authenticate on 401 only).
      return new Response(
        JSON.stringify({ error: "Invalid or expired agent token" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": bearerChallenge("invalid_token"),
          },
        },
      );
    }

    try {
      if (method === "POST") {
        return await this.handlePost(req, identity);
      } else if (method === "GET") {
        return await this.handleGet(req, identity);
      } else if (method === "DELETE") {
        return await this.handleDelete(req);
      }

      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (err) {
      const agentId = identity.type === "internal" ? identity.runtimeId : `ext:${identity.apiKeyId}`;
      logError(this.db, "mcp_server_error", { method, agentId }, err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  private async handlePost(req: Request, identity: AgentIdentity): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      session.identity = identity;
      return session.transport.handleRequest(req);
    }

    // New session — create a dedicated McpServer + transport pair. The session
    // ID is generated by the transport DURING handleRequest (when processing
    // the JSON-RPC initialize call), not at construction. Register the session
    // via the onsessioninitialized callback so follow-up requests with the
    // mcp-session-id header can be routed back to this transport. Identity is
    // passed in up-front so role-based tool filtering can fire at registration.
    const { server, setIdentity } = this.createSessionServer(identity);
    setIdentity(identity);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, { server, transport, identity });
      },
      onsessionclosed: (sid) => {
        this.sessions.delete(sid);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    return transport.handleRequest(req);
  }

  private async handleGet(req: Request, identity: AgentIdentity): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");
    if (!sessionId || !this.sessions.has(sessionId)) {
      return Response.json({ error: "No active session. Send a POST first." }, { status: 400 });
    }

    const session = this.sessions.get(sessionId)!;
    session.identity = identity;
    return session.transport.handleRequest(req);
  }

  private async handleDelete(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      await session.transport.close();
      this.sessions.delete(sessionId);
    }
    return new Response(null, { status: 204 });
  }

  close(): void {
    for (const [, session] of this.sessions) {
      // Best effort: shutdown teardown — a transport that fails to close is
      // going away with the process anyway.
      session.transport.close().catch(() => {});
    }
    this.sessions.clear();
  }
}
