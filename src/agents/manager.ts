import type { Database } from "bun:sqlite";
import type { Subprocess, FileSink } from "bun";
import { getDb } from "../db/connection";
import { getAgentTypeDefinition } from "./types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";
import { logError } from "../db/log-error";

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
  goal?: string;
  model?: string;
  environment?: Record<string, string>;
  constraints?: Record<string, string>;
}

export interface RunningAgent {
  id: string;
  process: Subprocess<"pipe", "pipe", "pipe">;
  stdin: FileSink;
  stdoutBuffer: string;
  stderrBuffer: string;
  outputSequence: number;
  sessionId: string | null;
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
  goal?: string;
}

export interface SpawnAgentOptions {
  workingDir: string;
  sessionId?: string;
}

// --- Signal types for output parsing ---

export type SignalType =
  | "message"
  | "delegate"
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
  message?: { content?: Array<{ type: string; text?: string }> };
  item?: { type?: string; text?: string; content?: Array<{ type: string; text?: string }> };
  result?: string;
  error?: { message?: string };
  [key: string]: unknown;
}

// Signal regex patterns
const SIGNAL_PATTERNS = {
  message: /^\[MSG:(\S+)\s+to:(\S+)\]\s*(.*)/,
  delegate: /^\[DELEGATE\s+to:(\S+)\]\s*(.*)/,
  delegateComplete: /^\[DELEGATE_COMPLETE\]\s*(.*)/,
  escalate: /^\[ESCALATE\]\s*(.*)/,
  note: /^\[NOTE\]\s*(.*)/,
  taskComplete: /^\[TASK_COMPLETE\s+task:(\S+)\]\s*(.*)/,
  phaseComplete: /^\[PHASE_COMPLETE\]/,
  phaseRegression: /^\[PHASE_REGRESSION\s+(\d+)\]\s*(.*)/,
} as const;

export class AgentManager {
  private db: Database;
  private agents: Map<string, RunningAgent> = new Map();
  private respawningAgents: Set<string> = new Set();
  private decoder = new TextDecoder();

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  getRunningAgent(id: string): RunningAgent | undefined {
    return this.agents.get(id);
  }

  getRunningAgents(): Map<string, RunningAgent> {
    return this.agents;
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
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef) {
      throw new Error(`Unknown agent type: ${agent.type}`);
    }

    // Build command args
    const args = [...typeDef.args];
    if (options.sessionId && typeDef.supports_resume && typeDef.resume_flag) {
      args.push(...typeDef.resume_flag.split(" "), options.sessionId);
    }
    if (agent.model !== "default" && typeDef.model_flag) {
      args.push(typeDef.model_flag, agent.model);
    }

    // Prepare environment
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (agent.config.environment) {
      Object.assign(env, agent.config.environment);
    }
    env.AGENT_ID = agentId;
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

    const runningAgent: RunningAgent = {
      id: agentId,
      process: proc,
      stdin: proc.stdin,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: options.sessionId ?? null,
      drainedStreams: 0,
    };

    // Track in memory
    this.agents.set(agentId, runningAgent);

    // Update DB with PID
    this.db
      .prepare("UPDATE agents SET process_pid = ?, status = 'busy' WHERE id = ?")
      .run(proc.pid, agentId);

    // Clear old terminal outputs
    this.db
      .prepare("DELETE FROM terminal_outputs WHERE agent_id = ?")
      .run(agentId);

    // Wire output handlers
    this.readStream(runningAgent, proc.stdout, "stdout");
    this.readStream(runningAgent, proc.stderr, "stderr");

