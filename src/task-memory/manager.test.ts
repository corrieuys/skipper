import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { TaskScheduler } from "../tasks/scheduler";
import { MessageManager } from "../messages/manager";
import { eventBus } from "../events/bus";
import { TaskMemoryManager, keywordScore, snippetAround, tokenizeQuery } from "./manager";
import type { Embedder, EmbedderUnavailable } from "./embeddings";

const TEST_DB = "test-task-memory-manager.db";

/**
 * Deterministic fake embedder: a bag-of-words vector over a fixed vocabulary,
 * unit-normalised, so "deploy" queries land on rows that mention deploying.
 */
const VOCAB = ["deploy", "database", "migration", "login", "bug", "tests", "release", "operator", "budget"];
function bagOfWords(text: string): Float32Array {
  const lower = text.toLowerCase();
  const v = new Float32Array(VOCAB.length);
  let norm = 0;
  VOCAB.forEach((w, i) => {
    const n = lower.split(w).length - 1;
    v[i] = n;
    norm += n * n;
  });
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

function fakeEmbedder(modelKey = "fake:v1"): Embedder & { calls: number } {
  const e = {
    modelKey,
    docMaxChars: 5000,
    calls: 0,
    ready: async () => {},
    embedDocuments: async (texts: string[]) => {
      e.calls++;
      return texts.map(bagOfWords);
    },
    embedQuery: async (text: string) => bagOfWords(text),
  };
  return e;
}

const UNAVAILABLE: EmbedderUnavailable = { reason: "no embedder in this test" };

let db: Database;
let scheduler: TaskScheduler;

function makeTask(memory: boolean): string {
  const task = scheduler.createTask({
    title: "memory task",
    description: "d",
    teamId: "team-a",
    workingDirectory: "/tmp",
    taskConfig: memory ? { memory_enabled: true } : undefined,
  });
  return task.id;
}

function addNote(taskId: string, content: string, source: "agent" | "user" = "agent"): string {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, ?)")
    .run(id, taskId, "skipper", content, source);
  eventBus.emit("task:note_added", { noteId: id, taskId, agentId: "skipper", content });
  return id;
}

function addTimeline(taskId: string, entryType: "text" | "summary" | "error", content: string): string {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES (?, ?, ?, ?)")
    .run(id, taskId, entryType, content);
  eventBus.emit("realtime:timeline_updated", { taskId, entryId: id, entryType });
  return id;
}

