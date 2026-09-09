import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { eventBus, type TaskNoteAddedEvent, type TaskMessagePostedEvent, type RealtimeTimelineUpdatedEvent } from "../events/bus";
import { isEmbedder, type Embedder, type EmbedderUnavailable } from "./embeddings";
import { taskMemorySummary, type TaskMemorySummary } from "./summary";
import { resolveMemoryScope, runLabelFor, seriesScopeId, taskScopeId, type MemoryScope } from "./scope";

/**
 * Per-task memory. When a task's memory scope is on (see scope.ts: a one-off
 * task's `memory_enabled`, or a recurring series' `memory_mode` of `run` /
 * `shared`), every operator-facing exchange on it is copied into `task_memory`
 * as it happens, keyed on the scope (`task:<id>` or `series:<id>`):
 *
 *   kind      source row                          author
 *   message   task_messages (post_message tool)   agent
 *   input     realtime_timeline 'text'            user
 *   summary   realtime_timeline 'summary'         user  (audio digest)
 *   note      task_notes                          agent | user (by source)
 *
 * The daemon writes it (bus listeners), never agents. Rows are embedded in the
 * background by whichever embedder the config page resolves; a row whose
 * embedding is missing, or was made under a different model, is (re)embedded on
 * the next flush and is invisible to queries until then.
 *
 * `query` is the agents' `query_task_memory` tool: nearest rows by cosine
 * (vectors are stored unit-length, so a dot product), returned in time order,
 * each with its id, timestamp and run so the agent can judge staleness. A
 * shared scope caps hits per run (`MAX_HITS_PER_RUN`) so one repeated line
 * from many runs cannot fill the result. `deleteEntry` is the agents'
 * `delete_task_memory` tool: a soft delete (kept for audit, hidden from
 * queries) that also leaves a note on the task saying what was removed and why.
 * Per-scope counts are small, so the scan is in JS with no vector extension.
 * `searchContent` is the separate keyword tool over notes, artifacts, or
 * messages; it needs no embeddings.
 */

export type MemoryKind = "message" | "input" | "summary" | "note";
export type MemoryAuthor = "agent" | "user";

export interface MemoryRecordInput {
  /** Owning scope (`task:<id>` / `series:<id>`). */
  scopeId: string;
  taskId: string;
  /** Run title + start, captured now so attribution survives run deletion. */
  runLabel: string | null;
  /** Series retention window; rows older than this are pruned after the insert. */
  retentionDays?: number;
  kind: MemoryKind;
  author: MemoryAuthor;
  agentId: string | null;
  content: string;
  /** Source row id; (task_id, ref_id) is unique so backfills are idempotent. */
  refId: string;
  /** Source row timestamp, so memory order matches the timeline. */
  createdAt: string;
}

export interface MemoryHit {
  id: string;
  kind: MemoryKind;
  author: MemoryAuthor;
  agent_id: string | null;
  agent_name: string | null;
  /** The run (task) the entry was recorded on; `this_run` marks the caller's own. */
  run: { id: string; label: string | null; this_run: boolean };
  content: string;
  created_at: string;
  score: number;
}

export interface MemoryQuery {
  taskId: string;
  query: string;
  limit?: number;
  author?: MemoryAuthor;
  kind?: MemoryKind;
  /** `series` (default when shared) searches every run; `run` only the caller's. */
  scope?: "run" | "series";
  /** Only entries at or after this timestamp. */
  since?: string;
  /** Only entries recorded on this run (task id). */
  runId?: string;
}

export interface DeleteMemoryInput {
  id: string;
  /** The calling run; the entry must be in its scope. */
  taskId: string;
  /** Template agent id of the caller (attribution on the row + the audit note). */
  agentId: string;
  reason: string;
}

export type ContentSource = "notes" | "artifacts" | "messages";

export interface ContentHit {
  id: string;
  source: ContentSource;
  author: MemoryAuthor;
  agent_id: string | null;
  agent_name: string | null;
  /** Artifacts only. */
  name?: string;
  version?: number;
  kind?: string;
  created_at: string;
  snippet: string;
  score: number;
}

export interface ContentSearch {
  taskId: string;
  source: ContentSource;
  query: string;
  limit?: number;
}

export interface TaskMemoryManagerOptions {
  resolveEmbedder: () => Embedder | EmbedderUnavailable;
  /** Delay before retrying after an embed failure (ms). */
  retryDelayMs?: number;
}

