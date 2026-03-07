import type { Database } from "bun:sqlite";
import type { Subprocess, FileSink } from "bun";
import { getDb } from "../db/connection";
import { getAgentTypeDefinition } from "./types";
import { isSkipperAgent } from "./skipper";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";
import { logError } from "../logging";

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

// ~100KB prompt limit — leaves headroom for system prompt and conversation context
const MAX_PROMPT_BYTES = 100_000;
const TRUNCATION_MARKER = "\n\n[PROMPT TRUNCATED — original exceeded size limit. Work with the information above.]\n";

// Proactive compaction threshold for resume messages
const RESUME_COMPACT_CHARS = 200_000;

// Delegation result markers used by compactResumeMessage
const DELEGATION_RESULT_START = /\[DELEGATION_RESULT from:[^\]]+\]\n/;
const DELEGATION_RESULT_END = "\n[END_DELEGATION_RESULT]";

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
  taskId: string | null;
  parentInstanceId: string | null;
  rootInstanceId: string | null;
  process: Subprocess<"pipe", "pipe", "pipe">;
  stdin: FileSink;
  stdoutBuffer: string;
  stderrBuffer: string;
  outputSequence: number;
  sessionId: string | null;
  spawnSessionId: string;
  drainedStreams: number;
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

export interface SpawnAgentOptions {
  workingDir: string;
  sessionId?: string;
}

export interface SpawnAgentInstanceOptions extends SpawnAgentOptions {
  taskId?: string | null;
  parentInstanceId?: string | null;
  rootInstanceId?: string | null;
  attempt?: number;
}

// --- Signal types for output parsing ---

export type SignalType =
  | "message"
  | "delegate"
  | "delegate_batch"
  | "delegate_complete"
  | "escalate"
  | "note"
  | "task_complete"
  | "phase_complete"
  | "phase_regression"
  | "json"
  | "text";

export interface ParsedSignal {
  type: SignalType;
  agentId: string;
  raw: string;
  // Signal-specific fields
  messageType?: string;
  targetAgent?: string;
  content?: string;
  taskId?: string;
  targetPhase?: number;
  reason?: string;
  jsonEvent?: JsonEvent;
}