describe("TaskMemoryManager", () => {
  let manager: TaskMemoryManager | null = null;

  beforeEach(() => {
    clearAgentTypeCache();
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    db.prepare("INSERT OR IGNORE INTO teams (id, name, entrypoint_agent_id) VALUES ('team-a', 'Team A', 'skipper')").run();
    scheduler = new TaskScheduler(db);
  });

  afterEach(() => {
    manager?.stop();
    manager = null;
    db.close();
    try { unlinkSync(TEST_DB); } catch { /* gone */ }
  });

  it("records notes, messages, and operator input for a task with memory on, tagged by author", () => {
    manager = new TaskMemoryManager(db, { resolveEmbedder: () => UNAVAILABLE });
    manager.start();
    const taskId = makeTask(true);

    addNote(taskId, "agent note about the database migration");
    addNote(taskId, "operator note: keep the budget", "user");
    new MessageManager(db).postMessage({ taskId, agentId: "skipper", content: "Started the deploy" });
    addTimeline(taskId, "text", "please fix the login bug");
    addTimeline(taskId, "summary", "Audio: operator discussed the release");
    addTimeline(taskId, "error", "transcription failed");

    const rows = db.prepare("SELECT kind, author, agent_id, content FROM task_memory WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as
      { kind: string; author: string; agent_id: string | null; content: string }[];
    expect(rows.map((r) => `${r.kind}:${r.author}`)).toEqual([
      "note:agent", "note:user", "message:agent", "input:user", "summary:user",
    ]);
    expect(rows[0]!.agent_id).toBe("skipper");
    expect(rows[1]!.agent_id).toBeNull();
    expect(rows.some((r) => r.content.includes("transcription failed"))).toBe(false);
  });

  it("records nothing for a task with memory off", () => {
    manager = new TaskMemoryManager(db, { resolveEmbedder: () => UNAVAILABLE });
    manager.start();
    const taskId = makeTask(false);
    addNote(taskId, "note");
    addTimeline(taskId, "text", "input");
    const n = db.prepare("SELECT COUNT(*) AS n FROM task_memory WHERE task_id = ?").get(taskId) as { n: number };
    expect(n.n).toBe(0);
  });

  it("backfill copies existing rows once, and turning the flag on later works", () => {
    manager = new TaskMemoryManager(db, { resolveEmbedder: () => UNAVAILABLE });
    manager.start();
    const taskId = makeTask(false);
    addNote(taskId, "early note");
    addTimeline(taskId, "text", "early input");
    new MessageManager(db).postMessage({ taskId, agentId: "skipper", content: "early message" });

    expect(manager.backfill(taskId)).toBe(0); // still off
    scheduler.setMemoryEnabled(taskId, true);
    expect(manager.backfill(taskId)).toBe(3);
    expect(manager.backfill(taskId)).toBe(0); // idempotent

    addNote(taskId, "late note"); // live path after the flip
    const n = db.prepare("SELECT COUNT(*) AS n FROM task_memory WHERE task_id = ?").get(taskId) as { n: number };
    expect(n.n).toBe(4);
  });

  it("query embeds pending rows, ranks by similarity, and returns oldest first", async () => {
    const embedder = fakeEmbedder();
    manager = new TaskMemoryManager(db, { resolveEmbedder: () => embedder });
    manager.start();
    const taskId = makeTask(true);
    addNote(taskId, "Ran the database migration, all tests pass");
    addNote(taskId, "Fixed the login bug", "user");
    addNote(taskId, "Prepared the release and deploy plan");
    await manager.flushAll();

    const hits = await manager.query({ taskId, query: "what happened with the deploy release", limit: 2 });
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.content)).toContain("Prepared the release and deploy plan");
    // Chronological order regardless of score.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.created_at <= hits[i]!.created_at).toBe(true);
    }
    expect(hits.every((h) => typeof h.score === "number")).toBe(true);

    const userOnly = await manager.query({ taskId, query: "login bug", author: "user" });
    expect(userOnly.length).toBe(1);
    expect(userOnly[0]!.author).toBe("user");
  });

  it("query fails plainly when memory is off or no embedder is configured", async () => {
    manager = new TaskMemoryManager(db, { resolveEmbedder: () => UNAVAILABLE });
    manager.start();
    const off = makeTask(false);
    await expect(manager.query({ taskId: off, query: "x" })).rejects.toThrow("not enabled");
    const on = makeTask(true);
    await expect(manager.query({ taskId: on, query: "x" })).rejects.toThrow("no embedder in this test");
  });

  it("re-embeds rows when the embedding model changes", async () => {
    let embedder = fakeEmbedder("fake:v1");
    manager = new TaskMemoryManager(db, { resolveEmbedder: () => embedder });
    manager.start();
    const taskId = makeTask(true);
    addNote(taskId, "deploy note");
    await manager.flushAll();
    expect(manager.countRows(taskId)).toEqual({ total: 1, embedded: 1 });

    embedder = fakeEmbedder("fake:v2");
    expect(manager.countRows(taskId).embedded).toBe(0);
    await manager.flushAll();
    expect(manager.countRows(taskId).embedded).toBe(1);
    const row = db.prepare("SELECT embedding_model FROM task_memory WHERE task_id = ?").get(taskId) as { embedding_model: string };
    expect(row.embedding_model).toBe("fake:v2");
  });

  it("deleting the task removes its memory", () => {
    manager = new TaskMemoryManager(db, { resolveEmbedder: () => UNAVAILABLE });
    manager.start();
    const taskId = makeTask(true);
    addNote(taskId, "note");
    scheduler.deleteTask(taskId);
    const n = db.prepare("SELECT COUNT(*) AS n FROM task_memory").get() as { n: number };
    expect(n.n).toBe(0);
  });

  describe("searchContent", () => {
    it("searches notes, messages, and the latest artifact versions by keyword", () => {
      manager = new TaskMemoryManager(db, { resolveEmbedder: () => UNAVAILABLE });
      const taskId = makeTask(false); // no memory toggle needed
      addNote(taskId, "The migration needs a rollback script");
      addNote(taskId, "Unrelated note");
      new MessageManager(db).postMessage({ taskId, agentId: "skipper", content: "Rollback script written" });
      db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, created_by_agent_id) VALUES (?, ?, 'plan', 1, 'plan', 'old plan: no rollback', 'skipper')").run(crypto.randomUUID(), taskId);
      db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, created_by_agent_id) VALUES (?, ?, 'plan', 2, 'plan', 'new plan with rollback steps and rollback tests', 'skipper')").run(crypto.randomUUID(), taskId);

      const notes = manager.searchContent({ taskId, source: "notes", query: "rollback migration" });
      expect(notes.length).toBe(1);
      expect(notes[0]!.snippet).toContain("rollback");

      const messages = manager.searchContent({ taskId, source: "messages", query: "rollback" });
      expect(messages.length).toBe(1);

      const artifacts = manager.searchContent({ taskId, source: "artifacts", query: "rollback" });
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]!.version).toBe(2);
      expect(artifacts[0]!.name).toBe("plan");

      expect(manager.searchContent({ taskId, source: "notes", query: "zzz" })).toEqual([]);
      expect(manager.searchContent({ taskId, source: "notes", query: "" })).toEqual([]);
    });
  });
});

