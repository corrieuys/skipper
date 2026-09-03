import type { Database } from "bun:sqlite";
import {
  eventBus,
  type AgentExitEvent,
  type AgentOutputEvent,
  type TaskStateChangedEvent,
} from "../events/bus";
import type { ClientMessage, OutputBatchEntry } from "./protocol";
import { fetchTaskOutputPage } from "../data/queries";

export interface OutputTailOptions {
  /** Trailing flush window for buffered output. */
  flushMs: number;
  /** Flush early once a task buffer holds this many entries. */
  maxEntries: number;
  /** Flush early once a task buffer holds this many bytes of data. */
  maxBytes: number;
  /**
   * How many recent terminal-output lines to replay in the one-shot backfill
   * frame sent on subscribe. 0 disables backfill (live-only, the old behaviour).
   */
  backfillEntries: number;
  /**
   * Byte budget for the backfill frame's `data` fields. Rows are taken newest-
   * first until the budget is spent, so a task whose recent frames are huge
   * backfills fewer rows rather than pushing a multi-MB frame to a phone.
   */
  backfillMaxBytes: number;
}

const DEFAULT_OPTIONS: OutputTailOptions = {
  flushMs: 1_500,
  maxEntries: 50,
  maxBytes: 32_768,
  backfillEntries: 200,
  backfillMaxBytes: 1_000_000,
};

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "deleted"]);

interface AgentInfo {
  taskId: string;
  agentName: string | null;
}

/**
 * Streams live agent output to the connect integrator, but only for tasks a
 * remote consumer has subscribed to (the server sends output_subscribe /
 * output_unsubscribe on 0→1 / 1→0 consumer transitions). Output is coalesced
 * per task into output_batch frames so a chatty agent costs at most one frame
 * per flush window. Detaches from the bus entirely while nothing is
 * subscribed - zero cost in the common case.
 */
export class OutputTailManager {
  private subscribed = new Set<string>();
  private buffers = new Map<string, OutputBatchEntry[]>();
  private bufferBytes = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seqs = new Map<string, number>();
  /** agent instance id → owning task + template agent name (null = unknown instance). */
  private agentInfo = new Map<string, AgentInfo | null>();
  private attached = false;

  private readonly onOutput = (event: AgentOutputEvent) => this.handleOutput(event);
  private readonly onExit = (event: AgentExitEvent) => {
    this.agentInfo.delete(event.agentId);
  };
  private readonly onTaskState = (event: TaskStateChangedEvent) => {
    if (!TERMINAL_TASK_STATUSES.has(event.newStatus)) return;
    if (!this.subscribed.has(event.taskId)) return;
    // Final flush so the last lines land, then stop tailing: the DO and
    // consumers drop their subscriptions off the same task:state_changed event.
    this.flush(event.taskId);
    this.drop(event.taskId);
  };

  private opts: OutputTailOptions;