export interface JsonEvent {
  type?: string;
  session_id?: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  message?: { content?: Array<{ type: string; text?: string }> };
  item?: { type?: string; text?: string; content?: Array<{ type: string; text?: string }> };
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

// Signal regex patterns
const SIGNAL_PATTERNS = {
  message: /^\[MSG:(\S+)\s+to:(\S+)\]\s*(.*)/,
  delegate: /^\[DELEGATE\s+to:(.+?)\]\s*(.*)/,
  delegateBatch: /^\[DELEGATE_BATCH\]\s*(.*)/,
  delegateComplete: /^\[DELEGATE_COMPLETE\]\s*(.*)/,
  escalate: /^\[ESCALATE\]\s*(.*)/,
  note: /^\[NOTE\]\s*(.*)/,
  taskComplete: /^\[TASK_COMPLETE\s+task:(\S+)\]\s*(.*)/,
  phaseComplete: /^\[PHASE_COMPLETE\]/,
  phaseRegression: /^\[PHASE_REGRESSION\s+(\d+)\]\s*(.*)/,
} as const;

function normalizeSignalTarget(target: string): string {
  const trimmed = target.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export class AgentManager {
  private db: Database;
  private agents: Map<string, RunningAgent> = new Map();
  private templateToInstances: Map<string, Set<string>> = new Map();
  private respawningAgents: Set<string> = new Set();
  private closed = false;
  private decoder = new TextDecoder();
  private contextCompactThreshold = parseContextCompactThreshold(process.env.PLAYHIVE_CONTEXT_COMPACT_THRESHOLD);

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  getRunningAgent(id: string): RunningAgent | undefined {
    return this.agents.get(id);
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
    for (const [id, agent] of this.agents) {
      try { agent.process.kill(); } catch {}
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

  waitForExit(agentId: string, timeoutMs: number = 5000): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        eventBus.off("agent:exit", handler);
        resolve();
      }, timeoutMs);

      const handler = (event: AgentExitEvent) => {
        if (event.agentId === agentId) {
          clearTimeout(timer);
          eventBus.off("agent:exit", handler);
          resolve();
        }
      };

      eventBus.on("agent:exit", handler);

      // If agent already exited, resolve immediately
      if (!this.agents.has(agentId)) {
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
    return this.spawnRuntimeAgent(
      agentId,
      agentId,
      { ...options, parentInstanceId: null, rootInstanceId: agentId, attempt: 1 },
      true,
    );
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
    const existingRuntime = this.agents.get(runtimeId);
    if (existingRuntime) {
      this.killAgent(runtimeId);
      await this.waitForExit(runtimeId, 10000);

      const stillRunning = this.agents.get(runtimeId);
      if (stillRunning) {
        throw new Error(`Failed to replace running runtime: ${runtimeId}`);
      }
    }
    const agent = this.getAgent(templateAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${templateAgentId}`);
    }

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef) {
      throw new Error(`Unknown agent type: ${agent.type}`);
    }

    // Build command args
    const args = [...typeDef.args];
    if (options.sessionId && typeDef.supports_resume) {
      if (typeDef.resume_args && typeDef.resume_args.length > 0) {
        args.splice(
          0,
          args.length,
          ...typeDef.resume_args.map((arg) => arg.replaceAll("{{session_id}}", options.sessionId!)),
        );
      } else if (typeDef.resume_flag) {
        args.push(...typeDef.resume_flag.split(" "), options.sessionId);
      }
    }
    if (agent.model !== "default" && typeDef.model_flag) {
      args.push(typeDef.model_flag, agent.model);
    }

    // Prepare environment
    const env: Record<string, string> = { ...process.env as Record<string, string> };
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

    // Spawn the process
    const proc = Bun.spawn({
      cmd: [typeDef.command, ...args],
      cwd: options.workingDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

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
      taskId: options.taskId ?? null,
      parentInstanceId: options.parentInstanceId ?? null,
      rootInstanceId: options.rootInstanceId ?? runtimeId,
      process: proc,
      stdin: proc.stdin,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: options.sessionId ?? null,
      spawnSessionId,
      drainedStreams: 0,
    };

    // Track in memory
    this.agents.set(runtimeId, runningAgent);
    const templateInstances = this.templateToInstances.get(templateAgentId) ?? new Set<string>();
    templateInstances.add(runtimeId);
    this.templateToInstances.set(templateAgentId, templateInstances);

    this.syncTemplateRuntimeState(templateAgentId);
    if (!isTemplateRuntime && options.taskId) {
      this.db
        .prepare(
          `INSERT INTO agent_instances (
             id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, process_pid, session_id, state_metadata, attempt
           ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, '{}', ?)
           ON CONFLICT(id) DO UPDATE SET
             task_id = excluded.task_id,
             template_agent_id = excluded.template_agent_id,
             parent_instance_id = excluded.parent_instance_id,
             root_instance_id = excluded.root_instance_id,
             status = 'running',
             process_pid = excluded.process_pid,
             session_id = excluded.session_id,
             state_metadata = '{}',
             attempt = excluded.attempt,
             updated_at = datetime('now')`,
        )
        .run(
          runtimeId,
          options.taskId,
          templateAgentId,
          options.parentInstanceId ?? null,
          options.rootInstanceId ?? runtimeId,
          proc.pid,
          options.sessionId ?? null,
          options.attempt ?? 1,
        );
    } else if (isTemplateRuntime) {
      const taskRow = this.db
        .prepare("SELECT current_task_id FROM agents WHERE id = ?")
        .get(templateAgentId) as { current_task_id: string | null } | null;
      if (taskRow?.current_task_id) {
        this.db
          .prepare(
            `INSERT INTO agent_instances (
               id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, process_pid, session_id, state_metadata, attempt
             ) VALUES (?, ?, ?, NULL, ?, 'running', ?, ?, '{}', 1)
             ON CONFLICT(id) DO UPDATE SET
               task_id = excluded.task_id,
               template_agent_id = excluded.template_agent_id,
               status = 'running',
               process_pid = excluded.process_pid,
               session_id = excluded.session_id,
               state_metadata = '{}',
               updated_at = datetime('now')`,
          )
          .run(
            runtimeId,
            taskRow.current_task_id,
            templateAgentId,
            runtimeId,
            proc.pid,
            options.sessionId ?? null,
          );
      }
    }

    // Wire output handlers
    this.readStream(runningAgent, proc.stdout, "stdout");
    this.readStream(runningAgent, proc.stderr, "stderr");

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

        // Buffer stdout for line-based parsing and signal detection
        if (streamType === "stdout") {
          runningAgent.stdoutBuffer += text;
          if (runningAgent.stdoutBuffer.length > MAX_BUFFER_SIZE) {
            logError(this.db, "agent.stdout_buffer_overflow", { agentId: runningAgent.id, bufferSize: runningAgent.stdoutBuffer.length }, new Error("stdout buffer exceeded max size, truncating"));
            runningAgent.stdoutBuffer = runningAgent.stdoutBuffer.slice(-MAX_BUFFER_SIZE / 2);
          }
          const lines = this.processStdoutBuffer(runningAgent);
          for (const line of lines) {
            const signal = this.parseAgentOutput(runningAgent.id, line);
            if (signal.type !== "text" && signal.type !== "json") {
              eventBus.emit("agent:signal", {
                agentId: runningAgent.id,
                signalType: signal.type,
                content: signal.content,
                targetAgent: signal.targetAgent,
                taskId: signal.taskId,
                targetPhase: signal.targetPhase,
                reason: signal.reason,
              });
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
    const runningAgent = this.agents.get(agentId);
    if (!runningAgent) {
      throw new Error(`No running agent found: ${agentId}`);
    }

    let prompt = input;
    const byteLength = Buffer.byteLength(prompt, "utf-8");
    if (byteLength > MAX_PROMPT_BYTES) {
      logError(this.db, "agent.prompt_truncated", {
        agentId,
        originalBytes: byteLength,
        maxBytes: MAX_PROMPT_BYTES,
        method: "sendInput",
      });
      prompt = truncateToByteLimit(prompt, MAX_PROMPT_BYTES) + TRUNCATION_MARKER;
    }

    runningAgent.stdin.write(prompt + "\n");
    runningAgent.stdin.flush();

    if (closeStdin) {
      runningAgent.stdin.end();
    }
  }

  killAgent(agentId: string): boolean {
    const runningAgent = this.agents.get(agentId);
    if (!runningAgent) return false;

    runningAgent.process.kill();
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

    // Persist session ID before removing from memory
    this.persistSessionId(agentId);

    // Capture stderr snippet before cleanup (last 1KB for error detection)
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
    if (runtime) {
      const instances = this.templateToInstances.get(runtime.templateAgentId);
      if (instances) {
        instances.delete(agentId);
        if (instances.size === 0) this.templateToInstances.delete(runtime.templateAgentId);
      }
      this.syncTemplateRuntimeState(runtime.templateAgentId, code);
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

    // Check if this agent has an active delegation as parent
    let hasDelegation = false;
    try {
      const row = this.db
        .prepare(
          "SELECT 1 FROM delegations WHERE parent_agent_id = ? AND status IN ('pending', 'running') LIMIT 1",
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

  private syncTemplateRuntimeState(templateAgentId: string, lastExitCode: number = 0): void {
    try {
      const runtimeIds = this.templateToInstances.get(templateAgentId);
      if (runtimeIds && runtimeIds.size > 0) {
        const first = this.agents.get(Array.from(runtimeIds)[0]);
        this.db
          .prepare("UPDATE agents SET process_pid = ?, status = 'busy' WHERE id = ?")
          .run(first?.process.pid ?? null, templateAgentId);
      } else {
        this.db
          .prepare("UPDATE agents SET process_pid = NULL, status = ? WHERE id = ?")
          .run(lastExitCode === 0 ? "idle" : "error", templateAgentId);
      }
    } catch (err) {
      logError(this.db, "agent.sync_template_runtime_state", { templateAgentId, lastExitCode }, err);
    }
  }

  private persistSessionId(agentId: string): void {
    const runningAgent = this.agents.get(agentId);
    if (!runningAgent?.sessionId) return;

    try {
      this.db
        .prepare(
          "UPDATE agent_instances SET session_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(runningAgent.sessionId, agentId);

      // Upsert into agent_states with session_id in state_metadata
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state, state_metadata)
           VALUES (?, 'stopped', json_object('session_id', ?))
           ON CONFLICT(agent_id) DO UPDATE SET
             state_metadata = json_set(state_metadata, '$.session_id', ?),
             updated_at = datetime('now')`,
        )
        .run(runningAgent.templateAgentId || runningAgent.id, runningAgent.sessionId, runningAgent.sessionId);
    } catch (err) {
      logError(this.db, "agent.persist_session_id", { agentId }, err);
    }
  }

  getSessionId(agentId: string): string | null {
    // Memory-first: check running agent
    const runningAgent = this.agents.get(agentId);
    if (runningAgent?.sessionId) {
      return runningAgent.sessionId;
    }

    // DB-fallback: check agent_states
    try {
      const instanceRow = this.db
        .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
        .get(agentId) as { session_id: string | null } | null;
      if (instanceRow?.session_id) return instanceRow.session_id;

      const row = this.db
        .prepare(
          "SELECT json_extract(state_metadata, '$.session_id') as session_id FROM agent_states WHERE agent_id = ?",
        )
        .get(agentId) as { session_id: string | null } | null;
      return row?.session_id ?? null;
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

  async sendResumeMessage(agentId: string, message: string, closeStdin = false): Promise<void> {
    const templateAgentId = this.getTemplateAgentId(agentId) ?? agentId;
    const agent = this.getAgent(templateAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef || !typeDef.supports_resume) {
      throw new Error(`Agent type ${agent.type} does not support resume`);
    }

    const compactState = this.getContextCompactionState(agentId);
    if (compactState.needed) {
      const runtimeBeforeKill = this.agents.get(agentId);
      if (this.agents.has(agentId)) {
        this.respawningAgents.add(agentId);
        this.killAgent(agentId);
        await this.waitForExit(agentId);
      }

      const workingDir = process.cwd();
      if (runtimeBeforeKill && runtimeBeforeKill.id !== runtimeBeforeKill.templateAgentId) {
        await this.spawnAgentInstance(runtimeBeforeKill.templateAgentId, runtimeBeforeKill.id, {
          workingDir,
          taskId: runtimeBeforeKill.taskId,
          parentInstanceId: runtimeBeforeKill.parentInstanceId,
          rootInstanceId: runtimeBeforeKill.rootInstanceId,
        });
      } else {
        await this.spawnAgent(templateAgentId, { workingDir });
      }

      const snapshot = this.buildContextCompactionSnapshot(agentId);
      const compactedMessage = `[SYSTEM] Context compaction was triggered due to large history. Continue from this compacted state.\n\n${snapshot}\n\n${message}`;
      this.sendInput(agentId, compactedMessage, closeStdin);
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

    // Spawn new process with --resume
    const workingDir = process.cwd();
    if (runtimeBeforeKill && runtimeBeforeKill.id !== runtimeBeforeKill.templateAgentId) {
      await this.spawnAgentInstance(runtimeBeforeKill.templateAgentId, runtimeBeforeKill.id, {
        workingDir,
        sessionId,
        taskId: runtimeBeforeKill.taskId,
        parentInstanceId: runtimeBeforeKill.parentInstanceId,
        rootInstanceId: runtimeBeforeKill.rootInstanceId,
      });
    } else {
      await this.spawnAgent(templateAgentId, { workingDir, sessionId });
    }

    // Send message (sendInput applies byte-level truncation as a second safety net)
    this.sendInput(agentId, compactedMessage, closeStdin);
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

    // 3. Delegation: [DELEGATE to:<agent-id>] prompt
    const delMatch = line.match(SIGNAL_PATTERNS.delegate);
    if (delMatch) {
      return { ...base, type: "delegate", targetAgent: normalizeSignalTarget(delMatch[1]), content: delMatch[2] };
    }

    // 4. Delegation complete: [DELEGATE_COMPLETE] result
    const delBatchMatch = line.match(SIGNAL_PATTERNS.delegateBatch);
    if (delBatchMatch) {
      return { ...base, type: "delegate_batch", content: delBatchMatch[1] };
    }

    // 5. Delegation complete: [DELEGATE_COMPLETE] result
    const delCompleteMatch = line.match(SIGNAL_PATTERNS.delegateComplete);
    if (delCompleteMatch) {
      return { ...base, type: "delegate_complete", content: delCompleteMatch[1] };
    }

    // 6. Escalation: [ESCALATE] question
    const escMatch = line.match(SIGNAL_PATTERNS.escalate);
    if (escMatch) {
      return { ...base, type: "escalate", content: escMatch[1] };
    }

    // 7. Task note: [NOTE] content
    const noteMatch = line.match(SIGNAL_PATTERNS.note);
    if (noteMatch) {
      return { ...base, type: "note", content: noteMatch[1] };
    }

    // 8. Task complete: [TASK_COMPLETE task:<id>] result
    const taskMatch = line.match(SIGNAL_PATTERNS.taskComplete);
    if (taskMatch) {
      return { ...base, type: "task_complete", taskId: taskMatch[1], content: taskMatch[2] };
    }

    // 9. Phase complete: [PHASE_COMPLETE]
    if (SIGNAL_PATTERNS.phaseComplete.test(line)) {
      return { ...base, type: "phase_complete" };
    }

    // 9b. Phase regression: [PHASE_REGRESSION N] reason
    const regMatch = line.match(SIGNAL_PATTERNS.phaseRegression);
    if (regMatch) {
      return { ...base, type: "phase_regression", targetPhase: parseInt(regMatch[1], 10), reason: regMatch[2] };
    }

    // 10. Default: plain text
    return { ...base, type: "text" };
  }

  handleJsonOutput(agentId: string, json: JsonEvent, raw: string): ParsedSignal {
    const runningAgent = this.agents.get(agentId);

    // Capture resume session identifier for --resume support.
    // Codex uses `thread_id`; Claude-style payloads may use `session_id`.
    const resumeSessionId = json.session_id ?? json.thread_id;
    if (resumeSessionId && runningAgent && !runningAgent.sessionId) {
      runningAgent.sessionId = resumeSessionId;
      // Persist eagerly so session_id survives server crashes
      this.persistSessionId(agentId);
    }

    // Extract text and check for embedded signals
    const text = extractTextFromJsonEvent(json);
    if (text) {
      const embeddedSignal = detectSignalsInText(agentId, text);
      if (embeddedSignal) {
        return { ...embeddedSignal, raw, jsonEvent: json };
      }
    }

    const base = { agentId, raw, type: "json" as const, jsonEvent: json };

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
        return { ...base, content: text ?? undefined };

      case "message":
        // Older codex format
        return { ...base, content: text ?? undefined };

      case "assistant":
        // Claude Code assistant responses
        return { ...base, content: text ?? undefined };

      case "result":
        // Claude Code final result
        return { ...base, content: json.result ?? text ?? undefined };

      case "system":
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
        "SELECT id, title, description, status, current_phase, priority FROM tasks WHERE id = ?",
      )
      .get(agentRow.current_task_id) as {
        id: string;
        title: string;
        description: string | null;
        status: string;
        current_phase: number;
        priority: number;
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

    const artifacts = this.db
      .prepare(
        "SELECT name, type FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 5",
      )
      .all(task.id) as { name: string; type: string }[];

    const lines: string[] = [];
    lines.push("COMPACTED CONTEXT");
    lines.push(`- Agent: ${agentRow.name}`);
    lines.push(`- Task: ${task.title} (${task.id})`);
    lines.push(`- Status: ${task.status} | Priority: ${task.priority} | Current phase index: ${task.current_phase}`);
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
    if (artifacts.length > 0) {
      lines.push("");
      lines.push("Recent artifacts:");
      for (const a of artifacts.reverse()) {
        lines.push(`- ${a.name} (${a.type})`);
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
    return row ? rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY created_at")
      .all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  updateAgent(id: string, input: UpdateAgentInput): Agent {
    if (isSkipperAgent(id)) {
      throw new Error("Skipper is configured via /skipper");
    }

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
    if (isSkipperAgent(id)) {
      throw new Error("Skipper cannot be deleted");
    }

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

  // Result events: {"type":"result","result":"..."}
  if (typeof json.result === "string") {
    return json.result;
  }

  return null;
}

export function detectSignalsInText(agentId: string, text: string): ParsedSignal | null {
  // Scan each line of the extracted text for orchestrator signals
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for delegation
    const delMatch = trimmed.match(SIGNAL_PATTERNS.delegate);
    if (delMatch) {
      return { type: "delegate", agentId, raw: trimmed, targetAgent: normalizeSignalTarget(delMatch[1]), content: delMatch[2] };
    }

    const delBatchMatch = trimmed.match(SIGNAL_PATTERNS.delegateBatch);
    if (delBatchMatch) {
      return { type: "delegate_batch", agentId, raw: trimmed, content: delBatchMatch[1] };
    }

    // Check for delegation complete
    const delCompleteMatch = trimmed.match(SIGNAL_PATTERNS.delegateComplete);
    if (delCompleteMatch) {
      return { type: "delegate_complete", agentId, raw: trimmed, content: delCompleteMatch[1] };
    }

    // Check for escalation
    const escMatch = trimmed.match(SIGNAL_PATTERNS.escalate);
    if (escMatch) {
      return { type: "escalate", agentId, raw: trimmed, content: escMatch[1] };
    }

    // Check for note
    const noteMatch = trimmed.match(SIGNAL_PATTERNS.note);
    if (noteMatch) {
      return { type: "note", agentId, raw: trimmed, content: noteMatch[1] };
    }

    // Check for phase complete
    if (SIGNAL_PATTERNS.phaseComplete.test(trimmed)) {
      return { type: "phase_complete", agentId, raw: trimmed };
    }

    // Check for phase regression
    const regMatch = trimmed.match(SIGNAL_PATTERNS.phaseRegression);
    if (regMatch) {
      return { type: "phase_regression", agentId, raw: trimmed, targetPhase: parseInt(regMatch[1], 10), reason: regMatch[2] };
    }
  }

  return null;
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

  // Try to truncate just the delegation result portion
  const startMatch = message.match(DELEGATION_RESULT_START);
  const endIdx = message.indexOf(DELEGATION_RESULT_END);

  if (startMatch && endIdx > 0) {
    const headerEnd = startMatch.index! + startMatch[0].length;
    const prefix = message.slice(0, headerEnd);
    const suffix = message.slice(endIdx); // includes [END_DELEGATION_RESULT]
    const overhead = prefix.length + suffix.length + TRUNCATION_MARKER.length;
    const availableForResult = maxChars - overhead;

    if (availableForResult > 0) {
      const resultContent = message.slice(headerEnd, endIdx);
      const truncatedResult = resultContent.slice(0, availableForResult);
      // Cut at last newline to avoid mid-line truncation
      const lastNewline = truncatedResult.lastIndexOf("\n");
      const cleanCut = lastNewline > truncatedResult.length * 0.5
        ? truncatedResult.slice(0, lastNewline)
        : truncatedResult;
      const compacted = prefix + cleanCut + TRUNCATION_MARKER + suffix;
      if (compacted.length <= maxChars) return compacted;
    }
  }

  // Fallback: truncate the entire message
  return message.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
