import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { TaskScheduler } from "../tasks/scheduler";
import { findTaskByThread, mentionsSkipper, SLACK_NOTE_PREFIX } from "./slash-command";

let db: Database;
let scheduler: TaskScheduler;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  clearAgentTypeCache();
  db.exec("PRAGMA foreign_keys=ON");
  scheduler = new TaskScheduler(db);
  db.prepare(
    "INSERT INTO agents (id, name, type, model) VALUES ('default-agent','Default','claude-code','default')",
  ).run();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id) VALUES ('team-1','T','default-agent')",
  ).run();
});

afterEach(() => db.close());

function seedTask(status: string, origin?: Record<string, unknown>, id = `task-${status}`): string {
  db.prepare(
    "INSERT INTO tasks (id, title, team_id, status, task_config) VALUES (?, 'Add webhook', 'team-1', ?, ?)",
  ).run(id, status, JSON.stringify(origin ? { slack_origin: origin } : {}));
  return id;
}

describe("findTaskByThread", () => {
  it("matches an active task on channel + thread_ts", () => {
    const id = seedTask("active", { channel: "C1", thread_ts: "1700.5" });
    expect(findTaskByThread(db, "C1", "1700.5")).toEqual({ id, status: "active" });
  });

  it("does not match when the channel differs", () => {
    seedTask("active", { channel: "C1", thread_ts: "1700.5" });
    expect(findTaskByThread(db, "C-other", "1700.5")).toBeNull();
  });

  // Unified input auto-unarchives, so an archived task's thread stays matchable.
  it("matches an archived task so a reply can revive it", () => {
    const id = seedTask("settled", { channel: "C1", thread_ts: "1700.5" });
    expect(findTaskByThread(db, "C1", "1700.5")).toEqual({ id, status: "settled" });
  });

  it("prefers the active task when active and archived share a thread", () => {
    seedTask("settled", { channel: "C1", thread_ts: "1700.5" });
    const activeId = seedTask("active", { channel: "C1", thread_ts: "1700.5" });
    expect(findTaskByThread(db, "C1", "1700.5")?.id).toBe(activeId);
  });

  it("ignores draft tasks", () => {
    seedTask("draft", { channel: "C1", thread_ts: "1700.5" });
    expect(findTaskByThread(db, "C1", "1700.5")).toBeNull();
  });

  it("returns null for a task with no origin", () => {
    seedTask("active");
    expect(findTaskByThread(db, "C1", "1700.5")).toBeNull();
  });
});

describe("TaskScheduler.addExternalNote", () => {
  it("records a note attributed to the team entrypoint agent", () => {
    const id = seedTask("active", { channel: "C1", thread_ts: "1700.5" });
    const noteId = scheduler.addExternalNote(id, "Slack reply from <@U9>: use postgres", "user");
    expect(noteId).not.toBeNull();
    const row = db.prepare("SELECT agent_id, content, source FROM task_notes WHERE id = ?").get(noteId) as {
      agent_id: string;
      content: string;
      source: string;
    };
    expect(row.agent_id).toBe("default-agent");
    expect(row.content).toContain("use postgres");
    expect(row.source).toBe("user");
  });

  it("returns null (no note) for blank content", () => {
    const id = seedTask("active", { channel: "C1", thread_ts: "1700.5" });
    expect(scheduler.addExternalNote(id, "   ")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS c FROM task_notes").get() as { c: number }).c).toBe(0);
  });

  it("returns null for an unknown task", () => {
    expect(scheduler.addExternalNote("nope", "hi")).toBeNull();
  });
});

describe("mentionsSkipper", () => {
  it("matches the word regardless of case or position", () => {
    expect(mentionsSkipper("Skipper, use the staging DB")).toBe(true);
    expect(mentionsSkipper("hey skipper can you retry")).toBe(true);
    expect(mentionsSkipper("SKIPPER should know about this")).toBe(true);
    expect(mentionsSkipper("ask Skipper about it")).toBe(true);
  });

  it("does not match ambient chatter that never names Skipper", () => {
    expect(mentionsSkipper("lunch?")).toBe(false);
    expect(mentionsSkipper("I think the migration is wrong")).toBe(false);
    expect(mentionsSkipper("")).toBe(false);
    expect(mentionsSkipper(null)).toBe(false);
    expect(mentionsSkipper(undefined)).toBe(false);
  });

  it("is a substring test, so it also admits talking ABOUT Skipper", () => {
    // Deliberate: the prompt (not this gate) decides relevance. Documented so a
    // future tightening here is a conscious choice rather than a bug fix.
    expect(mentionsSkipper("skippers are boats")).toBe(true);
  });
});

describe("SLACK_NOTE_PREFIX", () => {
  it("is the marker the prompt keys off to flag Slack-sourced notes", () => {
    const note = `${SLACK_NOTE_PREFIX} Slack reply from <@U1>: skipper use staging`;
    expect(note.startsWith(SLACK_NOTE_PREFIX)).toBe(true);
  });
});
