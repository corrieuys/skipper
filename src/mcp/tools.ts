import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentManager } from "../agents/manager";
import type { DelegationManager } from "../orchestrator/delegation-manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import type { TaskScheduler } from "../tasks/scheduler";
import type { EscalationManager } from "../escalations/manager";
import type { ArtifactManager, ArtifactKind } from "../orchestrator/artifact-manager";
import type { ConsensusManager } from "../orchestrator/consensus-manager";
import type { GlobalStoreManager } from "../global-store/manager";
import type { AgentIdentity, InternalAgentIdentity } from "./auth";
import { eventBus } from "../events/bus";
import { logError } from "../logging";
import { z } from "zod";
import { signalBridge } from "./signal-bridge";
import { isExperimental } from "../config/feature-flags";

export interface DaemonDeps {
  db: Database;
  agentManager: AgentManager;
  delegationManager: DelegationManager;
  phaseManager: PhaseManager;
  taskScheduler: TaskScheduler;
  escalationManager: EscalationManager;
  artifactManager: ArtifactManager;
  consensusManager: ConsensusManager;
  globalStoreManager: GlobalStoreManager;
}

export interface RegisterDaemonToolsOptions {
  /**
   * When true, the three phase-lifecycle tools (`complete_phase`,
   * `complete_task`, `regress_phase`) are NOT registered on this server
   * instance. Delegated child agents get a session with these tools hidden
   * so they cannot advance phases — only the root Skipper can.
   *
   * Defaults to false (root-grade — all tools registered).
   */
  isDelegated?: boolean;
}

/**
 * Register daemon MCP tools on the given McpServer instance.
 * The `getIdentity` callback resolves the calling agent's identity from
 * the session-level auth context (set during transport setup). When
 * `options.isDelegated` is true, phase-lifecycle tools are omitted entirely
 * (not visible in tools/list).
 */
