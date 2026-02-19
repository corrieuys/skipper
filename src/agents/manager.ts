import type { Database } from "bun:sqlite";
import type { Subprocess, FileSink } from "bun";
import { getDb } from "../db/connection";
import { getAgentTypeDefinition } from "./types";
import { eventBus } from "../events/bus";

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

export class AgentManager {
  private db: Database;
  private agents: Map<string, RunningAgent> = new Map();
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
        } catch {
          // DB may be closed during test teardown
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
    // Clean up in-memory tracking
    this.agents.delete(agentId);

    // Update DB status (guard against closed DB in tests)
    try {
      const newStatus = code === 0 ? "idle" : "error";
      this.db
        .prepare("UPDATE agents SET process_pid = NULL, status = ? WHERE id = ?")
        .run(newStatus, agentId);
    } catch {
      // DB may be closed during test teardown
    }

    // Emit exit event
    eventBus.emit("agent:exit", {
      agentId,
      code,
      isRespawn: false,
      hasDelegation: false,
    });
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
