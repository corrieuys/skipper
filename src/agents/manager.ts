import type { Database } from "bun:sqlite";
import type { Subprocess, FileSink } from "bun";
import { getDb } from "../db/connection";
import { agentSpawnPath } from "../paths";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition, providerSupportsUsageTracking } from "./types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";
import { logError } from "../logging";
import { signalTextSnippet } from "./signal-utils";
import { buildMcpSpawnOverrides, injectDaemonMcpServer, cleanupMcpTempFiles } from "./mcp-spawn-helper";
import { signalBridge } from "../mcp/signal-bridge";
import { getStringSetting } from "../config/app-settings";
import { SETTING_SKIPPER_AGENT_TYPE, SETTING_SKIPPER_MODEL } from "../config/model-settings";

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

// ~100KB prompt limit — leaves headroom for system prompt and conversation context
const MAX_PROMPT_BYTES = 100_000;
const TRUNCATION_MARKER = "\n\n[PROMPT TRUNCATED — original exceeded size limit. Work with the information above.]\n";

// Proactive compaction threshold for resume messages
const RESUME_COMPACT_CHARS = 200_000;
// Grace between SIGTERM and the SIGKILL sweep when killing an agent process tree.
const KILL_TREE_GRACE_MS = 3_000;
const SIGNAL_DEDUP_WINDOW_MS = 15_000;
const SIGNAL_DEDUP_CACHE_LIMIT = 128;

// Delegation result markers used by compactResumeMessage
const DELEGATION_RESULT_START = /\[DELEGATION_RESULT from:[^\]]+\]\n/;
const DELEGATION_RESULT_END = "\n[END_DELEGATION_RESULT]";
const DELEGATION_BATCH_RESULT_START = /\[DELEGATION_BATCH_RESULT id:[^\]]+\]\n/;
const DELEGATION_BATCH_RESULT_END = "\n[END_DELEGATION_BATCH_RESULT]";

export interface Agent {
  id: string;
  name: string;
  type: string;
  model: string;
  config: AgentConfig;
  capabilities: string[];
  status: "idle" | "busy" | "error" | "stopped";
  process_pid: number | null;
  current_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentConfig {
  instruction?: string;
  model?: string;
  environment?: Record<string, string>;
  constraints?: Record<string, string>;
}

export interface RunningAgent {
  id: string;
  templateAgentId: string;
  /** Resolved agent-type/provider (e.g. "claude-code") — gates usage tracking. */
  providerType: string;
  taskId: string | null;
  parentInstanceId: string | null;
  rootInstanceId: string | null;
  workingDir: string;
  process: Subprocess<"pipe", "pipe", "pipe">;
  stdin: FileSink;
  stdoutBuffer: string;
  stderrBuffer: string;
  outputSequence: number;
  sessionId: string | null;
  spawnSessionId: string;
  drainedStreams: number;
  mcpCleanupPaths: string[];
}

export interface SyntheticOutputOptions {
  stream?: "stdout" | "stderr";
}

interface AgentRow {
  id: string;
  name: string;
  type: string;
  model: string;
  config: string;
  capabilities: string;
  status: string;
  process_pid: number | null;
  current_task_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    model: row.model,
    config: JSON.parse(row.config),
    capabilities: JSON.parse(row.capabilities),
    status: row.status as Agent["status"],
    process_pid: row.process_pid,
    current_task_id: row.current_task_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateAgentInput {
  name: string;
  type: string;
  model?: string;
  capabilities?: string[];
  instruction?: string;
}

export interface UpdateAgentInput {
  name: string;
  type: string;
  model?: string;
  capabilities?: string[];
  instruction?: string;
}

export type PermissionMode = "default" | "plan" | "bypassPermissions";

export interface SpawnAgentOptions {
  workingDir: string;
  sessionId?: string;
  initialPrompt?: string;
  /**
   * Task this spawn belongs to. Three semantics:
   *   undefined → caller did not provide one; spawnRuntimeAgent falls back to
   *               agents.current_task_id and throws if that's also null
   *               (orphan-prevention guard: every spawned process must have a
   *               tracked agent_instances row).
   *   string    → explicit task association; row gets created.
   *   null      → explicit opt-out (conversations / realtime); spawn proceeds
   *               without creating an agent_instances row. The caller is
   *               responsible for any tracking it needs.
   */
  taskId?: string | null;
  /**
   * Claude Code --permission-mode override. When set on a `claude`-backed
   * agent type, the spawn drops --dangerously-skip-permissions from the base
   * args and appends `--permission-mode <mode>` instead. Ignored for other
   * commands (codex, etc.) — they have their own approval mechanisms.
   */
  permissionMode?: PermissionMode;
  /**
   * Machine-scoped provider (agent type) / model override applied at spawn
   * instead of the agent row's committed `type` / `model`. Used to honor the
   * config-page settings for the chat agent without editing the committed
   * `agents` table. The root Skipper resolves its own override centrally in
   * spawnRuntimeAgent (see SETTING_SKIPPER_*), so callers there need not thread
   * these through. An unset field falls back to the agent row.
   */
  agentTypeOverride?: string;
  modelOverride?: string;
}

export interface SpawnAgentInstanceOptions extends SpawnAgentOptions {
  taskId?: string | null;
  parentInstanceId?: string | null;
  rootInstanceId?: string | null;
  attempt?: number;
}

interface PersistedRuntimeState {
  taskId: string | null;
  parentInstanceId: string | null;
  rootInstanceId: string | null;
  attempt: number;
}

// --- Signal types for output parsing ---

export type SignalType =
  | "message"
  | "delegate_complete"
  | "json"
  | "text"
  // Conversation-agent-only signals (guarded in handleAgentSignal)
  | "conversation_create_task"
  | "conversation_task_status"
  | "conversation_steer"
  | "conversation_task_note"
  | "conversation_query_tasks"
  | "conversation_query_task";

export interface ParsedSignal {
  type: SignalType;
  agentId: string;
  raw: string;
  // Signal-specific fields
  messageType?: string;
  targetAgent?: string;
  content?: string;
  jsonEvent?: JsonEvent;
}

export interface JsonEvent {
  type?: string;
  session_id?: string;
  thread_id?: string;
  sessionID?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  item?: { type?: string; text?: string; content?: Array<{ type: string; text?: string }> };
  part?: { type?: string; text?: string; reason?: string; tokens?: { total?: number; input?: number; output?: number } };
  result?: string;
  error?: { message?: string };
  [key: string]: unknown;
}

const DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS = 400_000;

function parseContextCompactThreshold(raw: string | undefined): number {
  if (!raw) return DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS;
  return Math.floor(parsed);
}

function truncatePrompt(prompt: string, agentId: string, db: Database, method: string): string {
  const byteLength = Buffer.byteLength(prompt, "utf-8");
  if (byteLength <= MAX_PROMPT_BYTES) return prompt;

  logError(db, "agent.prompt_truncated", {
    agentId,
    originalBytes: byteLength,
    maxBytes: MAX_PROMPT_BYTES,
    method,
  });
  return truncateToByteLimit(prompt, MAX_PROMPT_BYTES) + TRUNCATION_MARKER;
}

const SIGNAL_PATTERNS = {
  message: /^\[MSG:(\S+)\s+to:(\S+)\]\s*(.*)/,
  delegateComplete: /^\[DELEGATE_COMPLETE\]\s*(.*)/,
  // Conversation-agent signals (only handled when agent is a conversation agent)
  conversationCreateTask: /^\[CREATE_TASK\s+title:(.+?)\s+team:(\S+)(?:\s+description:(.+))?\]$/,
  conversationTaskStatus: /^\[TASK_STATUS\s+task:(\S+)\s+status:(\S+)\]$/,
  conversationSteer: /^\[STEER\s+agent:(\S+)\s+message:(.+)\]$/,
  conversationTaskNote: /^\[TASK_NOTE\s+task:(\S+)\s+content:(.+)\]$/,
  conversationQueryTasks: /^\[QUERY_TASKS\]$/,
  conversationQueryTask: /^\[QUERY_TASK\s+id:(\S+)\]$/,
} as const;

function isSignalStart(line: string): boolean {
  return /^\[(MSG:|DELEGATE_COMPLETE\b|CREATE_TASK\b|TASK_STATUS\b|STEER\b|TASK_NOTE\b|QUERY_TASKS\b|QUERY_TASK\b)/.test(line);
}

function buildSignalFingerprint(signal: ParsedSignal): string | null {
  switch (signal.type) {
    case "delegate_complete":
      return `delegate_complete|${signalTextSnippet(signal.content)}`;
    case "message":
      return `message|${signal.messageType ?? ""}|${signal.targetAgent ?? ""}|${signalTextSnippet(signal.content)}`;
    case "conversation_create_task":
    case "conversation_task_status":
    case "conversation_steer":
    case "conversation_task_note":
    case "conversation_query_task":
      return `${signal.type}|${signalTextSnippet(signal.content)}`;
    case "conversation_query_tasks":
      return "conversation_query_tasks";
    default:
      return null;
  }
}

export class AgentManager {
  private db: Database;
  private agents: Map<string, RunningAgent> = new Map();
  private templateToInstances: Map<string, Set<string>> = new Map();
  private respawningAgents: Set<string> = new Set();
  private queuedSignals: Map<string, ParsedSignal[]> = new Map();
  private recentSignalFingerprints: Map<string, Map<string, number>> = new Map();
  private resumeLocks: Map<string, Promise<void>> = new Map();
  // agentId(runtime/instance id) -> resolved provider type, for usage-tracking gate.
  private providerTypeCache: Map<string, string> = new Map();
  private spawnLocks: Set<string> = new Set();
  private closed = false;
  private decoder = new TextDecoder();
  private contextCompactThreshold = parseContextCompactThreshold(process.env.SKIPPER_CONTEXT_COMPACT_THRESHOLD);

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  /** Resolve an agent ID (template or runtime) to the running agent. */
  getRunningAgent(id: string): RunningAgent | undefined {
    // Direct lookup by runtimeId
    const direct = this.agents.get(id);
    if (direct) return direct;
    // Fallback: resolve template agent ID to its active runtime instance
    const instances = this.templateToInstances.get(id);
    if (instances) {
      for (const runtimeId of instances) {
        const agent = this.agents.get(runtimeId);
        if (agent) return agent;
      }
    }
    return undefined;
  }

  /**
   * Resolve the running runtime instance of a template that belongs to a
   * specific task. A single template entrypoint agent can have multiple live
   * instances when several tasks share a team and run in parallel; callers that
   * need to kill/respawn one task's entrypoint MUST target that task's instance,
   * not an arbitrary one (which `getRunningAgent` would return). Returns
   * undefined when this task has no running instance of the template.
   */
  getRunningInstanceForTask(templateAgentId: string, taskId: string): RunningAgent | undefined {
    const instances = this.templateToInstances.get(templateAgentId);
    if (instances) {
      for (const runtimeId of instances) {
        const agent = this.agents.get(runtimeId);
        if (agent && agent.taskId === taskId) return agent;
      }
    }
    // templateAgentId may itself be a runtime id already bound to the task.
    const direct = this.agents.get(templateAgentId);
    if (direct && direct.taskId === taskId) return direct;
    return undefined;
  }

  /** Resolve an agent ID to the runtime ID, checking template→instance mapping. */
  private resolveRuntimeId(id: string): string | undefined {
    if (this.agents.has(id)) return id;
    const instances = this.templateToInstances.get(id);
    if (instances) {
      for (const runtimeId of instances) {
        if (this.agents.has(runtimeId)) return runtimeId;
      }
    }
    return undefined;
  }

  getRunningAgents(): Map<string, RunningAgent> {
    return this.agents;
  }

  getTemplateAgentId(runtimeId: string): string | null {
    const running = this.agents.get(runtimeId);
    if (running) return running.templateAgentId;
    const row = this.db
      .prepare("SELECT template_agent_id FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { template_agent_id: string } | null;
    return row?.template_agent_id ?? null;
  }

  close(): void {
    this.closed = true;
    // Kill all running agents
    for (const [, agent] of this.agents) {
      try { agent.process.kill(); } catch { }
    }
    this.agents.clear();
    this.templateToInstances.clear();
  }

  getRunningInstancesForTemplate(templateAgentId: string): string[] {
    const ids = this.templateToInstances.get(templateAgentId);
    return ids ? Array.from(ids) : [];
  }

  isRespawning(agentId: string): boolean {
    return this.respawningAgents.has(agentId);
  }

  markAsRespawning(agentId: string): void {
    const resolvedId = this.resolveRuntimeId(agentId) ?? agentId;
    this.respawningAgents.add(resolvedId);
  }

  waitForExit(agentId: string, timeoutMs: number = 5000): Promise<void> {
    const resolvedId = this.resolveRuntimeId(agentId) ?? agentId;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        eventBus.off("agent:exit", handler);
        resolve();
      }, timeoutMs);

      const handler = (event: AgentExitEvent) => {
        if (event.agentId === resolvedId) {
          clearTimeout(timer);
          eventBus.off("agent:exit", handler);
          resolve();
        }
      };

      eventBus.on("agent:exit", handler);

      // If agent already exited, resolve immediately
      if (!this.agents.has(resolvedId)) {
        clearTimeout(timer);
        eventBus.off("agent:exit", handler);
        resolve();
      }
    });
  }