export function registerDaemonTools(
  server: McpServer,
  deps: DaemonDeps,
  getIdentity: () => AgentIdentity | null,
  options?: RegisterDaemonToolsOptions,
): void {
  const { db, agentManager, delegationManager, phaseManager, taskScheduler, escalationManager, artifactManager, consensusManager, globalStoreManager } = deps;

  function getInternalIdentity(): InternalAgentIdentity | null {
    const id = getIdentity();
    if (!id || id.type !== "internal") return null;
    return id;
  }

  function rejectIfDelegated(identity: InternalAgentIdentity, toolName: string): { content: { type: "text"; text: string }[] } | null {
    const inst = db
      .prepare("SELECT parent_instance_id FROM agent_instances WHERE id = ?")
      .get(identity.runtimeId) as { parent_instance_id: string | null } | null;
    const isRoot = inst ? inst.parent_instance_id === null : true;
    if (isRoot) return null;
    return {
      content: [{
        type: "text" as const,
        text: `Error: ${toolName} can only be called by the root Skipper agent. You are a delegated child — end your run by returning your result (and a create_note summary). The orchestrator will route it back to your parent.`,
      }],
    };
  }

  // ── Notes ────────────────────────────────────────────────
  server.tool(
    "create_note",
    "Record an important note for other agents working on this task",
    { content: z.string().describe("The note content (max 280 chars, single line)") },
    async ({ content }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
      if (!identity.taskId) return { content: [{ type: "text" as const, text: "Error: no active task" }] };

      const noteId = crypto.randomUUID();
      const noteAgentId = identity.templateAgentId;
      const taskId = identity.taskId;

      // Dedup check
      const recentDuplicate = db
        .prepare(
          `SELECT id FROM task_notes
           WHERE task_id = ? AND agent_id = ? AND content = ?
             AND created_at >= datetime('now', '-5 seconds')
           LIMIT 1`,
        )
        .get(taskId, noteAgentId, content) as { id: string } | null;

      if (recentDuplicate) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ id: recentDuplicate.id, status: "duplicate" }) }] };
      }

      db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)")
        .run(noteId, taskId, noteAgentId, content);

      eventBus.emit("task:note_added", { noteId, taskId, agentId: noteAgentId, content });

      return { content: [{ type: "text" as const, text: JSON.stringify({ id: noteId, status: "created" }) }] };
    },
  );

  server.tool(
    "list_notes",
    "List notes recorded for the current task",
    {},
    async () => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
      if (!identity.taskId) return { content: [{ type: "text" as const, text: "Error: no active task" }] };

      const notes = db
        .prepare("SELECT id, agent_id, content, created_at FROM task_notes WHERE task_id = ? ORDER BY created_at DESC LIMIT 100")
        .all(identity.taskId) as { id: string; agent_id: string; content: string; created_at: string }[];

      return { content: [{ type: "text" as const, text: JSON.stringify(notes) }] };
    },
  );

  // ── Artifacts ────────────────────────────────────────────
  server.tool(
    "create_artifact",
    "Create a named, versioned artifact shared across agents",
    {
      name: z.string().describe("Artifact name (e.g., 'implementation-plan')"),
      kind: z.enum(["transcript", "summary", "plan", "other"]).describe("Artifact kind"),
      body: z.string().describe("Artifact body content"),
      description: z.string().optional().describe("One-line description"),
    },
    async ({ name, kind, body, description }) => {
      const identity = getInternalIdentity();
      if (!identity?.taskId) return { content: [{ type: "text" as const, text: "Error: no active task" }] };

      try {
        const artifact = artifactManager.createArtifact({
          taskId: identity.taskId,
          name,
          kind: kind as ArtifactKind,
          body,
          description,
          createdByAgentId: identity.runtimeId,
        });

        return { content: [{ type: "text" as const, text: JSON.stringify({ id: artifact.id, version: artifact.version }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  server.tool(
    "get_artifact",
    "Retrieve a specific artifact by name",
    {
      name: z.string().describe("Artifact name"),
      version: z.union([z.literal("latest"), z.number()]).optional().describe("Version number or 'latest'"),
    },
    async ({ name, version }) => {
      const identity = getInternalIdentity();
      if (!identity?.taskId) return { content: [{ type: "text" as const, text: "Error: no active task" }] };

      const v = version ?? "latest";
      const artifact = artifactManager.getArtifact(identity.taskId, name, v);
      if (!artifact) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }] };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ body: artifact.body, version: artifact.version, kind: artifact.kind }) }] };
    },
  );

  server.tool(
    "list_artifacts",
    "List artifacts for the current task",
    {
      kind: z.string().optional().describe("Filter by artifact kind"),
      name_prefix: z.string().optional().describe("Filter by name prefix"),
      limit: z.number().optional().describe("Max results (default 100)"),
    },
    async ({ kind, name_prefix, limit }) => {
      const identity = getInternalIdentity();
      if (!identity?.taskId) return { content: [{ type: "text" as const, text: "Error: no active task" }] };

      const items = artifactManager.listArtifacts({
        taskId: identity.taskId,
        kind,
        namePrefix: name_prefix,
        limit,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(items) }] };
    },
  );

  // ── Global store (cross-task shared values) — experimental ──
  if (isExperimental()) {
  server.tool(
    "set_global_value",
    "Create or update a globally-shared value keyed by name (visible to agents on any task). Only use when the task, phase, or template explicitly instructs it.",
    {
      name: z.string().describe("Unique key for this value"),
      type: z.string().optional().describe("Caller-defined category (e.g. 'checklist', 'log')"),
      data: z.string().optional().describe("The value payload (caller-defined; often JSON or text)"),
      status: z.string().optional().describe("Caller-defined status (e.g. 'open', 'done')"),
    },
    async ({ name, type, data, status }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
      const row = globalStoreManager.set({
        name,
        type,
        data,
        status,
        updatedByAgentId: identity.runtimeId,
        taskId: identity.taskId,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(row) }] };
    },
  );

  server.tool(
    "get_global_value",
    "Fetch one global value by name. Only use when the task, phase, or template explicitly instructs it.",
    { name: z.string().describe("The key to fetch") },
    async ({ name }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
      const row = globalStoreManager.get(name);
      return { content: [{ type: "text" as const, text: row ? JSON.stringify(row) : JSON.stringify({ status: "not_found" }) }] };
    },
  );

  server.tool(
    "query_global_store",
    "Filter global values by any field. Only use when the task, phase, or template explicitly instructs it.",
    {
      name: z.string().optional().describe("Exact name match"),
      type: z.string().optional().describe("Exact type match"),
      status: z.string().optional().describe("Exact status match"),
      data_contains: z.string().optional().describe("Substring match on data"),
      limit: z.number().optional().describe("Max results (default 100)"),
    },
    async ({ name, type, status, data_contains, limit }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
      const rows = globalStoreManager.query({ name, type, status, data_contains, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
    },
  );

  server.tool(
    "delete_global_value",
    "Delete a global value by name. Only use when the task, phase, or template explicitly instructs it.",
    { name: z.string().describe("The key to delete") },
    async ({ name }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
      const deleted = globalStoreManager.delete(name);
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: deleted ? "deleted" : "not_found" }) }] };
    },
  );
  }

  // ── Delegation ───────────────────────────────────────────
  server.tool(
    "delegate",
    "Delegate work to another agent on your team. Spawns a fresh child instance with no prior conversation history.",
    {
      to: z.string().describe("Agent ID to delegate to"),
      prompt: z.string().describe("Description of work to delegate"),
    },
    async ({ to, prompt }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };

      try {
        const delegation = await delegationManager.handleDelegation(identity.runtimeId, to, prompt);
        if (!delegation) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "delegation_failed", message: "Could not create delegation" }) }] };
        }

        signalBridge.registerMcpAction(identity.runtimeId, "delegate", `${to}|${prompt.slice(0, 200)}`);

        return { content: [{ type: "text" as const, text: JSON.stringify({
          delegation_id: delegation.id,
          child_instance_id: delegation.child_instance_id,
          status: delegation.status,
        }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  server.tool(
    "delegate_resume",
    "Resume a PRIOR child instance with a new instruction — continues the same claude/codex conversation so the child keeps full memory of its earlier work. Use this for follow-up turns with the same agent role (e.g. asking the analyst to refine its plan) instead of spawning a fresh delegate. The prior child must (a) belong to this task, (b) have a session_id, and (c) be of a type that supports resume.",
    {
      child_instance_id: z.string().describe("The prior child's agent_instances.id (UUID). Get it from list_delegations or from a previous delegate response."),
      prompt: z.string().describe("New instruction for the resumed child"),
    },
    async ({ child_instance_id, prompt }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };

      try {
        const delegation = await delegationManager.handleResumeDelegation(
          identity.runtimeId,
          child_instance_id,
          prompt,
        );
        if (!delegation) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "resume_failed", message: "Could not resume — prior child not found, task mismatch, or session lost" }) }] };
        }

        signalBridge.registerMcpAction(identity.runtimeId, "delegate_resume", `${child_instance_id}|${prompt.slice(0, 200)}`);

        return { content: [{ type: "text" as const, text: JSON.stringify({
          delegation_id: delegation.id,
          child_instance_id: delegation.child_instance_id,
          status: delegation.status,
          resumed: true,
        }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  server.tool(
    "list_delegations",
    "List delegations for the current task — useful to find a prior child_instance_id for delegate_resume. Returns most-recent first.",
    {
      template_agent_id: z.string().optional().describe("Filter to delegations targeting this template agent id"),
      limit: z.number().optional().describe("Max rows (default 20)"),
    },
    async ({ template_agent_id, limit }) => {
      const identity = getInternalIdentity();
      if (!identity?.taskId) return { content: [{ type: "text" as const, text: "Error: no active task" }] };

      const max = limit ?? 20;
      const rows = template_agent_id
        ? db.prepare(
            `SELECT id, child_agent_id, child_instance_id, status, substr(prompt,1,160) AS prompt_excerpt, created_at, completed_at
             FROM delegations
             WHERE task_id = ? AND child_agent_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          ).all(identity.taskId, template_agent_id, max)
        : db.prepare(
            `SELECT id, child_agent_id, child_instance_id, status, substr(prompt,1,160) AS prompt_excerpt, created_at, completed_at
             FROM delegations
             WHERE task_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          ).all(identity.taskId, max);

      // Annotate each row with whether the child still has a resumable session.
      const sessionRows = db.prepare(
        `SELECT id, session_id FROM agent_instances WHERE task_id = ?`,
      ).all(identity.taskId) as { id: string; session_id: string | null }[];
      const sessionMap = new Map(sessionRows.map((r) => [r.id, r.session_id]));

      const annotated = (rows as Array<{ id: string; child_agent_id: string; child_instance_id: string | null; status: string; prompt_excerpt: string; created_at: string; completed_at: string | null }>).map((r) => ({
        ...r,
        resumable: !!(r.child_instance_id && sessionMap.get(r.child_instance_id)),
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(annotated) }] };
    },
  );

  server.tool(
    "delegate_batch",
    "Delegate work to multiple agents in parallel",
    {
      items: z.array(z.object({
        to: z.string().describe("Agent ID"),
        work: z.string().describe("Work description"),
        label: z.string().optional().describe("Optional label"),
      })).describe("Array of delegation items"),
    },
    async ({ items }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };

      try {
        const delegations = await delegationManager.handleDelegationBatch(identity.runtimeId, items);

        signalBridge.registerMcpAction(identity.runtimeId, "delegate_batch", `${items.length} items`);

        // Find the group ID from the first delegation
        const groupId = delegations.length > 0
          ? (db.prepare("SELECT delegation_group_id FROM delegations WHERE id = ?").get(delegations[0].id) as { delegation_group_id: string } | null)?.delegation_group_id ?? null
          : null;

        return { content: [{ type: "text" as const, text: JSON.stringify({
          group_id: groupId,
          expected_count: delegations.length,
          delegations: delegations.map((d) => ({ id: d.id, status: d.status })),
        }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  server.tool(
    "check_delegation",
    "Check the status of a delegation",
    { delegation_id: z.string().describe("Delegation ID to check") },
    async ({ delegation_id }) => {
      const row = db
        .prepare("SELECT id, status, result, completed_at FROM delegations WHERE id = ?")
        .get(delegation_id) as { id: string; status: string; result: string | null; completed_at: string | null } | null;

      if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }] };

      return { content: [{ type: "text" as const, text: JSON.stringify({
        status: row.status,
        result: row.result,
        completed_at: row.completed_at,
      }) }] };
    },
  );

  server.tool(
    "check_delegation_group",
    "Check the status of a delegation group (batch)",
    { group_id: z.string().describe("Delegation group ID") },
    async ({ group_id }) => {
      const group = db
        .prepare("SELECT * FROM delegation_groups WHERE id = ?")
        .get(group_id) as { id: string; status: string; expected_count: number; settled_count: number; failed_count: number } | null;

      if (!group) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }] };

      const delegations = db
        .prepare("SELECT child_agent_id, status, result FROM delegations WHERE delegation_group_id = ?")
        .all(group_id) as { child_agent_id: string; status: string; result: string | null }[];

      return { content: [{ type: "text" as const, text: JSON.stringify({
        status: group.status,
        settled: group.settled_count,
        expected: group.expected_count,
        failed: group.failed_count,
        results: delegations.map((d) => ({ agent: d.child_agent_id, status: d.status, result: d.result })),
      }) }] };
    },
  );

  // ── Escalation ───────────────────────────────────────────
  server.tool(
    "escalate",
    "Ask the human operator a question (non-blocking — poll with check_escalation)",
    { question: z.string().describe("Question for the human operator") },
    async ({ question }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };

      const escalation = escalationManager.handleEscalation(identity.runtimeId, question);
      if (!escalation) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "escalation_failed" }) }] };
      }

      signalBridge.registerMcpAction(identity.runtimeId, "escalate", question.slice(0, 200));

      return { content: [{ type: "text" as const, text: JSON.stringify({ escalation_id: escalation.id, status: escalation.status }) }] };
    },
  );

  server.tool(
    "check_escalation",
    "Check the status of an escalation",
    { escalation_id: z.string().describe("Escalation ID to check") },
    async ({ escalation_id }) => {
      const row = db
        .prepare("SELECT id, status, response, resolved_at FROM escalations WHERE id = ?")
        .get(escalation_id) as { id: string; status: string; response: string | null; resolved_at: string | null } | null;

      if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }] };

      return { content: [{ type: "text" as const, text: JSON.stringify({
        status: row.status,
        response: row.response,
        resolved_at: row.resolved_at,
      }) }] };
    },
  );

  // ── Phase lifecycle (root-only — omitted from delegated child sessions) ──
  if (!options?.isDelegated) {
    server.tool(
      "complete_phase",
      "Signal that the current phase is complete (root Skipper only)",
      {},
      async () => {
        const identity = getInternalIdentity();
        if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
        const reject = rejectIfDelegated(identity, "complete_phase");
        if (reject) return reject;

        // Await the outcome so the response Skipper sees reflects what actually
        // happened. Previously this was fire-and-forget and always returned
        // "phase_advancing" — even when the call ended up completing the task
        // or stalling on dedup — which let Skipper make decisions on stale info.
        const outcome = await phaseManager.handlePhaseComplete(identity.runtimeId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: outcome }) }] };
      },
    );

    server.tool(
      "regress_phase",
      "Regress to an earlier phase (root Skipper only)",
      {
        target: z.number().describe("Target phase number (1-indexed)"),
        reason: z.string().describe("Reason for regression"),
      },
      async ({ target, reason }) => {
        const identity = getInternalIdentity();
        if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };
        const reject = rejectIfDelegated(identity, "regress_phase");
        if (reject) return reject;

        phaseManager.handlePhaseRegression(identity.runtimeId, target, reason);

        signalBridge.registerMcpAction(identity.runtimeId, "phase_regression", `${target}|${reason.slice(0, 100)}`);

        eventBus.emit("agent:signal", {
          agentId: identity.runtimeId,
          signalType: "phase_regression",
          taskId: identity.taskId,
        });

        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "regressed", target_phase: target }) }] };
      },
    );

    server.tool(
      "complete_task",
      "Signal that the entire task is complete (root Skipper only)",
      { summary: z.string().describe("Summary of what was accomplished") },
      async ({ summary }) => {
        const identity = getInternalIdentity();
        if (!identity?.taskId) return { content: [{ type: "text" as const, text: "Error: no active task" }] };
        const reject = rejectIfDelegated(identity, "complete_task");
        if (reject) return reject;

        try {
          taskScheduler.completeTask(identity.taskId);

          signalBridge.registerMcpAction(identity.runtimeId, "task_complete", summary.slice(0, 200));

          return { content: [{ type: "text" as const, text: JSON.stringify({ status: "completed" }) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );
  }

  // ── Consensus ────────────────────────────────────────────
  server.tool(
    "consensus_pick",
    "Pick the best agent output in a consensus review",
    { agent_short_id: z.string().describe("Short ID (first 8 chars) of the agent to pick") },
    async ({ agent_short_id }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };

      try {
        await consensusManager.handleConsensusPick(identity.runtimeId, agent_short_id);

        signalBridge.registerMcpAction(identity.runtimeId, "consensus_pick", agent_short_id);

        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "applied" }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  server.tool(
    "consensus_merge",
    "Merge the best parts of multiple agent outputs in a consensus review",
    { diff: z.string().describe("Unified diff to apply to the main working directory") },
    async ({ diff }) => {
      const identity = getInternalIdentity();
      if (!identity) return { content: [{ type: "text" as const, text: "Error: agent not authenticated" }] };

      try {
        await consensusManager.handleConsensusMerge(identity.runtimeId, diff);

        signalBridge.registerMcpAction(identity.runtimeId, "consensus_merge", "merged");

        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "applied" }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
}

/**
 * Register MCP tools for external agents (authenticated via API key).
 * Limited surface: task management + discovery only.
 */
export function registerExternalTools(
  server: McpServer,
  deps: DaemonDeps,
  getIdentity: () => AgentIdentity | null,
): void {
  const { db, taskScheduler } = deps;

  const authError = { content: [{ type: "text" as const, text: "Error: not authenticated" }] };

  server.tool(
    "create_task",
    "Create a new task in Skipper (created as draft — approve separately)",
    {
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task description"),
      team_id: z.string().optional().describe("Team ID (use list_teams to discover)"),
      working_directory: z.string().optional().describe("Working directory path"),
    },
    async ({ title, description, team_id, working_directory }) => {
      const identity = getIdentity();
      if (!identity) return authError;

      try {
        const task = taskScheduler.createTask({
          title,
          description,
          teamId: team_id,
          workingDirectory: working_directory || process.cwd(),
        });

        return { content: [{ type: "text" as const, text: JSON.stringify({
          id: task.id,
          title: task.title,
          status: task.status,
          team_id: task.team_id,
        }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  server.tool(
    "list_tasks",
    "List tasks in Skipper, optionally filtered by status",
    {
      status: z.enum(["draft", "approved", "running", "completed", "failed"]).optional().describe("Filter by status"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ status, limit }) => {
      const identity = getIdentity();
      if (!identity) return authError;

      let tasks = taskScheduler.listTasks();
      if (status) tasks = tasks.filter((t) => t.status === status);
      const capped = tasks.slice(0, limit ?? 20);

      return { content: [{ type: "text" as const, text: JSON.stringify(
        capped.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          team_id: t.team_id,
          current_phase: t.current_phase,
          created_at: t.created_at,
        })),
      ) }] };
    },
  );

  server.tool(
    "approve_task",
    "Approve a draft task so Skipper's daemon picks it up",
    {
      task_id: z.string().describe("Task ID to approve"),
    },
    async ({ task_id }) => {
      const identity = getIdentity();
      if (!identity) return authError;

      try {
        const task = taskScheduler.approveTask(task_id);
        return { content: [{ type: "text" as const, text: JSON.stringify({
          id: task.id,
          status: task.status,
          approved_at: task.approved_at,
        }) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  server.tool(
    "list_teams",
    "List available teams (needed for create_task team_id)",
    {},
    async () => {
      const identity = getIdentity();
      if (!identity) return authError;

      const teams = db.prepare("SELECT id, name FROM teams ORDER BY name").all() as { id: string; name: string }[];
      return { content: [{ type: "text" as const, text: JSON.stringify(teams) }] };
    },
  );
}