export const DEFAULT_QUERY_LIMIT = 10;
const MAX_QUERY_LIMIT = 50;
/** Shared scope: at most this many hits from one run, so ten mornings of "Started" cannot fill a result. */
export const MAX_HITS_PER_RUN = 3;
const EMBED_BATCH = 32;
const DEFAULT_RETRY_DELAY_MS = 30_000;

interface MemoryRow {
  id: string;
  task_id: string;
  run_label: string | null;
  kind: MemoryKind;
  author: MemoryAuthor;
  agent_id: string | null;
  agent_name: string | null;
  content: string;
  created_at: string;
  embedding: Uint8Array | null;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  const bytes = blob.byteOffset % 4 === 0 ? blob : new Uint8Array(blob);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Source tables stamp rows at different precisions (task_notes has
 * milliseconds, task_messages and realtime_timeline whole seconds), so memory
 * normalises every timestamp to `YYYY-MM-DD HH:MM:SS.mmm` UTC. Live records use
 * the daemon clock (the event fires right after the insert, so this is the true
 * order); a backfill keeps the source row's own time.
 */
export function normalizeTimestamp(value: string): string {
  const s = value.trim().replace("T", " ").replace(/Z$/, "");
  if (/\.\d{3}$/.test(s)) return s;
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(s);
  if (!m) return s;
  const frac = (m[2] ?? ".").slice(1).padEnd(3, "0").slice(0, 3);
  return `${m[1]}.${frac}`;
}

export function nowTimestamp(): string {
  return normalizeTimestamp(new Date().toISOString());
}

export function tokenizeQuery(query: string): string[] {
  return Array.from(new Set(
    query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2),
  ));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && count < 5) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Keyword score: every distinct term hit weighs most, repeats a little. Zero when no term matches. */
export function keywordScore(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const n = countOccurrences(lower, term);
    if (n > 0) score += 10 + n;
  }
  return score;
}

