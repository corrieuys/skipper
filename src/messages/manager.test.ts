import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { eventBus } from "../events/bus";
import { TaskScheduler } from "../tasks/scheduler";
import { MessageManager, MESSAGE_MAX_LENGTH } from "./manager";

let db: Database;
let manager: MessageManager;

function createTask(id: string): void {
  db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, 'active')").run(id, `Task ${id}`);
}

function createAgent(id: string, name: string): void {
  db.prepare("INSERT INTO agents (id, name, type) VALUES (?, ?, 'claude-code')").run(id, name);
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  manager = new MessageManager(db);
  createTask("task-1");
  createAgent("agent-1", "Skipper");
});

afterEach(() => db.close());

describe("postMessage", () => {
  it("stores a message and returns its id", () => {
    const result = manager.postMessage({
      taskId: "task-1",
      agentId: "agent-1",
      content: "Started on the login fix.",
    });

    expect(result.status).toBe("created");
    const rows = manager.listMessages("task-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("Started on the login fix.");
    expect(rows[0]!.agent_name).toBe("Skipper");
  });

  it("emits task:message_posted", () => {
    let seen: { taskId: string; content: string } | null = null;
    const listener = (e: { taskId: string; content: string }) => { seen = e; };
    eventBus.on("task:message_posted", listener);

    manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "Tests are running." });

    eventBus.off("task:message_posted", listener);
    expect(seen).not.toBeNull();
    expect(seen!.taskId).toBe("task-1");
    expect(seen!.content).toBe("Tests are running.");
  });

  it("collapses whitespace to a single line", () => {
    manager.postMessage({
      taskId: "task-1",
      agentId: "agent-1",
      content: "  Found the cause.\n\n  Fixing it now.  ",
    });

    expect(manager.listMessages("task-1")[0]!.content).toBe("Found the cause. Fixing it now.");
  });

  it("truncates an overlong body with an ellipsis", () => {
    manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "x".repeat(MESSAGE_MAX_LENGTH + 400) });

    const stored = manager.listMessages("task-1")[0]!.content;
    expect(stored).toHaveLength(MESSAGE_MAX_LENGTH);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(() => manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "   " })).toThrow();
  });

  describe("format", () => {
    it("defaults to text when omitted", () => {
      manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "plain update" });
      expect(manager.listMessages("task-1")[0]!.format).toBe("text");
    });

    it("stores the chosen format", () => {
      manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "- one\n- two", format: "markdown" });
      expect(manager.listMessages("task-1")[0]!.format).toBe("markdown");
    });

    it("preserves newlines for markdown/html but not for text", () => {
      manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "line one\nline two", format: "markdown" });
      manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "line one\nline two", format: "text" });
      const rows = manager.listMessages("task-1"); // newest first
      const md = rows.find((r) => r.format === "markdown")!;
      const txt = rows.find((r) => r.format === "text")!;
      expect(md.content).toBe("line one\nline two");
      expect(txt.content).toBe("line one line two");
    });

    it("rejects an unknown format", () => {
      expect(() =>
        manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "x", format: "xml" as never }),
      ).toThrow(/Invalid message format/);
    });
  });

  it("treats an identical repost from the same agent as a duplicate", () => {
    const first = manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "Same thing" });
    const second = manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "Same thing" });

    expect(second.status).toBe("duplicate");
    expect(second.id).toBe(first.id);
    expect(manager.listMessages("task-1")).toHaveLength(1);
  });

  it("keeps a matching message from a different agent", () => {
    createAgent("agent-2", "Reviewer");
    manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "Same thing" });
    manager.postMessage({ taskId: "task-1", agentId: "agent-2", content: "Same thing" });

    expect(manager.listMessages("task-1")).toHaveLength(2);
  });
});

describe("listMessages", () => {
  it("returns newest first and is scoped to one task", () => {
    createTask("task-2");
    manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "First" });
    manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "Second" });
    manager.postMessage({ taskId: "task-2", agentId: "agent-1", content: "Other task" });

    const rows = manager.listMessages("task-1");
    expect(rows.map((r) => r.content)).toEqual(["Second", "First"]);
    expect(manager.countMessages("task-1")).toBe(2);
  });

  it("honours the limit", () => {
    for (let i = 0; i < 5; i++) {
      manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: `Update ${i}` });
    }
    expect(manager.listMessages("task-1", 3)).toHaveLength(3);
  });

  it("is swept by the task-delete cascade", () => {
    // Deletion goes through TaskScheduler.deleteTask, which clears task-scoped
    // rows explicitly rather than relying on the FK cascade (foreign_keys is not
    // enabled on every connection).
    manager.postMessage({ taskId: "task-1", agentId: "agent-1", content: "Gone soon" });
    db.prepare("UPDATE tasks SET status = 'settled' WHERE id = ?").run("task-1");
    new TaskScheduler(db).deleteTask("task-1");

    expect(manager.listMessages("task-1")).toHaveLength(0);
  });
});