  constructor(
    private db: Database,
    private sender: (frame: string) => void,
    opts: Partial<OutputTailOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  handleSubscribe(taskId: string): void {
    if (!taskId || this.subscribed.has(taskId)) return;
    this.subscribed.add(taskId);
    // Attach before replaying history: both run synchronously with no yield
    // between them and agent:output fires synchronously, so a line is either
    // already in terminal_outputs (→ backfill) or arrives after attach (→ live),
    // never both and never lost. The backfill frame is sent synchronously here,
    // ahead of the first live flush (which waits for the timer / thresholds).
    this.attach();
    this.sendBackfill(taskId);
  }

  /**
   * One-shot replay of a task's recent terminal output, sent immediately on
   * subscribe so the integrator seeds its timeline without a separate read and
   * without the read-then-subscribe gap. Marked `backfill: true`; skipped when
   * disabled (backfillEntries = 0) or the task has no output yet.
   */
  private sendBackfill(taskId: string): void {
    if (this.opts.backfillEntries <= 0) return;
    const all = fetchTaskOutputPage(this.db, taskId, { limit: this.opts.backfillEntries });
    if (all.length === 0) return;

    // Newest-first (so the LIMIT keeps the most recent N). Spend the byte
    // budget from the newest end — always at least one row — then replay
    // oldest-first so the integrator appends in chronological order.
    const rows: typeof all = [];
    let bytes = 0;
    for (const r of all) {
      bytes += r.data.length;
      if (rows.length > 0 && bytes > this.opts.backfillMaxBytes) break;
      rows.push(r);
    }
    const entries: OutputBatchEntry[] = rows.reverse().map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      agentName: r.agent_name ?? null,
      stream: r.stream === "stderr" ? "stderr" : "stdout",
      data: r.data,
      ts: r.created_at,
    }));

    const seq = (this.seqs.get(taskId) ?? 0) + 1;
    this.seqs.set(taskId, seq);
    const frame: ClientMessage = { type: "output_batch", taskId, seq, entries, backfill: true };
    try {
      this.sender(JSON.stringify(frame));
    } catch {
      // sender failures must not break the subscribe path
    }
  }

  handleUnsubscribe(taskId: string): void {
    this.drop(taskId);
  }

  /** Drop all subscriptions, buffers, and bus listeners (WS closed). */
  reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.buffers.clear();
    this.bufferBytes.clear();
    this.subscribed.clear();
    this.seqs.clear();
    this.agentInfo.clear();
    this.detach();
  }

  destroy(): void {
    this.reset();
  }

  private drop(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    this.buffers.delete(taskId);
    this.bufferBytes.delete(taskId);
    this.subscribed.delete(taskId);
    if (this.subscribed.size === 0) this.detach();
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    eventBus.on("agent:output", this.onOutput);
    eventBus.on("agent:exit", this.onExit);
    eventBus.on("task:state_changed", this.onTaskState);
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    eventBus.off("agent:output", this.onOutput);
    eventBus.off("agent:exit", this.onExit);
    eventBus.off("task:state_changed", this.onTaskState);
  }

  private resolveAgent(agentId: string): AgentInfo | null {
    if (this.agentInfo.has(agentId)) return this.agentInfo.get(agentId) ?? null;
    const row = this.db
      .prepare(
        `SELECT ai.task_id, a.name AS agent_name
         FROM agent_instances ai
         LEFT JOIN agents a ON a.id = ai.template_agent_id
         WHERE ai.id = ?`,
      )
      .get(agentId) as { task_id: string; agent_name: string | null } | null;
    const info = row ? { taskId: row.task_id, agentName: row.agent_name ?? null } : null;
    this.agentInfo.set(agentId, info);
    return info;
  }

  private handleOutput(event: AgentOutputEvent): void {
    const info = this.resolveAgent(event.agentId);
    if (!info || !this.subscribed.has(info.taskId)) return;

    const entry: OutputBatchEntry = {
      agentId: event.agentId,
      agentName: info.agentName,
      stream: event.stream,
      data: event.data,
      ts: new Date().toISOString(),
    };

    const buffer = this.buffers.get(info.taskId) ?? [];
    buffer.push(entry);
    this.buffers.set(info.taskId, buffer);
    const bytes = (this.bufferBytes.get(info.taskId) ?? 0) + event.data.length;
    this.bufferBytes.set(info.taskId, bytes);

    if (buffer.length >= this.opts.maxEntries || bytes >= this.opts.maxBytes) {
      this.flush(info.taskId);
      return;
    }
    if (!this.timers.has(info.taskId)) {
      this.timers.set(
        info.taskId,
        setTimeout(() => this.flush(info.taskId), this.opts.flushMs),
      );
    }
  }

  private flush(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);

    const entries = this.buffers.get(taskId);
    if (!entries || entries.length === 0) return;
    this.buffers.delete(taskId);
    this.bufferBytes.delete(taskId);

    const seq = (this.seqs.get(taskId) ?? 0) + 1;
    this.seqs.set(taskId, seq);

    const frame: ClientMessage = { type: "output_batch", taskId, seq, entries };
    try {
      this.sender(JSON.stringify(frame));
    } catch {
      // sender failures must not break the bus listener
    }
  }
}