describe("keyword helpers", () => {
  it("tokenizes, scores distinct hits above repeats, and snippets around the first hit", () => {
    expect(tokenizeQuery("Deploy the DEPLOY plan, a")).toEqual(["deploy", "the", "plan"]);
    const terms = ["deploy", "plan"];
    expect(keywordScore("deploy deploy deploy", terms)).toBeLessThan(keywordScore("deploy plan", terms));
    expect(keywordScore("nothing here", terms)).toBe(0);
    const long = "x".repeat(500) + " the deploy plan " + "y".repeat(500);
    const snip = snippetAround(long, terms, 100);
    expect(snip).toContain("deploy");
    expect(snip.length).toBeLessThanOrEqual(110);
  });
});

describe("normalizeTimestamp", () => {
  it("brings every source precision onto millisecond UTC", async () => {
    const { normalizeTimestamp, nowTimestamp } = await import("./manager");
    expect(normalizeTimestamp("2026-09-05 10:00:00")).toBe("2026-09-05 10:00:00.000");
    expect(normalizeTimestamp("2026-09-05 10:00:00.123")).toBe("2026-09-05 10:00:00.123");
    expect(normalizeTimestamp("2026-09-05 10:00:00.1")).toBe("2026-09-05 10:00:00.100");
    expect(normalizeTimestamp("2026-09-05T10:00:00.123Z")).toBe("2026-09-05 10:00:00.123");
    expect(nowTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe("taskMemorySummary", () => {
  it("counts entries, vectors, kinds, authors and stored bytes", async () => {
    const { taskMemorySummary } = await import("./summary");
    const db2 = new Database(":memory:");
    initializeDatabase(db2);
    db2.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES ('t', 'T', 'skipper')").run();
    const sched = new TaskScheduler(db2);
    const off = sched.createTask({ title: "off", teamId: "t", workingDirectory: "/tmp" });
    expect(taskMemorySummary(db2, off.id)).toMatchObject({ enabled: false, entries: 0, vectors: 0, pending: 0, dims: null, total_bytes: 0, models: [] });

    const on = sched.createTask({ title: "on", teamId: "t", workingDirectory: "/tmp", taskConfig: { memory_enabled: true } });
    const vec = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    db2.prepare("INSERT INTO task_memory (id, scope_id, task_id, kind, author, agent_id, content, ref_id, embedding, embedding_model, created_at) VALUES ('m1', ?, ?, 'note', 'agent', 'skipper', 'héllo', 'r1', ?, 'fake:v1', '2026-09-05 10:00:00.000')")
      .run(`task:${on.id}`, on.id, new Uint8Array(vec.buffer));
    db2.prepare("INSERT INTO task_memory (id, scope_id, task_id, kind, author, agent_id, content, ref_id, created_at) VALUES ('m2', ?, ?, 'input', 'user', NULL, 'abcd', 'r2', '2026-09-05 10:00:01.000')")
      .run(`task:${on.id}`, on.id);
    db2.prepare("INSERT INTO task_memory (id, scope_id, task_id, kind, author, content, ref_id, created_at, deleted_at, deleted_by, delete_reason) VALUES ('m3', ?, ?, 'note', 'agent', 'stale', 'r3', '2026-09-05 10:00:02.000', '2026-09-05 11:00:00.000', 'skipper', 'stale')")
      .run(`task:${on.id}`, on.id);
    const s = taskMemorySummary(db2, on.id);
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe("run");
    expect(s.scope_id).toBe(`task:${on.id}`);
    expect(s.runs).toBe(1);
    expect(s.deleted).toBe(1);
    expect(s.entries).toBe(2);
    expect(s.vectors).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.dims).toBe(4);
    expect(s.models).toEqual(["fake:v1"]);
    expect(s.content_bytes).toBe(6 + 4); // "héllo" is 6 UTF-8 bytes
    expect(s.vector_bytes).toBe(16);
    expect(s.total_bytes).toBe(26);
    expect(s.by_kind).toEqual({ note: 1, input: 1 });
    expect(s.by_author).toEqual({ agent: 1, user: 1 });
    expect(s.oldest_at).toBe("2026-09-05 10:00:00.000");
    expect(s.newest_at).toBe("2026-09-05 10:00:01.000");
    db2.close();
  });
});

describe("shared memory across recurring runs", () => {
  let db3: Database;
  let manager: TaskMemoryManager;
  let scheduler: TaskScheduler;
  let embedder: ReturnType<typeof fakeEmbedder>;
  const SERIES = "series-1";

  function seedSeries(mode: "off" | "run" | "shared", retentionDays = 0): void {
    const cfg: Record<string, unknown> = {};
    if (mode !== "off") cfg.memory_mode = mode;
    if (retentionDays > 0) cfg.memory_retention_days = retentionDays;
    db3.prepare("INSERT OR REPLACE INTO scheduled_tasks (id, title, team_id, working_directory, task_config, status) VALUES (?, 'Nightly', 'team-a', '/tmp', ?, 'approved')")
      .run(SERIES, JSON.stringify(cfg));
  }

  function seedRun(id: string, title: string): string {
    db3.prepare("INSERT INTO tasks (id, title, team_id, status, working_directory, source_scheduled_task_id, started_at) VALUES (?, ?, 'team-a', 'active', '/tmp', ?, '2026-09-01 08:00:00')")
      .run(id, title, SERIES);
    return id;
  }

  function note(taskId: string, content: string, source: "agent" | "user" = "agent"): string {
    const id = crypto.randomUUID();
    db3.prepare("INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, 'skipper', ?, ?)").run(id, taskId, content, source);
    eventBus.emit("task:note_added", { noteId: id, taskId, agentId: "skipper", content });
    return id;
  }

  beforeEach(() => {
    clearAgentTypeCache();
    db3 = new Database(":memory:");
    db3.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db3);
    db3.prepare("INSERT OR IGNORE INTO teams (id, name, entrypoint_agent_id) VALUES ('team-a', 'Team A', 'skipper')").run();
    scheduler = new TaskScheduler(db3);
    embedder = fakeEmbedder();
    manager = new TaskMemoryManager(db3, { resolveEmbedder: () => embedder });
    manager.start();
  });

  afterEach(() => {
    manager.stop();
    db3.close();
  });

  it("resolves the scope from the series live, and runs write into the shared scope with a run label", () => {
    seedSeries("shared");
    const r1 = seedRun("run-1", "Nightly (2026-09-01 08:00)");
    const r2 = seedRun("run-2", "Nightly (2026-09-02 08:00)");
    expect(manager.scopeFor(r1)).toMatchObject({ mode: "shared", scopeId: "series:series-1", seriesId: SERIES });
    note(r1, "deploy went fine on day one");
    note(r2, "deploy failed on day two", "user");
    const rows = db3.prepare("SELECT scope_id, task_id, run_label, author FROM task_memory ORDER BY created_at").all() as { scope_id: string; task_id: string; run_label: string; author: string }[];
    expect(rows.map((r) => r.scope_id)).toEqual(["series:series-1", "series:series-1"]);
    expect(rows[0]!.run_label).toContain("Nightly (2026-09-01 08:00)");
    expect(rows[1]!.task_id).toBe(r2);

    // Flipping the series to per-run applies to runs already in flight.
    seedSeries("run");
    expect(manager.scopeFor(r1)).toMatchObject({ mode: "run", scopeId: "task:run-1" });
    seedSeries("off");
    expect(manager.isEnabled(r1)).toBe(false);
  });

  it("query spans runs with a per-run cap, tags each hit with its run, and honours scope/run_id/since", async () => {
    seedSeries("shared");
    const r1 = seedRun("run-1", "Nightly 1");
    const r2 = seedRun("run-2", "Nightly 2");
    for (let i = 0; i < 5; i++) note(r1, `deploy deploy deploy step ${i}`);
    note(r2, "deploy on the second run");
    await manager.flushAll();

    const hits = await manager.query({ taskId: r2, query: "deploy", limit: 10 });
    const fromR1 = hits.filter((h) => h.run.id === r1).length;
    expect(fromR1).toBe(3); // MAX_HITS_PER_RUN
    expect(hits.some((h) => h.run.id === r2 && h.run.this_run)).toBe(true);
    expect(hits.every((h) => typeof h.id === "string" && h.created_at.length > 0)).toBe(true);
    expect(hits.find((h) => h.run.id === r1)!.run.label).toContain("Nightly 1");

    const onlyMine = await manager.query({ taskId: r2, query: "deploy", scope: "run" });
    expect(onlyMine.every((h) => h.run.id === r2)).toBe(true);
    const byRun = await manager.query({ taskId: r2, query: "deploy", runId: r1, limit: 10 });
    expect(byRun.length).toBe(5); // explicit run filter: no diversity cap
    const future = await manager.query({ taskId: r2, query: "deploy", since: "2099-01-01T00:00:00Z" });
    expect(future).toEqual([]);
  });

  it("backfillSeries copies every run once and prune drops rows past retention", () => {
    seedSeries("off");
    const r1 = seedRun("run-1", "Nightly 1");
    const r2 = seedRun("run-2", "Nightly 2");
    note(r1, "early one");
    note(r2, "early two");
    expect((db3.prepare("SELECT COUNT(*) AS n FROM task_memory").get() as { n: number }).n).toBe(0);
    seedSeries("shared", 30);
    expect(manager.backfillSeries(SERIES)).toBe(2);
    expect(manager.backfillSeries(SERIES)).toBe(0);
    db3.prepare("UPDATE task_memory SET created_at = '2020-01-01 00:00:00.000' WHERE task_id = ?").run(r1);
    expect(manager.prune("series:series-1", 30)).toBe(1);
    // A live record on a retained series prunes the aged row of its scope too.
    db3.prepare("UPDATE task_memory SET created_at = '2020-01-01 00:00:00.000' WHERE task_id = ?").run(r2);
    note(r2, "fresh");
    const left = db3.prepare("SELECT content FROM task_memory ORDER BY created_at").all() as { content: string }[];
    expect(left.map((r) => r.content)).toEqual(["fresh"]);
  });

  it("deleteEntry soft-deletes within the caller's scope and leaves an audit note", async () => {
    seedSeries("shared");
    const r1 = seedRun("run-1", "Nightly 1");
    const r2 = seedRun("run-2", "Nightly 2");
    note(r1, "the database migration is pending");
    await manager.flushAll();
    const [hit] = await manager.query({ taskId: r2, query: "database migration" });
    expect(hit).toBeDefined();

    const result = manager.deleteEntry({ id: hit!.id, taskId: r2, agentId: "skipper", reason: "migration ran on run 2" });
    expect(result.noteId).not.toBeNull();
    const row = db3.prepare("SELECT deleted_at, deleted_by, delete_reason FROM task_memory WHERE id = ?").get(hit!.id) as { deleted_at: string | null; deleted_by: string; delete_reason: string };
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe("skipper");
    expect(row.delete_reason).toBe("migration ran on run 2");
    // Hidden from queries (the audit note itself may match, so check the id, not emptiness).
    const after = await manager.query({ taskId: r2, query: "database migration" });
    expect(after.some((h) => h.id === hit!.id)).toBe(false);
    const auditNote = db3.prepare("SELECT content, task_id FROM task_notes WHERE id = ?").get(result.noteId!) as { content: string; task_id: string };
    expect(auditNote.task_id).toBe(r2);
    expect(auditNote.content).toContain(hit!.id);
    expect(auditNote.content).toContain("migration ran on run 2");
    // The audit note itself lands in memory (it is a note on a memory-on task).
    const memoryOfNote = db3.prepare("SELECT COUNT(*) AS n FROM task_memory WHERE ref_id = ?").get(result.noteId!) as { n: number };
    expect(memoryOfNote.n).toBe(1);

    // Outside the caller's scope: refused.
    const solo = scheduler.createTask({ title: "solo", teamId: "team-a", workingDirectory: "/tmp", taskConfig: { memory_enabled: true } });
    expect(() => manager.deleteEntry({ id: hit!.id, taskId: solo.id, agentId: "skipper", reason: "x" })).toThrow("No memory entry");
    expect(() => manager.deleteEntry({ id: hit!.id, taskId: r2, agentId: "skipper", reason: "  " })).toThrow("reason is required");
    // Second delete is a no-op, not an error.
    expect(manager.deleteEntry({ id: hit!.id, taskId: r2, agentId: "skipper", reason: "again" }).noteId).toBeNull();
  });

  it("run deletion keeps shared rows, series deletion and clearScope remove them, summary counts runs and deletions", async () => {
    seedSeries("shared");
    const r1 = seedRun("run-1", "Nightly 1");
    const r2 = seedRun("run-2", "Nightly 2");
    note(r1, "one");
    note(r2, "two");
    await manager.flushAll();
    const [hit] = await manager.query({ taskId: r2, query: "one", limit: 1 });
    manager.deleteEntry({ id: hit!.id, taskId: r2, agentId: "skipper", reason: "stale" });

    const summary = manager.summary(r2);
    expect(summary).toMatchObject({ enabled: true, mode: "shared", scope_id: "series:series-1", runs: 1, deleted: 1 });
    expect(summary.entries).toBe(2); // "two" + the audit note

    scheduler.deleteTask(r1);
    expect((db3.prepare("SELECT COUNT(*) AS n FROM task_memory WHERE scope_id = 'series:series-1'").get() as { n: number }).n).toBe(3);
    expect(manager.clearScope("series:series-1")).toBe(3);

    note(r2, "after clear");
    const { ScheduledTaskScheduler } = await import("../tasks/scheduled-scheduler");
    new ScheduledTaskScheduler(db3).deleteScheduledTask(SERIES);
    expect((db3.prepare("SELECT COUNT(*) AS n FROM task_memory").get() as { n: number }).n).toBe(0);
  });

  it("setMemoryConfig validates and stores the series setting", async () => {
    seedSeries("off");
    const { ScheduledTaskScheduler } = await import("../tasks/scheduled-scheduler");
    const ss = new ScheduledTaskScheduler(db3);
    expect(ss.setMemoryConfig(SERIES, { mode: "shared", retentionDays: 14 }).task_config).toMatchObject({ memory_mode: "shared", memory_retention_days: 14 });
    expect(ss.setMemoryConfig(SERIES, { retentionDays: 0 }).task_config).not.toContainKey("memory_retention_days");
    expect(ss.setMemoryConfig(SERIES, { mode: "off" }).task_config).not.toContainKey("memory_mode");
    expect(() => ss.setMemoryConfig(SERIES, { mode: "nope" as never })).toThrow("Invalid memory mode");
    expect(() => ss.setMemoryConfig(SERIES, { retentionDays: -1 })).toThrow("retentionDays");
  });
});
