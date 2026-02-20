import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "./connection";
import { logError } from "./log-error";

describe("logError", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts an error event into the events table", () => {
    logError(db, "test_error", {}, new Error("something went wrong"));

    const row = db
      .prepare("SELECT * FROM events WHERE type = 'test_error' LIMIT 1")
      .get() as { id: number; type: string; payload: string; source_agent_id: string | null; task_id: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.type).toBe("test_error");
    expect(row!.source_agent_id).toBeNull();
    expect(row!.task_id).toBeNull();

    const payload = JSON.parse(row!.payload);
    expect(payload.error_message).toBe("something went wrong");
    expect(typeof payload.error_stack).toBe("string");
  });

  it("includes context fields in the payload", () => {
    logError(db, "state_update_failed", { agentId: "agent-1", taskId: "task-1", extra: "info" }, new Error("db error"));

    const row = db
      .prepare("SELECT * FROM events WHERE type = 'state_update_failed' LIMIT 1")
      .get() as { id: number; type: string; payload: string; source_agent_id: string | null; task_id: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.source_agent_id).toBe("agent-1");
    expect(row!.task_id).toBe("task-1");

    const payload = JSON.parse(row!.payload);
    expect(payload.agentId).toBe("agent-1");
    expect(payload.taskId).toBe("task-1");
    expect(payload.extra).toBe("info");
    expect(payload.error_message).toBe("db error");
  });

  it("handles non-Error objects as the error argument", () => {
    logError(db, "test_string_error", {}, "some string error");

    const row = db
      .prepare("SELECT * FROM events WHERE type = 'test_string_error' LIMIT 1")
      .get() as { payload: string } | null;

    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.error_message).toBe("some string error");
  });

  it("silently ignores errors when DB is closed", () => {
    db.close();
    // Should not throw
    expect(() => logError(db, "test_closed_db", {}, new Error("oops"))).not.toThrow();
  });

  it("sets source_agent_id from context.agentId", () => {
    logError(db, "agent_error", { agentId: "my-agent" }, new Error("fail"));

    const row = db
      .prepare("SELECT source_agent_id FROM events WHERE type = 'agent_error' LIMIT 1")
      .get() as { source_agent_id: string | null } | null;

    expect(row!.source_agent_id).toBe("my-agent");
  });

  it("sets task_id from context.taskId", () => {
    logError(db, "task_error", { taskId: "my-task" }, new Error("fail"));

    const row = db
      .prepare("SELECT task_id FROM events WHERE type = 'task_error' LIMIT 1")
      .get() as { task_id: string | null } | null;

    expect(row!.task_id).toBe("my-task");
  });
});