  waitForStreamsDrained(agentId: string, timeoutMs: number = 5000): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        eventBus.off("agent:streams_drained", handler);
        resolve();
      }, timeoutMs);

      const handler = (event: { agentId: string }) => {
        if (event.agentId === agentId) {
          clearTimeout(timer);
          eventBus.off("agent:streams_drained", handler);
          resolve();
        }
      };

      eventBus.on("agent:streams_drained", handler);
    });
  }

  async spawnAgent(agentId: string, options: SpawnAgentOptions): Promise<RunningAgent> {
    if (this.spawnLocks.has(agentId)) {
      throw new Error(`Spawn already in flight for agent ${agentId}`);
    }
    this.spawnLocks.add(agentId);
    try {
      const runtimeId = crypto.randomUUID();
      return await this.spawnRuntimeAgent(
        agentId,
        runtimeId,
        { ...options, taskId: options.taskId, parentInstanceId: null, rootInstanceId: runtimeId, attempt: 1 },
        true,
      );
    } finally {
      this.spawnLocks.delete(agentId);
    }
  }

  async spawnAgentInstance(
    templateAgentId: string,
    instanceId: string,
    options: SpawnAgentInstanceOptions,
  ): Promise<RunningAgent> {
    return this.spawnRuntimeAgent(templateAgentId, instanceId, options, false);
  }

  private async spawnRuntimeAgent(
    templateAgentId: string,
    runtimeId: string,
    options: SpawnAgentInstanceOptions,
    isTemplateRuntime: boolean,
  ): Promise<RunningAgent> {
    // Check for existing runtime by direct ID
    const existingRuntime = this.agents.get(runtimeId);
    if (existingRuntime) {
      this.killAgent(runtimeId);
      await this.waitForExit(runtimeId, 10000);
      if (this.agents.get(runtimeId)) {
        throw new Error(`Failed to replace running runtime: ${runtimeId}`);
      }
    }
    // For template runtimes, kill existing runtime only if it's for the same task.
    // Different tasks may run the same template agent in parallel.
    if (isTemplateRuntime) {
      const existingByTemplate = this.getRunningAgent(templateAgentId);
      if (existingByTemplate && existingByTemplate.id !== runtimeId) {
        const sameTask = options.taskId && existingByTemplate.taskId === options.taskId;
        if (sameTask) {
          this.killAgent(existingByTemplate.id);
          await this.waitForExit(existingByTemplate.id, 10000);
        }
      }
    }
    const agent = this.getAgent(templateAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${templateAgentId}`);
    }

    // Resolve provider (agent type) + model, layering machine-scoped overrides
    // over the agent row's committed values. Explicit options win (chat passes
    // them); otherwise the root Skipper (a template runtime) reads its own
    // app_settings override so every skipper spawn path — initial, resume,
    // recovery, idle-poke, realtime — honors the config-page choice.
    let overrideType = options.agentTypeOverride;
    let overrideModel = options.modelOverride;
    if (isTemplateRuntime) {
      if (overrideType === undefined) {
        overrideType = getStringSetting(this.db, SETTING_SKIPPER_AGENT_TYPE, "") || undefined;
      }
      if (overrideModel === undefined) {
        overrideModel = getStringSetting(this.db, SETTING_SKIPPER_MODEL, "") || undefined;
      }
    }
    const resolvedType = overrideType || agent.type;
    const resolvedModel = overrideModel || agent.model;

    const typeDef = getAgentTypeDefinition(resolvedType, this.db);
    if (!typeDef) {
      throw new Error(`Unknown agent type: ${resolvedType}`);
    }

    const usesInlinePrompt = agentTypeUsesInlinePrompt(typeDef, options.sessionId);
    const inlinePrompt = options.initialPrompt
      ? truncatePrompt(options.initialPrompt, runtimeId, this.db, "spawnRuntimeAgent")
      : null;

    // Build command args
    const args = [...typeDef.args];
    if (options.sessionId && typeDef.supports_resume) {
      if (typeDef.resume_args && typeDef.resume_args.length > 0) {
        args.splice(
          0,
          args.length,
          ...typeDef.resume_args.map((arg) => {
            if (arg === "{{prompt}}") {
              if (inlinePrompt === null) {
                throw new Error(`Agent type ${agent.type} requires an initial prompt when using resume_args`);
              }
              return inlinePrompt;
            }
            return arg.replaceAll("{{session_id}}", options.sessionId!);
          }),
        );
      } else if (typeDef.resume_flag) {
        args.push(...typeDef.resume_flag.split(" "), options.sessionId);
      }
    }
    if (!options.sessionId || !typeDef.supports_resume || !typeDef.resume_args?.length) {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "{{prompt}}") {
          if (inlinePrompt === null) {
            throw new Error(`Agent type ${agent.type} requires an initial prompt when spawning`);
          }
          args[i] = inlinePrompt;
        }
      }
    }
    if (resolvedModel !== "default" && typeDef.model_flag) {
      args.push(typeDef.model_flag, resolvedModel);
    }

    // Claude Code --permission-mode override (chat conversation picker).
    // The base claude-code args hardcode --dangerously-skip-permissions; that
    // conflicts with --permission-mode, so strip it before appending.
    if (options.permissionMode && typeDef.command === "claude") {
      for (let i = args.length - 1; i >= 0; i--) {
        if (args[i] === "--dangerously-skip-permissions") args.splice(i, 1);
      }
      args.push("--permission-mode", options.permissionMode);
    }

    // Prepare environment
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    // Ensure agent CLIs in ~/.local/bin resolve regardless of launch context.
    // Set before agent.config.environment so an explicit user PATH still wins.
    env.PATH = agentSpawnPath();
    if (agent.config.environment) {
      Object.assign(env, agent.config.environment);
    }
    env.AGENT_ID = templateAgentId;
    env.AGENT_RUNTIME_ID = runtimeId;
    env.AGENT_INSTANCE_ID = runtimeId;
    env.AGENT_NAME = agent.name;
    env.AGENT_TYPE = agent.type;
    delete env.CLAUDECODE;

    // Apply env_var templates from agent type
    for (const [key, template] of Object.entries(typeDef.env_vars)) {
      env[key] = template.replace("{{model}}", agent.model);
    }

    // Inject MCP server overrides (disabled servers filtered out via temp config)
    let mcpOverrides = buildMcpSpawnOverrides(agent.type);

    // Inject skipper-daemon MCP server so agents can use structured tool calls
    const daemonPort = Number(process.env.PORT) || 5005;
    mcpOverrides = injectDaemonMcpServer(mcpOverrides, runtimeId, agent.type, daemonPort);

    if (mcpOverrides.extraArgs.length > 0) {
      args.push(...mcpOverrides.extraArgs);
    }
    if (Object.keys(mcpOverrides.extraEnv).length > 0) {
      Object.assign(env, mcpOverrides.extraEnv);
    }

    // Insert agent_instances row BEFORE spawn so the daemon /mcp endpoint can
    // authenticate the runtimeId as soon as the child connects. Without this,
    // there's a window where Claude Code initializes its MCP transport but the
    // DB row doesn't yet exist, /mcp returns 403, and the MCP server is marked
    // dead for the lifetime of the agent. We insert with process_pid = NULL
    // and patch it after Bun.spawn returns. Both delegated children AND
    // template runtimes (Skipper / root) need this — on task resume/iterate
    // the new Skipper instance was hitting the same race and getting MCP
    // disconnected for the whole run.
    // Resolve the task this spawn belongs to. Three branches:
    //   options.taskId === null      → explicit opt-out (conversations, realtime
    //                                   manual-insert flows). Skip INSERT silently.
    //   options.taskId === string    → use it.
    //   options.taskId === undefined → fall back to agents.current_task_id
    //                                   (meaningful for template-runtimes only).
    //                                   If that's also null, log it loudly as an
    //                                   orphan_spawn and proceed without an INSERT
    //                                   — the resulting process can't be tracked
    //                                   by recovery / UI / state-tracker. Caller
    //                                   bug at the spawn site.
    const explicitOptOut = options.taskId === null;
    const preSpawnTaskId = explicitOptOut
      ? null
      : (options.taskId
        ?? (isTemplateRuntime
          ? (this.db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(templateAgentId) as { current_task_id: string | null } | null)?.current_task_id ?? null
          : null));

    if (!explicitOptOut && !preSpawnTaskId) {
      // Loud log instead of throw — throwing breaks the conversations chat
      // flow and ad-hoc test fixtures that legitimately spawn without a
      // task. Operators grep error_log for `orphan_spawn` to find spawn
      // sites that should be passing taskId.
      logError(
        this.db,
        "orphan_spawn",
        {
          templateAgentId,
          runtimeId,
          isTemplateRuntime,
          method: "spawnRuntimeAgent",
          reason: "no taskId resolvable — spawn proceeded without agent_instances row; process is untrackable",
        },
        new Error("spawn without taskId"),
      );
    }

    if (preSpawnTaskId) this.db
      .prepare(
        `INSERT INTO agent_instances (
           id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, process_pid, session_id, state_metadata, attempt
         ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, '{}', ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           template_agent_id = excluded.template_agent_id,
           parent_instance_id = excluded.parent_instance_id,
           root_instance_id = excluded.root_instance_id,
           status = 'running',
           process_pid = NULL,
           session_id = excluded.session_id,
           attempt = excluded.attempt,
           updated_at = datetime('now')`,
      )
      .run(
        runtimeId,
        preSpawnTaskId,
        templateAgentId,
        options.parentInstanceId ?? null,
        options.rootInstanceId ?? runtimeId,
        options.sessionId ?? null,
        options.attempt ?? 1,
      );

    // Spawn the process. If Bun.spawn throws (bad cwd, missing binary, fork
    // limit, etc.) the pre-spawn agent_instances row above would otherwise be
    // stranded in status='running' with pid=NULL forever — health-monitor only
    // checks rows with process_pid IS NOT NULL, so the ghost sits invisibly
    // until orphan recovery exhausts and fails the entire task. Clean up the
    // row before rethrowing so callers (DelegationManager) can mark the
    // delegation failed with a real reason instead of a silent timeout.
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn({
        cmd: [typeDef.command, ...args],
        cwd: options.workingDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        // Detach so the child becomes a process-group leader (setsid → pid===pgid).
        // Lets killAgentTree() signal the whole tree via the negative pgid, so a
        // paused/cancelled task's agent AND every subprocess it spawned dies.
        detached: true,
      });
    } catch (err) {
      // Only mark the row failed when one was actually inserted above.
      // Explicit-opt-out spawns (conversations, realtime) skip the INSERT.
      if (preSpawnTaskId) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          this.db
            .prepare(
              "UPDATE agent_instances SET status = 'failed', process_pid = NULL, state_metadata = json_set(state_metadata, '$.spawn_error', ?), updated_at = datetime('now') WHERE id = ?",
            )
            .run(reason, runtimeId);
        } catch (cleanupErr) {
          logError(this.db, "agent.spawn_cleanup", { runtimeId, templateAgentId }, cleanupErr);
        }
      }
      cleanupMcpTempFiles(mcpOverrides.cleanupPaths);
      throw err;
    }

    // Create a new spawn session for terminal output grouping
    const spawnSessionId = crypto.randomUUID();
    try {
      this.db
        .prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)")
        .run(spawnSessionId, runtimeId);
    } catch (err) {
      logError(this.db, "agent.create_session", { agentId: templateAgentId, runtimeId, spawnSessionId }, err);
    }

    const runningAgent: RunningAgent = {
      id: runtimeId,
      templateAgentId,
      providerType: resolvedType,
      taskId: options.taskId ?? null,
      parentInstanceId: options.parentInstanceId ?? null,
      rootInstanceId: options.rootInstanceId ?? runtimeId,
      workingDir: options.workingDir,
      process: proc,
      stdin: proc.stdin,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: options.sessionId ?? null,
      spawnSessionId,
      drainedStreams: 0,
      mcpCleanupPaths: mcpOverrides.cleanupPaths,
    };

    // Track in memory
    this.agents.set(runtimeId, runningAgent);
    const templateInstances = this.templateToInstances.get(templateAgentId) ?? new Set<string>();
    templateInstances.add(runtimeId);
    this.templateToInstances.set(templateAgentId, templateInstances);

    this.syncTemplateRuntimeState(templateAgentId);
    // Row was inserted pre-spawn (status='running', pid=NULL); patch in the
    // real PID now that Bun.spawn has assigned one. Same path for delegated
    // children and template runtimes — see the pre-spawn block above.
    if (preSpawnTaskId) {
      this.db
        .prepare(
          "UPDATE agent_instances SET process_pid = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(proc.pid, runtimeId);
      eventBus.emit("instance:state_changed", {
        instanceId: runtimeId,
        templateAgentId,
        taskId: preSpawnTaskId,
        parentInstanceId: options.parentInstanceId ?? null,
        rootInstanceId: options.rootInstanceId ?? runtimeId,
        status: "running",
      });
    }

    // Wire output handlers
    this.readStream(runningAgent, proc.stdout, "stdout");
    this.readStream(runningAgent, proc.stderr, "stderr");

    // Close stdin for agents that received their prompt inline and don't accept interactive stdin.
    // Without this, CLIs like opencode hang waiting for stdin EOF before processing.
    if (usesInlinePrompt && inlinePrompt !== null && !typeDef.supports_stdin) {
      try { proc.stdin.end(); } catch { /* process may have already exited */ }
    }

    // Register exit handler
    const processPid = proc.pid;
    proc.exited.then((code) => {
      this.handleProcessExit(runtimeId, processPid, code);
    });

    return runningAgent;
  }

  private async readStream(
    runningAgent: RunningAgent,
    stream: ReadableStream<Uint8Array>,
    streamType: "stdout" | "stderr",
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = this.decoder.decode(value, { stream: true });

        // Store in terminal_outputs
        runningAgent.outputSequence++;
        const seq = runningAgent.outputSequence;
        try {
          if (!this.closed) {
            this.db
              .prepare(
                "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, ?, ?, ?, ?)",
              )
              .run(runningAgent.id, runningAgent.spawnSessionId, streamType, text, seq);
          }
        } catch (err) {
          if (!this.closed) logError(this.db, "agent.store_output", { agentId: runningAgent.id, streamType, seq }, err);
        }

        // Emit event for real-time UI
        eventBus.emit("agent:output", {
          agentId: runningAgent.id,
          stream: streamType,
          data: text,
          sequence: seq,
        });

        if (streamType === "stdout") {
          runningAgent.stdoutBuffer += text;
          if (runningAgent.stdoutBuffer.length > MAX_BUFFER_SIZE) {
            logError(this.db, "agent.stdout_buffer_overflow", { agentId: runningAgent.id, bufferSize: runningAgent.stdoutBuffer.length }, new Error("stdout buffer exceeded max size, truncating"));
            runningAgent.stdoutBuffer = runningAgent.stdoutBuffer.slice(-MAX_BUFFER_SIZE / 2);
          }
          const lines = this.processStdoutBuffer(runningAgent);
          for (const line of lines) {
            const signal = this.parseAgentOutput(runningAgent.id, line);
            this.emitSignalIfNeeded(runningAgent.id, signal);

            const queued = this.queuedSignals.get(runningAgent.id) ?? [];
            for (const queuedSignal of queued) {
              this.emitSignalIfNeeded(runningAgent.id, queuedSignal);
            }
            if (queued.length > 0) {
              this.queuedSignals.delete(runningAgent.id);
            }
          }
        } else {
          runningAgent.stderrBuffer += text;
          if (runningAgent.stderrBuffer.length > MAX_BUFFER_SIZE) {
            runningAgent.stderrBuffer = runningAgent.stderrBuffer.slice(-MAX_BUFFER_SIZE / 2);
          }
        }
      }
    } catch (err) {
      // Stream closed or errored - expected on process exit
    } finally {
      reader.releaseLock();
      runningAgent.drainedStreams++;
      if (runningAgent.drainedStreams === 2) {
        eventBus.emit("agent:streams_drained", { agentId: runningAgent.id });
      }
    }
  }

  private emitSignalIfNeeded(agentId: string, signal: ParsedSignal): void {
    if (signal.type === "text" || signal.type === "json") return;
    if (!this.shouldEmitSignal(agentId, signal)) return;
    eventBus.emit("agent:signal", {
      agentId,
      signalType: signal.type,
      content: signal.content,
      targetAgent: signal.targetAgent,
      targetInstanceId: signal.targetInstanceId,
      taskId: signal.taskId,
      targetPhase: signal.targetPhase,
      reason: signal.reason,
    });
  }

  private shouldEmitSignal(agentId: string, signal: ParsedSignal): boolean {
    const fingerprint = buildSignalFingerprint(signal);
    if (!fingerprint) return true;

    // Check MCP signal bridge — if this action was already handled via MCP tool call, suppress
    const mcpContentSnippet = signalTextSnippet(signal.content);
    if (signalBridge.hasMcpAction(agentId, signal.type, mcpContentSnippet)) {
      return false;
    }

    const now = Date.now();
    const cache = this.recentSignalFingerprints.get(agentId) ?? new Map<string, number>();

    for (const [key, ts] of cache) {
      if (now - ts > SIGNAL_DEDUP_WINDOW_MS) cache.delete(key);
    }

    const lastSeen = cache.get(fingerprint);
    if (lastSeen && now - lastSeen <= SIGNAL_DEDUP_WINDOW_MS) {
      return false;
    }

    cache.set(fingerprint, now);
    if (cache.size > SIGNAL_DEDUP_CACHE_LIMIT) {
      const oldest = [...cache.entries()].sort((a, b) => a[1] - b[1]).slice(0, cache.size - SIGNAL_DEDUP_CACHE_LIMIT);
      for (const [key] of oldest) cache.delete(key);
    }
    this.recentSignalFingerprints.set(agentId, cache);
    return true;
  }

  processStdoutBuffer(runningAgent: RunningAgent): string[] {
    const lines: string[] = [];
    let newlineIdx: number;

    while ((newlineIdx = runningAgent.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = runningAgent.stdoutBuffer.slice(0, newlineIdx);
      runningAgent.stdoutBuffer = runningAgent.stdoutBuffer.slice(newlineIdx + 1);
      lines.push(line);
    }

    return lines;
  }

  sendInput(agentId: string, input: string, closeStdin = false): void {
    const resolvedId = this.resolveRuntimeId(agentId);
    const runningAgent = resolvedId ? this.agents.get(resolvedId) : undefined;
    if (!runningAgent) {
      throw new Error(`No running agent found: ${agentId}`);
    }

    const agent = this.getAgent(runningAgent.templateAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${runningAgent.templateAgentId}`);
    }
    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (typeDef && agentTypeUsesInlinePrompt(typeDef, runningAgent.sessionId)) {
      throw new Error(`Agent type ${agent.type} requires prompt delivery at spawn time`);
    }

    const prompt = truncatePrompt(input, agentId, this.db, "sendInput");

    runningAgent.stdin.write(prompt + "\n");
    runningAgent.stdin.flush();

    if (closeStdin) {
      runningAgent.stdin.end();
    }
  }

  appendSyntheticOutput(agentId: string, data: string, options: SyntheticOutputOptions = {}): void {
    const resolvedId = this.resolveRuntimeId(agentId);
    const runningAgent = resolvedId ? this.agents.get(resolvedId) : undefined;
    if (!runningAgent) {
      throw new Error(`No running agent found: ${agentId}`);
    }

    const stream = options.stream ?? "stdout";
    runningAgent.outputSequence++;
    const seq = runningAgent.outputSequence;

    this.db
      .prepare(
        "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runningAgent.id, runningAgent.spawnSessionId, stream, data, seq);

    eventBus.emit("agent:output", {
      agentId: runningAgent.id,
      stream,
      data,
      sequence: seq,
    });
  }

  killAgent(agentId: string): boolean {
    const resolvedId = this.resolveRuntimeId(agentId);
    const runningAgent = resolvedId ? this.agents.get(resolvedId) : undefined;
    if (!runningAgent) return false;

    runningAgent.process.kill();
    return true;
  }

  // Kill an agent AND every subprocess it spawned. Agents are spawned detached
  // (their own process group, pid===pgid), so signalling the negative pgid hits
  // the whole tree. SIGTERM first for graceful exit handlers, then a SIGKILL
  // sweep after a grace period for anything that ignored it. Falls back to the
  // positive pid for any legacy non-detached process.
  killAgentTree(agentId: string): boolean {
    const resolvedId = this.resolveRuntimeId(agentId);
    const runningAgent = resolvedId ? this.agents.get(resolvedId) : undefined;
    if (!runningAgent) return false;
    const pid = runningAgent.process.pid;
    if (!pid) {
      runningAgent.process.kill();
      return true;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }, KILL_TREE_GRACE_MS);
    return true;
  }

  private handleProcessExit(agentId: string, processPid: number, code: number): void {
    if (this.closed) return;

    const runtime = this.agents.get(agentId);
    if (runtime && runtime.process.pid !== processPid) {
      logError(this.db, "agent.pid_mismatch_exit", {
        agentId,
        exitedPid: processPid,
        currentPid: runtime.process.pid,
        method: "handleProcessExit",
      }, new Error("Process exit from stale PID ignored"));
      return;
    }

    this.persistSessionId(agentId);

    const runningAgent = this.agents.get(agentId);
    const stderrSnippet = runningAgent?.stderrBuffer
      ? runningAgent.stderrBuffer.slice(-1024)
      : "";

    // Check if this is a respawn exit
    const isRespawn = this.respawningAgents.has(agentId);
    if (isRespawn) {
      this.respawningAgents.delete(agentId);
    }

    // Clean up in-memory tracking
    this.agents.delete(agentId);
    this.recentSignalFingerprints.delete(agentId);

    // Clean up any temp MCP config files written at spawn time
    if (runtime?.mcpCleanupPaths?.length) {
      cleanupMcpTempFiles(runtime.mcpCleanupPaths);
    }

    if (runtime) {
      const instances = this.templateToInstances.get(runtime.templateAgentId);
      if (instances) {
        instances.delete(agentId);
        if (instances.size === 0) this.templateToInstances.delete(runtime.templateAgentId);
      }

      // Skip DB updates for respawns — the same instance ID will be reused
      // when the new process is spawned, so we don't want to mark it as
      // completed/failed in the brief window before the respawn.
      if (!isRespawn) {
        this.syncTemplateRuntimeState(runtime.templateAgentId);
        try {
          this.db
            .prepare(
              "UPDATE agent_instances SET status = ?, process_pid = NULL, state_metadata = json_set(state_metadata, '$.exit_code', ?), updated_at = datetime('now') WHERE id = ?",
            )
            .run(code === 0 ? "completed" : "failed", code, agentId);
        } catch (err) {
          if (this.closed) return;
          logError(this.db, "agent.update_instance_on_exit", { agentId }, err);
        }
        if (runtime.taskId) {
          eventBus.emit("instance:state_changed", {
            instanceId: runtime.id,
            templateAgentId: runtime.templateAgentId,
            taskId: runtime.taskId,
            parentInstanceId: runtime.parentInstanceId,
            rootInstanceId: runtime.rootInstanceId,
            status: code === 0 ? "completed" : "failed",
          });
        }
      }
    }

    // Check if this agent has an active delegation as parent
    let hasDelegation = false;
    try {
      const row = this.db
        .prepare(
          "SELECT 1 FROM delegations WHERE parent_instance_id = ? AND status IN ('pending', 'running') LIMIT 1",
        )
        .get(agentId);
      hasDelegation = !!row;
    } catch (err) {
      logError(this.db, "agent.check_delegation", { agentId }, err);
    }

    // Emit exit event
    eventBus.emit("agent:exit", {
      agentId,
      code,
      isRespawn,
      hasDelegation,
      stderrSnippet,
    });
  }

  private syncTemplateRuntimeState(templateAgentId: string): void {
    try {
      const runtimeIds = this.templateToInstances.get(templateAgentId);
      if (runtimeIds && runtimeIds.size > 0) {
        const first = this.agents.get(Array.from(runtimeIds)[0]);
        this.db
          .prepare("UPDATE agents SET process_pid = ?, status = 'busy' WHERE id = ?")
          .run(first?.process.pid ?? null, templateAgentId);
      } else {
        // When no instances are running, the template agent goes idle.
        // "error" status is only set by explicit orchestration failures
        // (e.g., spawn failures), not by process exit codes — delegated
        // agents routinely exit with non-zero codes on kill/resume.
        // NOTE: Do NOT clear current_task_id here — the ManagerDaemon's
        // handleAgentExit needs it to route the exit event to the correct
        // task. Clearing it here causes a race where handleAgentExit finds
        // current_task_id = NULL and silently drops the exit, leaving the
        // task orphaned. The ManagerDaemon clears current_task_id after
        // processing the exit.
        this.db
          .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
          .run(templateAgentId);
      }
    } catch (err) {
      logError(this.db, "agent.sync_template_runtime_state", { templateAgentId }, err);
    }
  }

  private persistSessionId(agentId: string): void {
    const runningAgent = this.agents.get(agentId);
    if (!runningAgent?.sessionId) return;

    try {
      // Only write per-instance. agent_states is keyed by template id, which
      // would collide across parallel tasks running the same template.
      this.db
        .prepare(
          "UPDATE agent_instances SET session_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(runningAgent.sessionId, agentId);
    } catch (err) {
      logError(this.db, "agent.persist_session_id", { agentId }, err);
    }
  }

  /**
   * Look up the most recent session_id for the entrypoint (or any template
   * agent) on a SPECIFIC task. Use this instead of `getSessionId(templateId)`
   * when you need a task-scoped session — otherwise two parallel tasks
   * running the same template would return whichever instance's session_id
   * was last cached, corrupting cross-task resume.
   */
  getEntrypointSessionIdForTask(taskId: string, templateAgentId: string): string | null {
    try {
      const row = this.db
        .prepare(
          `SELECT session_id FROM agent_instances
           WHERE task_id = ? AND template_agent_id = ? AND session_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(taskId, templateAgentId) as { session_id: string | null } | null;
      return row?.session_id ?? null;
    } catch (err) {
      logError(this.db, "agent.get_entrypoint_session_id_for_task", { taskId, templateAgentId }, err);
      return null;
    }
  }

  getSessionId(agentId: string): string | null {
    // session_id is per-instance. Look up only by the runtime instance id —
    // NEVER fall back to a template-id lookup, because two parallel tasks
    // running the same template (e.g. "skipper") would otherwise collide and
    // hand one task the sibling task's claude session.
    const runningAgent = this.agents.get(agentId);
    if (runningAgent?.sessionId) {
      return runningAgent.sessionId;
    }

    try {
      const instanceRow = this.db
        .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
        .get(agentId) as { session_id: string | null } | null;
      return instanceRow?.session_id ?? null;
    } catch (err) {
      logError(this.db, "agent.get_session_id", { agentId }, err);
      return null;
    }
  }

  clearSessionId(agentId: string): void {
    const runningAgent = this.agents.get(agentId);
    if (runningAgent) {
      runningAgent.sessionId = null;
    }
    try {
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state, state_metadata)
           VALUES (?, 'stopped', '{}')
           ON CONFLICT(agent_id) DO UPDATE SET
             state_metadata = json_remove(state_metadata, '$.session_id', '$.context_compact_needed', '$.context_compact_reason', '$.context_compact_marked_at', '$.last_input_tokens'),
             updated_at = datetime('now')`,
        )
        .run(this.getTemplateAgentId(agentId) ?? agentId);
    } catch (err) {
      logError(this.db, "agent.clear_session_id", { agentId }, err);
    }
  }

  private getPersistedRuntimeState(runtimeId: string): PersistedRuntimeState | null {
    const row = this.db
      .prepare(
        `SELECT task_id, parent_instance_id, root_instance_id, attempt
         FROM agent_instances
         WHERE id = ?`,
      )
      .get(runtimeId) as {
        task_id: string | null;
        parent_instance_id: string | null;
        root_instance_id: string | null;
        attempt: number | null;
      } | null;
    if (!row) return null;
    return {
      taskId: row.task_id ?? null,
      parentInstanceId: row.parent_instance_id ?? null,
      rootInstanceId: row.root_instance_id ?? runtimeId,
      attempt: row.attempt ?? 1,
    };
  }

  async sendResumeMessage(agentId: string, message: string, closeStdin = false): Promise<void> {
    return this.withResumeLock(agentId, () => this.sendResumeMessageUnlocked(agentId, message, closeStdin));
  }

  private async sendResumeMessageUnlocked(agentIdInput: string, message: string, closeStdin = false): Promise<void> {
    const agentId = this.resolveRuntimeId(agentIdInput) ?? agentIdInput;
    const templateAgentId = this.getTemplateAgentId(agentId) ?? agentIdInput;
    const agent = this.getAgent(templateAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef || !typeDef.supports_resume) {
      throw new Error(`Agent type ${agent.type} does not support resume`);
    }

    // For runtime instances, always load persisted state so resume-respawn
    // preserves metadata like delegation retry attempt counters.
    const persistedRuntime = agentId !== templateAgentId
      ? this.getPersistedRuntimeState(agentId)
      : null;

    const compactState = this.getContextCompactionState(agentId);
    if (compactState.needed) {
      const runtimeBeforeKill = this.agents.get(agentId);
      if (this.agents.has(agentId)) {
        this.respawningAgents.add(agentId);
        this.killAgent(agentId);
        await this.waitForExit(agentId);
      }

      const snapshot = this.buildContextCompactionSnapshot(agentId);
      const compactedMessage = `[SYSTEM] Context compaction was triggered due to large history. Continue from this compacted state.\n\n${snapshot}\n\n${message}`;
      const usesInlineCompact = agentTypeUsesInlinePrompt(typeDef);
      const inlineCompactPrompt = usesInlineCompact ? compactedMessage : undefined;

      const workingDir = process.cwd();
      if (runtimeBeforeKill && runtimeBeforeKill.id !== runtimeBeforeKill.templateAgentId) {
        await this.spawnAgentInstance(runtimeBeforeKill.templateAgentId, runtimeBeforeKill.id, {
          workingDir,
          initialPrompt: inlineCompactPrompt,
          taskId: runtimeBeforeKill.taskId,
          parentInstanceId: runtimeBeforeKill.parentInstanceId,
          rootInstanceId: runtimeBeforeKill.rootInstanceId,
          attempt: persistedRuntime?.attempt ?? 1,
        });
      } else if (persistedRuntime && agentId !== templateAgentId) {
        await this.spawnAgentInstance(templateAgentId, agentId, {
          workingDir,
          initialPrompt: inlineCompactPrompt,
          taskId: persistedRuntime.taskId,
          parentInstanceId: persistedRuntime.parentInstanceId,
          rootInstanceId: persistedRuntime.rootInstanceId,
          attempt: persistedRuntime.attempt,
        });
      } else {
        await this.spawnAgent(templateAgentId, { workingDir, initialPrompt: inlineCompactPrompt });
      }

      if (!usesInlineCompact) {
        this.sendInput(agentId, compactedMessage, closeStdin);
      }
      this.writeContextCompactionCheckpoint(agentId, compactState.lastInputTokens, snapshot);
      this.clearContextCompactionFlag(agentId);
      return;
    }

    const sessionId = this.getSessionId(agentId);
    if (!sessionId) {
      throw new Error(`No session ID available for agent: ${agentId}`);
    }

    const runtimeBeforeKill = this.agents.get(agentId);

    // Kill current process if running (with respawn guard)
    if (this.agents.has(agentId)) {
      this.respawningAgents.add(agentId);
      this.killAgent(agentId);
      await this.waitForExit(agentId);
    }

    // Proactive compaction: truncate large messages before sending
    let compactedMessage = message;
    if (message.length > RESUME_COMPACT_CHARS) {
      compactedMessage = compactResumeMessage(message, RESUME_COMPACT_CHARS);
      logError(this.db, "agent.resume_proactive_compact", {
        agentId,
        originalChars: message.length,
        compactedChars: compactedMessage.length,
        method: "sendResumeMessage",
      });
    }

    // For agent types whose resume_args contain {{prompt}}, the message must be
    // delivered as an inline prompt at spawn time (not via stdin afterwards).
    const usesInlineInResume = agentTypeUsesInlinePrompt(typeDef, sessionId);
    const inlinePromptForResume = usesInlineInResume ? compactedMessage : undefined;

    // Spawn new process with --resume
    const workingDir = process.cwd();
    if (runtimeBeforeKill && runtimeBeforeKill.id !== runtimeBeforeKill.templateAgentId) {
      await this.spawnAgentInstance(runtimeBeforeKill.templateAgentId, runtimeBeforeKill.id, {
        workingDir,
        sessionId,
        initialPrompt: inlinePromptForResume,
        taskId: runtimeBeforeKill.taskId,
        parentInstanceId: runtimeBeforeKill.parentInstanceId,
        rootInstanceId: runtimeBeforeKill.rootInstanceId,
        attempt: persistedRuntime?.attempt ?? 1,
      });
    } else if (persistedRuntime && agentId !== templateAgentId) {
      await this.spawnAgentInstance(templateAgentId, agentId, {
        workingDir,
        sessionId,
        initialPrompt: inlinePromptForResume,
        taskId: persistedRuntime.taskId,
        parentInstanceId: persistedRuntime.parentInstanceId,
        rootInstanceId: persistedRuntime.rootInstanceId,
        attempt: persistedRuntime.attempt,
      });
    } else {
      await this.spawnAgent(templateAgentId, { workingDir, sessionId, initialPrompt: inlinePromptForResume });
    }

    // Send message via stdin for agents that don't use inline prompts
    if (!usesInlineInResume) {
      this.sendInput(agentId, compactedMessage, closeStdin);
    }
  }

  private async withResumeLock<T>(runtimeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resumeLocks.get(runtimeId) ?? Promise.resolve();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.resumeLocks.set(runtimeId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.resumeLocks.get(runtimeId) === queued) {
        this.resumeLocks.delete(runtimeId);
      }
    }
  }

  // --- Output parsing and signal detection ---

  parseAgentOutput(agentId: string, line: string): ParsedSignal {
    const base = { agentId, raw: line };

    // 1. JSON detection
    if (line.startsWith("{")) {
      try {
        const json = JSON.parse(line) as JsonEvent;
        return this.handleJsonOutput(agentId, json, line);
      } catch (err) {
        logError(this.db, "agent.parse_json_output", { agentId, line: line.slice(0, 200) }, err);
      }
    }

    // 2. Agent message: [MSG:type to:AgentName] content
    const msgMatch = line.match(SIGNAL_PATTERNS.message);
    if (msgMatch) {
      return { ...base, type: "message", messageType: msgMatch[1], targetAgent: msgMatch[2], content: msgMatch[3] };
    }

    // 3. Delegation complete: [DELEGATE_COMPLETE] result
    const delCompleteMatch = line.match(SIGNAL_PATTERNS.delegateComplete);
    if (delCompleteMatch) {
      return { ...base, type: "delegate_complete", content: delCompleteMatch[1] };
    }

    // 4. Conversation signals (only acted upon for conversation agents — guarded in handleAgentSignal)
    const convCreateTaskMatch = line.trim().match(SIGNAL_PATTERNS.conversationCreateTask);
    if (convCreateTaskMatch) {
      return { ...base, type: "conversation_create_task", content: line.trim() };
    }
    const convTaskStatusMatch = line.trim().match(SIGNAL_PATTERNS.conversationTaskStatus);
    if (convTaskStatusMatch) {
      return { ...base, type: "conversation_task_status", content: line.trim() };
    }
    const convSteerMatch = line.trim().match(SIGNAL_PATTERNS.conversationSteer);
    if (convSteerMatch) {
      return { ...base, type: "conversation_steer", content: line.trim() };
    }
    const convTaskNoteMatch = line.trim().match(SIGNAL_PATTERNS.conversationTaskNote);
    if (convTaskNoteMatch) {
      return { ...base, type: "conversation_task_note", content: line.trim() };
    }
    if (SIGNAL_PATTERNS.conversationQueryTasks.test(line.trim())) {
      return { ...base, type: "conversation_query_tasks" };
    }
    const convQueryTaskMatch = line.trim().match(SIGNAL_PATTERNS.conversationQueryTask);
    if (convQueryTaskMatch) {
      return { ...base, type: "conversation_query_task", content: line.trim() };
    }

    // 5. Default: plain text
    return { ...base, type: "text" };
  }

  handleJsonOutput(agentId: string, json: JsonEvent, raw: string): ParsedSignal {
    const runningAgent = this.agents.get(agentId);

    // Capture resume session identifier for --resume support.
    // Codex uses `thread_id`; Claude-style payloads may use `session_id`.
    const resumeSessionId = json.session_id ?? json.thread_id ?? json.sessionID;
    if (resumeSessionId && runningAgent && !runningAgent.sessionId) {
      runningAgent.sessionId = resumeSessionId;
      // Persist eagerly so session_id survives server crashes
      this.persistSessionId(agentId);
    }

    // Extract text and check for embedded signals
    const text = extractTextFromJsonEvent(json);
    if (text) {
      const embeddedSignals = detectAllSignalsInText(agentId, text);
      // Note: delegation and phase-complete CAN coexist in resumed sessions
      // (delegation from previous turn, phase-complete from current turn).
      // Delegation dedup via shouldEmitSignal prevents re-processing old delegations.
      if (embeddedSignals.length > 0) {
        const [first, ...rest] = embeddedSignals;
        if (rest.length > 0) {
          this.queuedSignals.set(agentId, rest.map((signal) => ({ ...signal, raw, jsonEvent: json })));
        }
        return { ...first, raw, jsonEvent: json };
      }
    }

    const base = { agentId, raw, type: "json" as const, jsonEvent: json };

    // Usage/token tracking is provider-specific and allowlisted (claude-code only
    // for now). Gate every usage-recording write on this so we never mis-parse a
    // provider whose frame shape we haven't verified. Context-compaction detection
    // stays ungated — it's operational, not usage reporting.
    const usageTracked = providerSupportsUsageTracking(this.getAgentProviderType(agentId));

    // Handle by event type
    switch (json.type) {
      case "item.completed":
        // Codex agent messages, reasoning, tool calls
        return { ...base, content: text ?? undefined };

      case "turn.completed":
        // Codex turn completion with usage stats
        if (typeof json.usage?.input_tokens === "number" && json.usage.input_tokens >= this.contextCompactThreshold) {
          this.markContextCompactionNeeded(agentId, json.usage.input_tokens);
        }
        if (usageTracked && json.usage) {
          this.accumulateTokens(agentId, {
            input: json.usage.input_tokens,
            output: json.usage.output_tokens,
            cacheRead: json.usage.cached_input_tokens,
          });
        }
        return { ...base, content: text ?? undefined };

      case "message":
        // Older codex format
        return { ...base, content: text ?? undefined };

      case "assistant":
        // Claude Code assistant responses
        if (usageTracked && json.message?.usage) {
          this.accumulateTokens(agentId, {
            input: json.message.usage.input_tokens,
            output: json.message.usage.output_tokens,
            cacheCreation: json.message.usage.cache_creation_input_tokens,
            cacheRead: json.message.usage.cache_read_input_tokens,
          });
        }
        // Register internal sub-agents at spawn time: an Agent/Task tool_use block
        // means this instance launched its own sub-agent (Explore, general-purpose,
        // …) that Skipper's delegation graph never sees. Recording it here makes the
        // count exact even if the sub-agent fails before emitting any usage frame.
        if (usageTracked && Array.isArray(json.message?.content)) {
          for (const block of json.message.content) {
            if (block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
              this.recordSubagentSpawn(agentId, block);
            }
          }
        }
        return { ...base, content: text ?? undefined };

      case "result":
        // Claude Code final result
        return { ...base, content: json.result ?? text ?? undefined };

      case "text":
        // OpenCode text content
        return { ...base, content: text ?? undefined };

      case "step_start":
        // OpenCode step start — session tracking handled above
        return base;

      case "step_finish":
        // OpenCode step finish with token usage
        if (typeof json.part?.tokens?.input === "number" && json.part.tokens.input >= this.contextCompactThreshold) {
          this.markContextCompactionNeeded(agentId, json.part.tokens.input);
        }
        if (usageTracked && json.part?.tokens) {
          this.accumulateTokens(agentId, {
            input: json.part.tokens.input,
            output: json.part.tokens.output,
          });
        }
        return { ...base, content: text ?? undefined };

      case "system":
        // task_progress frames carry a running (CUMULATIVE) token total for an
        // internal sub-agent, keyed by its tool_use_id. recordSubagentUsage takes
        // MAX per id so re-emitted frames never double-count. Other system frames ignored.
        if (usageTracked && json.subtype === "task_progress" && json.tool_use_id) {
          this.recordSubagentUsage(agentId, json);
        }
        return base;
      case "rate_limit_event":
        // Silently ignored
        return base;

      case "error":
        return { ...base, content: json.error?.message ?? "Unknown error" };

      default:
        // Background events, config dumps
        return { ...base, content: text ?? undefined };
    }
  }

  private accumulateTokens(
    agentId: string,
    delta: { input?: number; output?: number; cacheCreation?: number; cacheRead?: number },
  ): void {
    const input = delta.input ?? 0;
    const output = delta.output ?? 0;
    const cacheCreation = delta.cacheCreation ?? 0;
    const cacheRead = delta.cacheRead ?? 0;
    if (input === 0 && output === 0 && cacheCreation === 0 && cacheRead === 0) return;
    try {
      this.db
        .prepare(
          `UPDATE agent_instances
           SET input_tokens = COALESCE(input_tokens, 0) + ?,
               output_tokens = COALESCE(output_tokens, 0) + ?,
               cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + ?,
               cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
               updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(input, output, cacheCreation, cacheRead, agentId);
    } catch (err) {
      logError(this.db, "agent.accumulate_tokens", { agentId, delta }, err);
    }
  }

  /**
   * Resolve an agent's provider type (e.g. "claude-code") from the running-agent
   * record, falling back to a cached DB lookup (covers restart / test paths where
   * the agent isn't tracked in memory). Used to gate provider-specific usage parsing.
   */
  private getAgentProviderType(agentId: string): string | undefined {
    const running = this.getRunningAgent(agentId);
    if (running) return running.providerType;
    const cached = this.providerTypeCache.get(agentId);
    if (cached !== undefined) return cached;
    try {
      const row = this.db
        .prepare("SELECT a.type FROM agent_instances ai JOIN agents a ON a.id = ai.template_agent_id WHERE ai.id = ?")
        .get(agentId) as { type: string } | undefined;
      if (row?.type) {
        this.providerTypeCache.set(agentId, row.type);
        return row.type;
      }
    } catch { /* agents table may be unavailable in some contexts — skip */ }
    return undefined;
  }

  /**
   * Register (or refresh) an internal sub-agent at spawn time from an Agent/Task
   * tool_use block. Upsert on tool_use_id so it composes with the usage writer;
   * COALESCE keeps whichever writer arrives first from being clobbered.
   */
  private recordSubagentSpawn(
    agentId: string,
    block: { id?: string; input?: { subagent_type?: string; description?: string } },
  ): void {
    if (!block.id) return;
    try {
      this.db
        .prepare(
          `INSERT INTO subagent_usage (tool_use_id, agent_instance_id, task_id, subagent_type, description)
           VALUES (?, ?, (SELECT task_id FROM agent_instances WHERE id = ?), ?, ?)
           ON CONFLICT(tool_use_id) DO UPDATE SET
             subagent_type = COALESCE(subagent_type, excluded.subagent_type),
             description    = COALESCE(description, excluded.description),
             updated_at     = datetime('now')`,
        )
        .run(block.id, agentId, agentId, block.input?.subagent_type ?? null, block.input?.description ?? null);
    } catch (err) {
      logError(this.db, "agent.subagent_spawn", { agentId, toolUseId: block.id }, err);
    }
  }

  /**
   * Record an internal sub-agent's usage from a `system/task_progress` frame.
   * total_tokens is cumulative-monotonic per tool_use_id, so we take MAX rather
   * than sum — this is exactly what prevents the stream-frame double-count.
   */
  private recordSubagentUsage(
    agentId: string,
    json: { tool_use_id?: string; subagent_type?: string; last_tool_name?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number } },
  ): void {
    const id = json.tool_use_id;
    if (!id) return;
    const usage = json.usage ?? {};
    try {
      this.db
        .prepare(
          `INSERT INTO subagent_usage (tool_use_id, agent_instance_id, task_id, subagent_type, total_tokens, tool_uses, duration_ms, last_tool_name)
           VALUES (?, ?, (SELECT task_id FROM agent_instances WHERE id = ?), ?, ?, ?, ?, ?)
           ON CONFLICT(tool_use_id) DO UPDATE SET
             subagent_type  = COALESCE(subagent_type, excluded.subagent_type),
             total_tokens   = MAX(total_tokens, excluded.total_tokens),
             tool_uses      = excluded.tool_uses,
             duration_ms    = excluded.duration_ms,
             last_tool_name = excluded.last_tool_name,
             updated_at     = datetime('now')`,
        )
        .run(id, agentId, agentId, json.subagent_type ?? null, usage.total_tokens ?? 0, usage.tool_uses ?? null, usage.duration_ms ?? null, json.last_tool_name ?? null);
    } catch (err) {
      logError(this.db, "agent.subagent_usage", { agentId, toolUseId: id }, err);
    }
  }

  private markContextCompactionNeeded(agentId: string, inputTokens: number): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state, state_metadata)
           VALUES (?, 'working', json_object(
             'context_compact_needed', 1,
             'context_compact_reason', 'input_tokens_threshold',
             'last_input_tokens', ?,
             'context_compact_marked_at', datetime('now')
           ))
           ON CONFLICT(agent_id) DO UPDATE SET
             state_metadata = json_set(
               state_metadata,
               '$.context_compact_needed', 1,
               '$.context_compact_reason', 'input_tokens_threshold',
               '$.last_input_tokens', ?,
               '$.context_compact_marked_at', datetime('now')
             ),
             updated_at = datetime('now')`,
        )
        .run(agentId, inputTokens, inputTokens);
    } catch (err) {
      logError(this.db, "agent.mark_context_compaction", { agentId, inputTokens }, err);
    }
  }

  private getContextCompactionState(agentId: string): { needed: boolean; lastInputTokens: number | null } {
    try {
      const row = this.db
        .prepare(
          `SELECT
             COALESCE(json_extract(state_metadata, '$.context_compact_needed'), 0) as needed,
             json_extract(state_metadata, '$.last_input_tokens') as last_input_tokens
           FROM agent_states
           WHERE agent_id = ?`,
        )
        .get(agentId) as { needed: number; last_input_tokens: number | null } | null;

      return {
        needed: !!row?.needed,
        lastInputTokens: row?.last_input_tokens ?? null,
      };
    } catch (err) {
      logError(this.db, "agent.get_context_compaction_state", { agentId }, err);
      return { needed: false, lastInputTokens: null };
    }
  }

  private clearContextCompactionFlag(agentId: string): void {
    try {
      this.db
        .prepare(
          `UPDATE agent_states
           SET state_metadata = json_remove(state_metadata, '$.context_compact_needed', '$.context_compact_reason', '$.context_compact_marked_at', '$.last_input_tokens'),
               updated_at = datetime('now')
           WHERE agent_id = ?`,
        )
        .run(agentId);
    } catch (err) {
      logError(this.db, "agent.clear_context_compaction", { agentId }, err);
    }
  }

  private buildContextCompactionSnapshot(agentId: string): string {
    const agentRow = this.db
      .prepare("SELECT name, current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { name: string; current_task_id: string | null } | null;

    if (!agentRow?.current_task_id) {
      return "COMPACTED CONTEXT\n- No active task is currently assigned.";
    }

    const task = this.db
      .prepare(
        "SELECT id, title, description, status, current_phase FROM tasks WHERE id = ?",
      )
      .get(agentRow.current_task_id) as {
        id: string;
        title: string;
        description: string | null;
        status: string;
        current_phase: number;
      } | null;

    if (!task) {
      return "COMPACTED CONTEXT\n- Active task reference is missing.";
    }

    const notes = this.db
      .prepare(
        `SELECT tn.content, a.name as agent_name
         FROM task_notes tn
         JOIN agents a ON a.id = tn.agent_id
         WHERE tn.task_id = ?
         ORDER BY tn.created_at DESC
         LIMIT 8`,
      )
      .all(task.id) as { content: string; agent_name: string }[];

    const delegations = this.db
      .prepare(
        `SELECT parent_agent_id, child_agent_id, status, substr(COALESCE(result, ''), 1, 180) as result_excerpt
         FROM delegations
         WHERE task_id = ?
         ORDER BY created_at DESC
         LIMIT 5`,
      )
      .all(task.id) as { parent_agent_id: string; child_agent_id: string; status: string; result_excerpt: string }[];

    const lines: string[] = [];
    lines.push("COMPACTED CONTEXT");
    lines.push(`- Agent: ${agentRow.name}`);
    lines.push(`- Task: ${task.title} (${task.id})`);
    lines.push(`- Status: ${task.status} | Current phase index: ${task.current_phase}`);
    if (task.description) {
      lines.push(`- Task description: ${task.description.slice(0, 500)}`);
    }
    if (notes.length > 0) {
      lines.push("");
      lines.push("Recent notes:");
      for (const note of notes.reverse()) {
        lines.push(`- [${note.agent_name}] ${note.content.slice(0, 260)}`);
      }
    }
    if (delegations.length > 0) {
      lines.push("");
      lines.push("Recent delegations:");
      for (const d of delegations.reverse()) {
        const excerpt = d.result_excerpt?.trim() ? ` | result: ${d.result_excerpt}` : "";
        lines.push(`- ${d.parent_agent_id} -> ${d.child_agent_id} (${d.status})${excerpt}`);
      }
    }
    lines.push("");
    lines.push("Continue from this snapshot and prioritize forward progress. Do not restate prior history unless necessary.");
    return lines.join("\n");
  }

  private writeContextCompactionCheckpoint(agentId: string, inputTokens: number | null, snapshot: string): void {
    try {
      const row = this.db
        .prepare("SELECT current_task_id FROM agents WHERE id = ?")
        .get(agentId) as { current_task_id: string | null } | null;
      const taskId = row?.current_task_id;
      if (!taskId) return;

      const sequenceRow = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM task_checkpoints WHERE task_id = ?")
        .get(taskId) as { next_seq: number };

      const sessionId = this.getSessionId(agentId);
      const snapshotJson = JSON.stringify({
        reason: "context_compaction",
        input_tokens: inputTokens,
        excerpt: snapshot.slice(0, 4000),
      });

      this.db
        .prepare(
          `INSERT INTO task_checkpoints (task_id, sequence, checkpoint_type, session_id, context_snapshot)
           VALUES (?, ?, 'CONTEXT_COMPACTION', ?, ?)`,
        )
        .run(taskId, sequenceRow.next_seq, sessionId, snapshotJson);
    } catch (err) {
      logError(this.db, "agent.write_context_compaction_checkpoint", { agentId }, err);
    }
  }

  // --- CRUD methods (existing) ---

  createAgent(input: CreateAgentInput): Agent {
    const typeDef = getAgentTypeDefinition(input.type, this.db);
    if (!typeDef) {
      throw new Error(`Unknown agent type: ${input.type}`);
    }

    const id = crypto.randomUUID();
    const config: AgentConfig = {};
    if (input.instruction) config.instruction = input.instruction;
    if (input.model) config.model = input.model;

    this.db
      .prepare(
        `INSERT INTO agents (id, name, type, model, config, capabilities)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.type,
        input.model ?? "default",
        JSON.stringify(config),
        JSON.stringify(input.capabilities ?? []),
      );

    return this.getAgent(id)!;
  }

  getAgent(id: string): Agent | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(id) as AgentRow | null;
    if (!row) return null;
    return rowToAgent(row);
  }

  listAgents(): Agent[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY created_at")
      .all() as AgentRow[];
    return rows.map((row) => rowToAgent(row));
  }

  updateAgent(id: string, input: UpdateAgentInput): Agent {
    const agent = this.getAgent(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }

    if (agent.status === "busy") {
      throw new Error("Cannot edit a busy agent");
    }

    const typeDef = getAgentTypeDefinition(input.type, this.db);
    if (!typeDef) {
      throw new Error(`Unknown agent type: ${input.type}`);
    }

    const config: AgentConfig = { ...agent.config };
    if (input.instruction && input.instruction.trim()) {
      config.instruction = input.instruction.trim();
    } else {
      delete config.instruction;
    }
    if (input.model && input.model.trim()) {
      config.model = input.model.trim();
    } else {
      delete config.model;
    }

    this.db
      .prepare(
        `UPDATE agents
         SET name = ?, type = ?, model = ?, config = ?, capabilities = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.name.trim(),
        input.type.trim(),
        input.model?.trim() ? input.model.trim() : "default",
        JSON.stringify(config),
        JSON.stringify(input.capabilities ?? agent.capabilities),
        id,
      );

    return this.getAgent(id)!;
  }

  deleteAgent(id: string): boolean {
    const agent = this.getAgent(id);
    if (!agent) return false;

    if (agent.status === "busy") {
      throw new Error("Cannot delete a busy agent");
    }

    // Clean up team memberships
    this.db
      .prepare("DELETE FROM team_agents WHERE agent_id = ?")
      .run(id);

    // Clear entrypoint references
    this.db
      .prepare(
        "UPDATE teams SET entrypoint_agent_id = NULL WHERE entrypoint_agent_id = ?",
      )
      .run(id);

    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    return true;
  }
}