    // Register exit handler
    proc.exited.then((code) => {
      this.handleProcessExit(agentId, code);
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
          this.db
            .prepare(
              "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, ?, ?, ?)",
            )
            .run(runningAgent.id, streamType, text, seq);
        } catch (err) {
          logError(this.db, "terminal_output_insert_failed", { agentId: runningAgent.id }, err);
        }

        // Emit event for real-time UI
        eventBus.emit("agent:output", {
          agentId: runningAgent.id,
          stream: streamType,
          data: text,
          sequence: seq,
        });

        // Buffer stdout for line-based parsing
        if (streamType === "stdout") {
          runningAgent.stdoutBuffer += text;
          this.processStdoutBuffer(runningAgent);
        } else {
          runningAgent.stderrBuffer += text;
        }
      }
    } catch (err) {
      // Stream closed or errored - expected on process exit
    } finally {
      reader.releaseLock();
      runningAgent.drainedStreams++;
      if (runningAgent.drainedStreams >= 2) {
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

    runningAgent.stdin.write(input + "\n");
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

  private handleProcessExit(agentId: string, code: number): void {
    // Persist session ID before removing from memory
    this.persistSessionId(agentId);

    // Check if this is a respawn exit
    const isRespawn = this.respawningAgents.has(agentId);
    if (isRespawn) {
      this.respawningAgents.delete(agentId);
    }

    // Clean up in-memory tracking
    this.agents.delete(agentId);

    // Update DB status (guard against closed DB in tests)
    try {
      const newStatus = code === 0 ? "idle" : "error";
      this.db
        .prepare("UPDATE agents SET process_pid = NULL, status = ? WHERE id = ?")
        .run(newStatus, agentId);
    } catch (err) {
      logError(this.db, "agent_exit_status_update_failed", { agentId }, err);
    }

    // Emit exit event
    eventBus.emit("agent:exit", {
      agentId,
      code,
      isRespawn,
      hasDelegation: false,
    });
  }

  private persistSessionId(agentId: string): void {
    const runningAgent = this.agents.get(agentId);
    if (!runningAgent?.sessionId) return;

    try {
      // Upsert into agent_states with session_id in state_metadata
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state, state_metadata)
           VALUES (?, 'stopped', json_object('session_id', ?))
           ON CONFLICT(agent_id) DO UPDATE SET
             state_metadata = json_set(state_metadata, '$.session_id', ?),
             updated_at = datetime('now')`,
        )
        .run(agentId, runningAgent.sessionId, runningAgent.sessionId);
    } catch (err) {
      logError(this.db, "session_id_persist_failed", { agentId }, err);
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
      const row = this.db
        .prepare(
          "SELECT json_extract(state_metadata, '$.session_id') as session_id FROM agent_states WHERE agent_id = ?",
        )
        .get(agentId) as { session_id: string | null } | null;
      return row?.session_id ?? null;
    } catch (err) {
      logError(this.db, "session_id_fetch_failed", { agentId }, err);
      return null;
    }
  }

  async sendResumeMessage(agentId: string, message: string, closeStdin = false): Promise<void> {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef || !typeDef.supports_resume) {
      throw new Error(`Agent type ${agent.type} does not support resume`);
    }

    const sessionId = this.getSessionId(agentId);
    if (!sessionId) {
      throw new Error(`No session ID available for agent: ${agentId}`);
    }

    // Kill current process if running (with respawn guard)
    if (this.agents.has(agentId)) {
      this.respawningAgents.add(agentId);
      this.killAgent(agentId);
      await this.waitForExit(agentId);
    }

    // Spawn new process with --resume
    const workingDir = process.cwd();
    await this.spawnAgent(agentId, { workingDir, sessionId });

    // Send message
    this.sendInput(agentId, message, closeStdin);
  }

  // --- Output parsing and signal detection ---

  parseAgentOutput(agentId: string, line: string): ParsedSignal {
    const base = { agentId, raw: line };

    // 1. JSON detection
    if (line.startsWith("{")) {
      try {
        const json = JSON.parse(line) as JsonEvent;
        return this.handleJsonOutput(agentId, json, line);
      } catch {
        // Not valid JSON, fall through
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
      return { ...base, type: "delegate", targetAgent: delMatch[1], content: delMatch[2] };
    }

    // 4. Delegation complete: [DELEGATE_COMPLETE] result
    const delCompleteMatch = line.match(SIGNAL_PATTERNS.delegateComplete);
    if (delCompleteMatch) {
      return { ...base, type: "delegate_complete", content: delCompleteMatch[1] };
    }

    // 5. Escalation: [ESCALATE] question
    const escMatch = line.match(SIGNAL_PATTERNS.escalate);
    if (escMatch) {
      return { ...base, type: "escalate", content: escMatch[1] };
    }

    // 6. Task note: [NOTE] content
    const noteMatch = line.match(SIGNAL_PATTERNS.note);
    if (noteMatch) {
      return { ...base, type: "note", content: noteMatch[1] };
    }

    // 7. Task complete: [TASK_COMPLETE task:<id>] result
    const taskMatch = line.match(SIGNAL_PATTERNS.taskComplete);
    if (taskMatch) {
      return { ...base, type: "task_complete", taskId: taskMatch[1], content: taskMatch[2] };
    }

    // 8. Phase complete: [PHASE_COMPLETE]
    if (SIGNAL_PATTERNS.phaseComplete.test(line)) {
      return { ...base, type: "phase_complete" };
    }

    // 8b. Phase regression: [PHASE_REGRESSION N] reason
    const regMatch = line.match(SIGNAL_PATTERNS.phaseRegression);
    if (regMatch) {
      return { ...base, type: "phase_regression", targetPhase: parseInt(regMatch[1], 10), reason: regMatch[2] };
    }

    // 9. Default: plain text
    return { ...base, type: "text" };
  }

  handleJsonOutput(agentId: string, json: JsonEvent, raw: string): ParsedSignal {
    const runningAgent = this.agents.get(agentId);

    // Capture session_id for --resume support
    if (json.session_id && runningAgent && !runningAgent.sessionId) {
      runningAgent.sessionId = json.session_id;
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

  // --- CRUD methods (existing) ---

  createAgent(input: CreateAgentInput): Agent {
    const typeDef = getAgentTypeDefinition(input.type, this.db);
    if (!typeDef) {
      throw new Error(`Unknown agent type: ${input.type}`);
    }

    const id = crypto.randomUUID();
    const config: AgentConfig = {};
    if (input.goal) config.goal = input.goal;
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
      return { type: "delegate", agentId, raw: trimmed, targetAgent: delMatch[1], content: delMatch[2] };
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
