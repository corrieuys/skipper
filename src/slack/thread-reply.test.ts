import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { TaskScheduler } from "../tasks/scheduler";
import { findRunningTaskByThread } from "./slash-command";

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

function seedTask(status: string, origin?: Record<string, unknown>): string {
  const id = `task-${status}`;
  db.prepare(
    "INSERT INTO tasks (id, title, team_id, status, task_config) VALUES (?, 'Add webhook', 'team-1', ?, ?)",
  ).run(id, status, JSON.stringify(origin ? { slack_origin: origin } : {}));
  return id;
}

describe("findRunningTaskByThread", () => {
  it("matches a running task on channel + thread_ts", () => {
    const id = seedTask("running", { channel: "C1", thread_ts: "1700.5" });
    expect(findRunningTaskByThread(db, "C1", "1700.5")).toBe(id);
  });

  it("does not match when the channel differs", () => {
    seedTask("running", { channel: "C1", thread_ts: "1700.5" });
    expect(findRunningTaskByThread(db, "C-other", "1700.5")).toBeNull();
  });

  it("ignores tasks that are not running", () => {
    seedTask("completed", { channel: "C1", thread_ts: "1700.5" });
    expect(findRunningTaskByThread(db, "C1", "1700.5")).toBeNull();
  });

  it("returns null for a task with no origin", () => {
    seedTask("running");
    expect(findRunningTaskByThread(db, "C1", "1700.5")).toBeNull();
  });
});

describe("TaskScheduler.addExternalNote", () => {
  it("records a note attributed to the team entrypoint agent", () => {
    const id = seedTask("running", { channel: "C1", thread_ts: "1700.5" });
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
    const id = seedTask("running", { channel: "C1", thread_ts: "1700.5" });
    expect(scheduler.addExternalNote(id, "   ")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS c FROM task_notes").get() as { c: number }).c).toBe(0);
  });

  it("returns null for an unknown task", () => {
    expect(scheduler.addExternalNote("nope", "hi")).toBeNull();
  });
});