// --- Standalone utility functions ---

export function extractTextFromJsonEvent(json: JsonEvent): string | null {
  // Claude Code: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
  if (json.message?.content && Array.isArray(json.message.content)) {
    const texts = json.message.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    if (texts.length > 0) return texts.join("\n");
  }

  // Codex CLI: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
  if (json.item?.text) {
    return json.item.text;
  }

  // Codex item with content array
  if (json.item?.content && Array.isArray(json.item.content)) {
    const texts = json.item.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    if (texts.length > 0) return texts.join("\n");
  }

  // OpenCode: {"type":"text","part":{"text":"..."}}
  if (json.part?.text) {
    return json.part.text;
  }

  // Result events: {"type":"result","result":"..."}
  if (typeof json.result === "string") {
    return json.result;
  }

  return null;
}

export function detectAllSignalsInText(agentId: string, text: string): ParsedSignal[] {
  const signals: ParsedSignal[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Delegation complete (multi-line accumulation)
    const delCompleteMatch = trimmed.match(SIGNAL_PATTERNS.delegateComplete);
    if (delCompleteMatch) {
      const contentLines: string[] = [];
      if (delCompleteMatch[1]) {
        contentLines.push(delCompleteMatch[1]);
      }
      let j = i + 1;
      while (j < lines.length) {
        const nextRaw = lines[j];
        const nextTrimmed = nextRaw.trim();
        if (nextTrimmed && isSignalStart(nextTrimmed)) break;
        contentLines.push(nextRaw);
        j += 1;
      }
      signals.push({
        type: "delegate_complete",
        agentId,
        raw: trimmed,
        content: contentLines.join("\n").trim(),
      });
      i = j - 1;
      continue;
    }

    // Conversation signals (single-line, guarded in handleAgentSignal)
    if (SIGNAL_PATTERNS.conversationCreateTask.test(trimmed)) {
      signals.push({ type: "conversation_create_task", agentId, raw: trimmed, content: trimmed });
      continue;
    }
    if (SIGNAL_PATTERNS.conversationTaskStatus.test(trimmed)) {
      signals.push({ type: "conversation_task_status", agentId, raw: trimmed, content: trimmed });
      continue;
    }
    if (SIGNAL_PATTERNS.conversationSteer.test(trimmed)) {
      signals.push({ type: "conversation_steer", agentId, raw: trimmed, content: trimmed });
      continue;
    }
    if (SIGNAL_PATTERNS.conversationTaskNote.test(trimmed)) {
      signals.push({ type: "conversation_task_note", agentId, raw: trimmed, content: trimmed });
      continue;
    }
    if (SIGNAL_PATTERNS.conversationQueryTasks.test(trimmed)) {
      signals.push({ type: "conversation_query_tasks", agentId, raw: trimmed });
      continue;
    }
    if (SIGNAL_PATTERNS.conversationQueryTask.test(trimmed)) {
      signals.push({ type: "conversation_query_task", agentId, raw: trimmed, content: trimmed });
      continue;
    }
  }

  return signals;
}