export function snippetAround(text: string, terms: string[], width = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  if (first === -1) return flat.slice(0, width) + "...";
  const start = Math.max(0, first - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return (start > 0 ? "..." : "") + flat.slice(start, end) + (end < flat.length ? "..." : "");
}

export class TaskMemoryManager {
  private db: Database;
  private resolveEmbedder: () => Embedder | EmbedderUnavailable;
  private retryDelayMs: number;
  private cleanup: Array<() => void> = [];
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmbedError: string | null = null;

  constructor(db: Database | undefined, options: TaskMemoryManagerOptions) {
    this.db = db ?? getDb();
    this.resolveEmbedder = options.resolveEmbedder;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  // ── lifecycle ──────────────────────────────────────────

  start(): void {
    if (this.cleanup.length > 0) return;
    const onNote = (e: TaskNoteAddedEvent) => this.safe(() => this.recordNote(e.noteId, nowTimestamp()));
    const onMessage = (e: TaskMessagePostedEvent) => this.safe(() => this.recordMessage(e.messageId, nowTimestamp()));
    const onTimeline = (e: RealtimeTimelineUpdatedEvent) => this.safe(() => this.recordTimelineEntry(e.entryId, nowTimestamp()));
    eventBus.on("task:note_added", onNote);
    eventBus.on("task:message_posted", onMessage);
    eventBus.on("realtime:timeline_updated", onTimeline);
    this.cleanup.push(
      () => eventBus.off("task:note_added", onNote),
      () => eventBus.off("task:message_posted", onMessage),
      () => eventBus.off("realtime:timeline_updated", onTimeline),
    );
    // Anything left unembedded by a previous run (server was down, model changed).
    this.scheduleFlush();
  }

  stop(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[task-memory] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── scope ──────────────────────────────────────────────

  scopeFor(taskId: string): MemoryScope {
    return resolveMemoryScope(this.db, taskId);
  }

  isEnabled(taskId: string): boolean {
    return this.scopeFor(taskId).scopeId !== null;
  }

  /** Last embedding failure, for the config page. Cleared by a successful flush. */
  getLastEmbedError(): string | null {
    return this.lastEmbedError;
  }

  // ── writes (daemon only) ───────────────────────────────

  record(input: MemoryRecordInput): boolean {
    const content = input.content.trim();
    if (!content) return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO task_memory (id, scope_id, task_id, run_label, kind, author, agent_id, content, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), input.scopeId, input.taskId, input.runLabel, input.kind, input.author, input.agentId, content, input.refId, normalizeTimestamp(input.createdAt));
    const inserted = result.changes > 0;
    if (inserted) {
      if (input.retentionDays && input.retentionDays > 0) this.prune(input.scopeId, input.retentionDays);
      this.scheduleFlush();
    }
    return inserted;
  }

  /** Scope + run label for a source row's task, or null when memory is off for it. */
  private target(taskId: string): { scopeId: string; runLabel: string | null; retentionDays: number } | null {
    const scope = this.scopeFor(taskId);
    if (!scope.scopeId) return null;
    return {
      scopeId: scope.scopeId,
      runLabel: scope.seriesId ? runLabelFor(this.db, taskId) : null,
      retentionDays: scope.retentionDays,
    };
  }

  /** Series retention: drop shared-scope rows older than the configured window. */
  prune(scopeId: string, retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const result = this.db
      .prepare("DELETE FROM task_memory WHERE scope_id = ? AND created_at < datetime('now', ?)")
      .run(scopeId, `-${retentionDays} days`);
    return result.changes;
  }

  /** `createdAt` overrides the source timestamp (live events pass the daemon clock). */
  recordNote(noteId: string, createdAt?: string): boolean {
    const row = this.db
      .prepare("SELECT id, task_id, agent_id, content, source, created_at, deleted_at FROM task_notes WHERE id = ?")
      .get(noteId) as { id: string; task_id: string; agent_id: string; content: string; source: string | null; created_at: string; deleted_at: string | null } | null;
    if (!row || row.deleted_at) return false;
    const target = this.target(row.task_id);
    if (!target) return false;
    const author: MemoryAuthor = row.source === "agent" || row.source === null ? "agent" : "user";
    return this.record({
      scopeId: target.scopeId,
      runLabel: target.runLabel,
      retentionDays: target.retentionDays,
      taskId: row.task_id,
      kind: "note",
      author,
      agentId: author === "agent" ? row.agent_id : null,
      content: row.content,
      refId: row.id,
      createdAt: createdAt ?? row.created_at,
    });
  }

  recordMessage(messageId: string, createdAt?: string): boolean {
    const row = this.db
      .prepare("SELECT id, task_id, agent_id, content, created_at FROM task_messages WHERE id = ?")
      .get(messageId) as { id: string; task_id: string; agent_id: string; content: string; created_at: string } | null;
    if (!row) return false;
    const target = this.target(row.task_id);
    if (!target) return false;
    return this.record({
      scopeId: target.scopeId,
      runLabel: target.runLabel,
      retentionDays: target.retentionDays,
      taskId: row.task_id,
      kind: "message",
      author: "agent",
      agentId: row.agent_id,
      content: row.content,
      refId: row.id,
      createdAt: createdAt ?? row.created_at,
    });
  }

  /** Only operator text input and audio summaries; images, files, and errors are not memory. */
  recordTimelineEntry(entryId: string, createdAt?: string): boolean {
    const row = this.db
      .prepare("SELECT id, task_id, entry_type, content, created_at FROM realtime_timeline WHERE id = ?")
      .get(entryId) as { id: string; task_id: string; entry_type: string; content: string; created_at: string } | null;
    if (!row) return false;
    if (row.entry_type !== "text" && row.entry_type !== "summary") return false;
    const target = this.target(row.task_id);
    if (!target) return false;
    return this.record({
      scopeId: target.scopeId,
      runLabel: target.runLabel,
      retentionDays: target.retentionDays,
      taskId: row.task_id,
      kind: row.entry_type === "text" ? "input" : "summary",
      author: "user",
      agentId: null,
      content: row.content,
      refId: row.id,
      createdAt: createdAt ?? row.created_at,
    });
  }

  /**
   * Copy everything already on the task into memory (toggle turned on
   * mid-task). For a shared series scope this covers every run of the series
   * still in the database. Idempotent: rows already present are skipped by the
   * unique (scope_id, ref_id) index. Returns the number of new rows.
   */
  backfill(taskId: string): number {
    const scope = this.scopeFor(taskId);
    if (!scope.scopeId) return 0;
    if (scope.mode === "shared" && scope.seriesId) return this.backfillSeries(scope.seriesId);
    return this.backfillTask(taskId);
  }

  /** Every run of a series into the shared scope (no-op unless the series is shared). */
  backfillSeries(seriesId: string): number {
    const runs = this.db
      .prepare("SELECT id FROM tasks WHERE source_scheduled_task_id = ? ORDER BY created_at")
      .all(seriesId) as { id: string }[];
    let added = 0;
    let retentionDays = 0;
    for (const run of runs) {
      const scope = this.scopeFor(run.id);
      if (scope.scopeId !== seriesScopeId(seriesId)) return 0;
      retentionDays = scope.retentionDays;
      added += this.backfillTask(run.id);
    }
    this.prune(seriesScopeId(seriesId), retentionDays);
    return added;
  }

  private backfillTask(taskId: string): number {
    let added = 0;
    const notes = this.db.prepare("SELECT id FROM task_notes WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at").all(taskId) as { id: string }[];
    for (const n of notes) if (this.recordNote(n.id)) added++;
    const messages = this.db.prepare("SELECT id FROM task_messages WHERE task_id = ? ORDER BY created_at").all(taskId) as { id: string }[];
    for (const m of messages) if (this.recordMessage(m.id)) added++;
    const entries = this.db.prepare("SELECT id FROM realtime_timeline WHERE task_id = ? AND entry_type IN ('text', 'summary') ORDER BY created_at").all(taskId) as { id: string }[];
    for (const e of entries) if (this.recordTimelineEntry(e.id)) added++;
    return added;
  }

  /** Counts + stored sizes for the details pane and `tasks/read`. */
  summary(taskId: string): TaskMemorySummary {
    return taskMemorySummary(this.db, taskId);
  }

  countRows(taskId: string): { total: number; embedded: number } {
    const embedder = this.resolveEmbedder();
    const key = isEmbedder(embedder) ? embedder.modelKey : null;
    const scopeId = this.scopeFor(taskId).scopeId ?? taskScopeId(taskId);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN embedding IS NOT NULL AND embedding_model = ? THEN 1 ELSE 0 END) AS embedded
         FROM task_memory WHERE scope_id = ? AND deleted_at IS NULL`,
      )
      .get(key, scopeId) as { total: number; embedded: number | null };
    return { total: row.total, embedded: row.embedded ?? 0 };
  }

  /**
   * Agent-initiated soft delete (`delete_task_memory`). The entry must be in
   * the caller's scope. The row stays for audit, hidden from queries, and a
   * note records what was removed and why so the operator sees it on the task.
   */
  deleteEntry(input: DeleteMemoryInput): { id: string; content: string; noteId: string | null } {
    const scope = this.scopeFor(input.taskId);
    if (!scope.scopeId) throw new Error("Task memory is not enabled for this task.");
    const reason = input.reason.trim();
    if (!reason) throw new Error("reason is required");
    const row = this.db
      .prepare("SELECT id, content, deleted_at FROM task_memory WHERE id = ? AND scope_id = ?")
      .get(input.id, scope.scopeId) as { id: string; content: string; deleted_at: string | null } | null;
    if (!row) throw new Error(`No memory entry ${input.id} in this task's memory.`);
    if (row.deleted_at) return { id: row.id, content: row.content, noteId: null };
    this.db
      .prepare("UPDATE task_memory SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ?")
      .run(nowTimestamp(), input.agentId, reason, row.id);

    // Audit trail the operator can see: a note on the calling task.
    let noteId: string | null = null;
    try {
      noteId = crypto.randomUUID();
      const excerpt = row.content.replace(/\s+/g, " ").trim().slice(0, 140);
      const content = `Deleted memory entry ${row.id}: ${reason}. Entry was: "${excerpt}${row.content.length > 140 ? "..." : ""}"`;
      this.db
        .prepare("INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, 'agent')")
        .run(noteId, input.taskId, input.agentId, content);
      eventBus.emit("task:note_added", { noteId, taskId: input.taskId, agentId: input.agentId, content });
    } catch (err) {
      noteId = null;
      console.error(`[task-memory] could not record deletion note: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { id: row.id, content: row.content, noteId };
  }

  /** Hard delete of a whole scope (operator "Clear memory"). Returns rows removed. */
  clearScope(scopeId: string): number {
    return this.db.prepare("DELETE FROM task_memory WHERE scope_id = ?").run(scopeId).changes;
  }

  // ── embedding queue ────────────────────────────────────

  /** Coalesced background flush; safe to call often. */
  scheduleFlush(): void {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = this.flushEmbeddings()
      .catch((err) => {
        this.lastEmbedError = err instanceof Error ? err.message : String(err);
        console.error(`[task-memory] embedding flush failed: ${this.lastEmbedError}`);
        this.scheduleRetry();
      })
      .finally(() => {
        this.flushing = null;
        if (this.flushAgain) {
          this.flushAgain = false;
          this.scheduleFlush();
        }
      });
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.cleanup.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleFlush();
    }, this.retryDelayMs);
  }

  /** Wait for any in-flight flush (tests + the toggle route's backfill). */
  async flushEmbeddings(): Promise<void> {
    const embedder = this.resolveEmbedder();
    if (!isEmbedder(embedder)) return; // nothing configured: rows wait, no error
    const pending = this.db
      .prepare(
        `SELECT id, content FROM task_memory
         WHERE deleted_at IS NULL AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?)
         ORDER BY created_at LIMIT ?`,
      )
      .all(embedder.modelKey, EMBED_BATCH) as { id: string; content: string }[];
    if (pending.length === 0) return;

    const vectors = await embedder.embedDocuments(pending.map((p) => p.content));
    const update = this.db.prepare("UPDATE task_memory SET embedding = ?, embedding_model = ? WHERE id = ?");
    this.db.transaction(() => {
      pending.forEach((p, i) => {
        const vec = vectors[i];
        if (vec) update.run(toBlob(vec), embedder.modelKey, p.id);
      });
    })();
    this.lastEmbedError = null;
    if (pending.length === EMBED_BATCH) this.flushAgain = true;
  }

  /** Drain until nothing is pending (used after a backfill and by tests). */
  async flushAll(): Promise<void> {
    if (this.flushing) await this.flushing.catch(() => {});
    for (let i = 0; i < 1000; i++) {
      const embedder = this.resolveEmbedder();
      if (!isEmbedder(embedder)) return;
      const left = this.db
        .prepare("SELECT COUNT(*) AS n FROM task_memory WHERE deleted_at IS NULL AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?)")
        .get(embedder.modelKey) as { n: number };
      if (left.n === 0) return;
      await this.flushEmbeddings();
    }
  }

  // ── reads ──────────────────────────────────────────────

  /**
   * Semantic query. Throws when memory is off for the task or no embedder is
   * configured (the tool surfaces the message to the agent). Rows still waiting
   * for an embedding are embedded first, so a fresh note is queryable at once.
   */
  async query(input: MemoryQuery): Promise<MemoryHit[]> {
    const scope = this.scopeFor(input.taskId);
    if (!scope.scopeId) throw new Error("Task memory is not enabled for this task.");
    const embedder = this.resolveEmbedder();
    if (!isEmbedder(embedder)) throw new Error(`Task memory cannot be queried: ${embedder.reason}`);
    const query = input.query.trim();
    if (!query) throw new Error("query must not be empty");
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(input.limit ?? DEFAULT_QUERY_LIMIT)));

    await this.flushAll();
    const queryVec = await embedder.embedQuery(query);

    const shared = scope.mode === "shared";
    const conditions = ["m.scope_id = ?", "m.deleted_at IS NULL", "m.embedding IS NOT NULL", "m.embedding_model = ?"];
    const params: string[] = [scope.scopeId, embedder.modelKey];
    if (input.author) { conditions.push("m.author = ?"); params.push(input.author); }
    if (input.kind) { conditions.push("m.kind = ?"); params.push(input.kind); }
    if (input.runId) { conditions.push("m.task_id = ?"); params.push(input.runId); }
    else if (input.scope === "run" || !shared) { conditions.push("m.task_id = ?"); params.push(input.taskId); }
    if (input.since?.trim()) { conditions.push("m.created_at >= ?"); params.push(normalizeTimestamp(input.since)); }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.task_id, m.run_label, m.kind, m.author, m.agent_id, a.name AS agent_name, m.content, m.created_at, m.embedding
         FROM task_memory m LEFT JOIN agents a ON a.id = m.agent_id
         WHERE ${conditions.join(" AND ")}`,
      )
      .all(...params) as MemoryRow[];

    const scored = rows.map((r) => ({ row: r, score: dot(queryVec, fromBlob(r.embedding!)) }));
    scored.sort((x, y) => y.score - x.score);
    // Diversity across runs only matters when the result spans runs.
    const spansRuns = shared && !input.runId && input.scope !== "run";
    const perRun = new Map<string, number>();
    const top: typeof scored = [];
    for (const item of scored) {
      if (top.length >= limit) break;
      if (spansRuns) {
        const n = perRun.get(item.row.task_id) ?? 0;
        if (n >= MAX_HITS_PER_RUN) continue;
        perRun.set(item.row.task_id, n + 1);
      }
      top.push(item);
    }
    top.sort((x, y) => x.row.created_at.localeCompare(y.row.created_at));
    return top.map(({ row, score }) => ({
      id: row.id,
      kind: row.kind,
      author: row.author,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      run: { id: row.task_id, label: row.run_label, this_run: row.task_id === input.taskId },
      content: row.content,
      created_at: row.created_at,
      score: Math.round(score * 1000) / 1000,
    }));
  }

  /** Keyword search over one source. No embeddings involved; always available. */
  searchContent(input: ContentSearch): ContentHit[] {
    const terms = tokenizeQuery(input.query);
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(input.limit ?? DEFAULT_QUERY_LIMIT)));
    const hits: ContentHit[] = [];

    if (input.source === "notes") {
      const rows = this.db
        .prepare(
          `SELECT n.id, n.agent_id, a.name AS agent_name, n.content, n.source, n.created_at
           FROM task_notes n LEFT JOIN agents a ON a.id = n.agent_id
           WHERE n.task_id = ? AND n.deleted_at IS NULL`,
        )
        .all(input.taskId) as { id: string; agent_id: string; agent_name: string | null; content: string; source: string | null; created_at: string }[];
      for (const r of rows) {
        const score = keywordScore(r.content, terms);
        if (score === 0) continue;
        const author: MemoryAuthor = r.source === "agent" || r.source === null ? "agent" : "user";
        hits.push({ id: r.id, source: "notes", author, agent_id: author === "agent" ? r.agent_id : null, agent_name: author === "agent" ? r.agent_name : null, created_at: r.created_at, snippet: snippetAround(r.content, terms), score });
      }
    } else if (input.source === "messages") {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.agent_id, a.name AS agent_name, m.content, m.created_at
           FROM task_messages m LEFT JOIN agents a ON a.id = m.agent_id
           WHERE m.task_id = ?`,
        )
        .all(input.taskId) as { id: string; agent_id: string; agent_name: string | null; content: string; created_at: string }[];
      for (const r of rows) {
        const score = keywordScore(r.content, terms);
        if (score === 0) continue;
        hits.push({ id: r.id, source: "messages", author: "agent", agent_id: r.agent_id, agent_name: r.agent_name, created_at: r.created_at, snippet: snippetAround(r.content, terms), score });
      }
    } else {
      // Latest live version of each artifact name; inline bodies plus file captions.
      const rows = this.db
        .prepare(
          `SELECT t.id, t.name, t.version, t.kind, t.description, t.body, t.created_by_agent_id, a.name AS agent_name, t.created_at
           FROM task_artifacts t LEFT JOIN agents a ON a.id = t.created_by_agent_id
           WHERE t.task_id = ? AND t.deleted_at IS NULL
             AND t.version = (SELECT MAX(version) FROM task_artifacts x WHERE x.task_id = t.task_id AND x.name = t.name AND x.deleted_at IS NULL)`,
        )
        .all(input.taskId) as { id: string; name: string; version: number; kind: string; description: string | null; body: string; created_by_agent_id: string | null; agent_name: string | null; created_at: string }[];
      for (const r of rows) {
        const text = [r.name, r.description ?? "", r.body].join("\n");
        const score = keywordScore(text, terms);
        if (score === 0) continue;
        const isAgent = !!r.created_by_agent_id && r.created_by_agent_id !== "api" && !r.created_by_agent_id.startsWith("operator") && !r.created_by_agent_id.startsWith("connect:");
        hits.push({ id: r.id, source: "artifacts", author: isAgent ? "agent" : "user", agent_id: isAgent ? r.created_by_agent_id : null, agent_name: isAgent ? r.agent_name : null, name: r.name, version: r.version, kind: r.kind, created_at: r.created_at, snippet: snippetAround(r.body || r.description || r.name, terms), score });
      }
    }

    hits.sort((x, y) => y.score - x.score || y.created_at.localeCompare(x.created_at));
    return hits.slice(0, limit);
  }
}
