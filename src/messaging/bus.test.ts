import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import {
  parseMessageSignal,
  findAgentByName,
  persistMessage,
  routeAgentMessage,
  getMessagesForAgent,
} from "./bus";

const TEST_DB = "test-messaging-bus.db";

let db: Database;

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);

  // Seed two agent rows used across tests
  db.prepare("INSERT INTO agents (id, name, type) VALUES (?, ?, ?)").run("agent-1", "Alpha", "claude-code");
  db.prepare("INSERT INTO agents (id, name, type) VALUES (?, ?, ?)").run("agent-2", "Beta", "claude-code");
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe("parseMessageSignal", () => {
  it("parses a valid signal with content", () => {
    const result = parseMessageSignal("[MSG:info to:Beta] hello there");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("info");
    expect(result!.toAgentName).toBe("Beta");
    expect(result!.content).toBe("hello there");
  });

  it("parses a signal with multi-word agent name", () => {
    const result = parseMessageSignal("[MSG:request to:Lead Developer] please review");
    expect(result).not.toBeNull();
    expect(result!.toAgentName).toBe("Lead Developer");
    expect(result!.content).toBe("please review");
  });

  it("parses a signal with empty content", () => {
    const result = parseMessageSignal("[MSG:ping to:Beta]");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("");
  });

  it("returns null for lines that are not MSG signals", () => {
    expect(parseMessageSignal("[DELEGATE to:agent-1] do something")).toBeNull();
    expect(parseMessageSignal("[ESCALATE] help")).toBeNull();
    expect(parseMessageSignal("plain text line")).toBeNull();
    expect(parseMessageSignal("")).toBeNull();
  });

  it("returns null for malformed MSG signals", () => {
    expect(parseMessageSignal("[MSG to:Beta] missing type")).toBeNull();
    expect(parseMessageSignal("[MSGinfo to:Beta] missing colon")).toBeNull();
  });
});

describe("findAgentByName", () => {
  it("returns agent when name matches", () => {
    const agent = findAgentByName(db, "Alpha");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("agent-1");
    expect(agent!.name).toBe("Alpha");
  });

  it("returns null when agent name does not exist", () => {
    const agent = findAgentByName(db, "NonExistent");
    expect(agent).toBeNull();
  });
});

describe("persistMessage", () => {
  it("inserts a message and returns it with all fields", () => {
    const msg = persistMessage(db, {
      fromAgentId: "agent-1",
      toAgentId: "agent-2",
      type: "info",
      content: "hello",
    });

    expect(msg.id).toBeTruthy();
    expect(msg.fromAgentId).toBe("agent-1");
    expect(msg.toAgentId).toBe("agent-2");
    expect(msg.type).toBe("info");
    expect(msg.content).toBe("hello");
    expect(msg.taskId).toBeNull();
    expect(msg.createdAt).toBeTruthy();
  });

  it("persists taskId when provided", () => {
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run("task-1", "Test Task");
    const msg = persistMessage(db, {
      fromAgentId: "agent-1",
      toAgentId: "agent-2",
      type: "info",
      content: "with task",
      taskId: "task-1",
    });

    expect(msg.taskId).toBe("task-1");
  });

  it("generates unique ids for each message", () => {
    const msg1 = persistMessage(db, { fromAgentId: "agent-1", toAgentId: "agent-2", type: "a", content: "1" });
    const msg2 = persistMessage(db, { fromAgentId: "agent-1", toAgentId: "agent-2", type: "a", content: "2" });
    expect(msg1.id).not.toBe(msg2.id);
  });
});

describe("routeAgentMessage", () => {
  it("routes to a known agent and returns message and toAgentId", () => {
    const result = routeAgentMessage(db, {
      fromAgentId: "agent-1",
      toAgentName: "Beta",
      type: "info",
      content: "hi Beta",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.toAgentId).toBe("agent-2");
    expect(result.message.content).toBe("hi Beta");
    expect(result.message.fromAgentId).toBe("agent-1");
    expect(result.message.toAgentId).toBe("agent-2");
  });

  it("returns an error when recipient agent name is unknown", () => {
    const result = routeAgentMessage(db, {
      fromAgentId: "agent-1",
      toAgentName: "Ghost",
      type: "info",
      content: "hi",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("Ghost");
  });

  it("persists the message in the database", () => {
    routeAgentMessage(db, {
      fromAgentId: "agent-1",
      toAgentName: "Beta",
      type: "request",
      content: "do a thing",
    });

    const rows = db.prepare("SELECT * FROM messages WHERE from_agent_id = ?").all("agent-1");
    expect(rows).toHaveLength(1);
  });
});

describe("getMessagesForAgent", () => {
  it("returns messages where agent is sender", () => {
    persistMessage(db, { fromAgentId: "agent-1", toAgentId: "agent-2", type: "info", content: "sent by 1" });

    const msgs = getMessagesForAgent(db, "agent-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("sent by 1");
  });

  it("returns messages where agent is recipient", () => {
    persistMessage(db, { fromAgentId: "agent-1", toAgentId: "agent-2", type: "info", content: "received by 2" });

    const msgs = getMessagesForAgent(db, "agent-2");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("received by 2");
  });

  it("returns both sent and received messages", () => {
    persistMessage(db, { fromAgentId: "agent-1", toAgentId: "agent-2", type: "a", content: "from 1 to 2" });
    persistMessage(db, { fromAgentId: "agent-2", toAgentId: "agent-1", type: "b", content: "from 2 to 1" });

    const msgs = getMessagesForAgent(db, "agent-1");
    expect(msgs).toHaveLength(2);
  });

  it("returns empty array when agent has no messages", () => {
    const msgs = getMessagesForAgent(db, "agent-1");
    expect(msgs).toHaveLength(0);
  });

  it("returns messages ordered by created_at ascending", () => {
    persistMessage(db, { fromAgentId: "agent-1", toAgentId: "agent-2", type: "a", content: "first" });
    persistMessage(db, { fromAgentId: "agent-1", toAgentId: "agent-2", type: "b", content: "second" });

    const msgs = getMessagesForAgent(db, "agent-1");
    expect(msgs[0].content).toBe("first");
    expect(msgs[1].content).toBe("second");
  });
});