export function detectSignalsInText(agentId: string, text: string): ParsedSignal | null {
  const all = detectAllSignalsInText(agentId, text);
  return all.length > 0 ? all[0] : null;
}

/**
 * Truncate a string to fit within a byte limit without splitting multi-byte characters.
 * Cuts at the last newline boundary before the limit to avoid mid-line truncation.
 */
export function truncateToByteLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;

  // Binary search for the character index that fits within maxBytes
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  // Avoid splitting a surrogate pair: if we landed on a low surrogate, step back
  if (low > 0 && low < text.length) {
    const code = text.charCodeAt(low - 1);
    if (code >= 0xD800 && code <= 0xDBFF) {
      low--;
    }
  }

  let truncated = text.slice(0, low);

  // Try to cut at the last newline to avoid mid-line truncation
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > truncated.length * 0.8) {
    truncated = truncated.slice(0, lastNewline);
  }

  return truncated;
}

/**
 * Compact a resume message to fit within a character limit.
 * First tries to truncate delegation result content specifically,
 * then falls back to truncating the entire message.
 */
export function compactResumeMessage(message: string, maxChars: number): string {
  if (message.length <= maxChars) return message;

  // Try to truncate just the delegation payload portion (single result, then batch result).
  const compactSingle = compactTaggedSection(message, DELEGATION_RESULT_START, DELEGATION_RESULT_END, maxChars);
  if (compactSingle) return compactSingle;
  const compactBatch = compactTaggedSection(message, DELEGATION_BATCH_RESULT_START, DELEGATION_BATCH_RESULT_END, maxChars);
  if (compactBatch) return compactBatch;

  // Fallback: truncate the entire message
  return message.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function compactTaggedSection(message: string, startPattern: RegExp, endMarker: string, maxChars: number): string | null {
  const startMatch = message.match(startPattern);
  const endIdx = message.indexOf(endMarker);
  if (!startMatch || endIdx <= 0) return null;

  const headerEnd = startMatch.index! + startMatch[0].length;
  const prefix = message.slice(0, headerEnd);
  const suffix = message.slice(endIdx); // includes end marker
  const overhead = prefix.length + suffix.length + TRUNCATION_MARKER.length;
  const availableForResult = maxChars - overhead;
  if (availableForResult <= 0) return null;

  const resultContent = message.slice(headerEnd, endIdx);
  const truncatedResult = resultContent.slice(0, availableForResult);
  const lastNewline = truncatedResult.lastIndexOf("\n");
  const cleanCut = lastNewline > truncatedResult.length * 0.5
    ? truncatedResult.slice(0, lastNewline)
    : truncatedResult;
  const compacted = prefix + cleanCut + TRUNCATION_MARKER + suffix;
  return compacted.length <= maxChars ? compacted : null;
}
