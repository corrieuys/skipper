import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { RealtimeSessionManager } from "../orchestrator/realtime-session";
import { realtimeWsHandlers, type RealtimeWSData } from "./realtime-ws";
import { eventBus } from "../events/bus";
import type { RealtimeWindowReadyEvent, RealtimeTriggerFiredEvent, RealtimeSessionStateEvent, RealtimeTimelineUpdatedEvent } from "../events/bus";
import { unlinkSync } from "fs";

const TEST_DB = "test-realtime-ws.db";

let db: Database;
let artifactManager: ArtifactManager;
let sessionManager: RealtimeSessionManager;

function seedRealtimeTask(database: Database, id = "task-rt-1", config: Record<string, unknown> = {}): string {
  database.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run("team-1", "Test Team");
  database
    .prepare(
      "INSERT INTO tasks (id, title, team_id, status, task_type, task_config) VALUES (?, ?, ?, 'running', 'real_time', ?)",
    )
    .run(id, "Realtime Task", "team-1", JSON.stringify(config));
  return id;
}

function createMockWs(data: RealtimeWSData): { ws: any; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    data,
    send(msg: string) { sent.push(msg); },
    close() {},
  };
  return { ws, sent };
}

function parseSent(sent: string[]): Record<string, unknown>[] {
  return sent.map((s) => JSON.parse(s));
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  artifactManager = new ArtifactManager(db);
  sessionManager = new RealtimeSessionManager(db, artifactManager, null);
});

afterEach(() => {
  sessionManager.dispose();
  // Remove all listeners added during tests to avoid cross-test leakage
  eventBus.removeAllListeners("realtime:window_ready");
  eventBus.removeAllListeners("realtime:trigger_fired");
  eventBus.removeAllListeners("realtime:session_state");
  eventBus.removeAllListeners("realtime:timeline_updated");
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe("realtimeWsHandlers", () => {
  describe("open", () => {
    it("sends initial session state on open", () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("session.state");
      expect(messages[0].state).toBe("paused");
    });

    it("sends active state if session is already active", () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });
      realtimeWsHandlers.open(ws);

      const messages = parseSent(sent);
      expect(messages[0].type).toBe("session.state");
      expect(messages[0].state).toBe("active");
    });
  });

  describe("message — ping", () => {
    it("responds with ack for ping", async () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "ping" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("ack");
      expect(messages[0].ref).toBe("ping");
    });
  });

  describe("message — session.start", () => {
    it("starts session and sends ack + state", async () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "session.start" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(2);
      expect(messages[0]).toEqual({ type: "ack", ref: "session.start" });
      expect(messages[1]).toEqual({ type: "session.state", state: "active" });
      expect(sessionManager.isSessionActive(taskId)).toBe(true);
    });

    it("sends error if session already active", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "session.start" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("error");
      expect(messages[0].code).toBe("SESSION_START_FAILED");
      expect(messages[0].message).toContain("Session already active");
    });
  });

  describe("message — session.stop (pause)", () => {
    it("pauses session and sends ack + paused state", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "session.stop" }));

      const messages = parseSent(sent);
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0]).toEqual({ type: "ack", ref: "session.stop" });
      expect(messages[1]).toEqual({ type: "session.state", state: "paused" });
      expect(sessionManager.isSessionActive(taskId)).toBe(false);
    });

    it("can be resumed after pausing", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "session.stop" }));
      sent.length = 0; // clear sent messages

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "session.resume" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(2);
      expect(messages[0]).toEqual({ type: "ack", ref: "session.resume" });
      expect(messages[1]).toEqual({ type: "session.state", state: "active" });
      expect(sessionManager.isSessionActive(taskId)).toBe(true);
    });
  });

  describe("message — input.text", () => {
    it("ingests text input and sends ack", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "input.text", content: "Hello world" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0]).toEqual({ type: "ack", ref: "input.text" });

      // Verify data persisted in task_input_streams table
      const row = db
        .prepare("SELECT * FROM task_input_streams WHERE task_id = ?")
        .get(taskId) as Record<string, unknown> | null;
      expect(row).not.toBeNull();
      expect(row!.content_body).toBe("Hello world");
      expect(row!.source_type).toBe("text");
    });

    it("sends error when content is missing", async () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "input.text" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("error");
      expect(messages[0].code).toBe("MISSING_CONTENT");
    });
  });

  describe("message — input.audio_chunk", () => {
    it("ingests audio chunk and sends ack", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({
        type: "input.audio_chunk",
        data: "base64audiocontent",
        format: "webm",
      }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0]).toEqual({ type: "ack", ref: "input.audio_chunk" });

      // Verify data persisted
      const row = db
        .prepare("SELECT * FROM task_input_streams WHERE task_id = ?")
        .get(taskId) as Record<string, unknown> | null;
      expect(row).not.toBeNull();
      expect(row!.source_type).toBe("audio");
      expect(row!.content_type).toBe("audio/webm");
      expect(row!.content_body).toBe("base64audiocontent");
    });

    it("sends error when data is missing", async () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "input.audio_chunk" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("error");
      expect(messages[0].code).toBe("MISSING_DATA");
    });
  });

  describe("message — invalid", () => {
    it("sends error for invalid JSON", async () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, "not valid json {{{");

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("error");
      expect(messages[0].code).toBe("INVALID_JSON");
    });

    it("sends error for unknown message type", async () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      await realtimeWsHandlers.message(ws, JSON.stringify({ type: "foobar.unknown" }));

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("error");
      expect(messages[0].code).toBe("UNKNOWN_TYPE");
      expect(messages[0].message).toContain("foobar.unknown");
    });
  });

  describe("close", () => {
    it("cleans up event bus listeners on close", () => {
      const taskId = seedRealtimeTask(db);
      const { ws } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      const countBefore = eventBus.listenerCount("realtime:window_ready");

      realtimeWsHandlers.open(ws);
      expect(eventBus.listenerCount("realtime:window_ready")).toBe(countBefore + 1);
      expect(eventBus.listenerCount("realtime:trigger_fired")).toBeGreaterThan(0);
      expect(eventBus.listenerCount("realtime:session_state")).toBeGreaterThan(0);
      expect(eventBus.listenerCount("realtime:timeline_updated")).toBeGreaterThan(0);

      realtimeWsHandlers.close(ws, 1000, "");

      expect(eventBus.listenerCount("realtime:window_ready")).toBe(countBefore);
    });
  });

  describe("event bus push", () => {
    it("forwards realtime:window_ready events to the client", () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);
      sent.length = 0; // Clear initial session.state message

      const event: RealtimeWindowReadyEvent = {
        windowId: "win-1",
        taskId,
        artifactName: "transcript",
        version: 1,
        windowStartAt: "2026-01-01T00:00:00Z",
        windowEndAt: "2026-01-01T00:01:00Z",
      };
      eventBus.emit("realtime:window_ready", event);

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("transcript.window_ready");
      expect(messages[0].window_id).toBe("win-1");
      expect(messages[0].artifact_name).toBe("transcript");
      expect(messages[0].version).toBe(1);
    });

    it("sends summary.window_ready for summary artifacts", () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);
      sent.length = 0;

      eventBus.emit("realtime:window_ready", {
        windowId: "win-2",
        taskId,
        artifactName: "summary",
        version: 3,
        windowStartAt: "2026-01-01T00:00:00Z",
        windowEndAt: "2026-01-01T00:01:00Z",
      });

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("summary.window_ready");
    });

    it("ignores events for other tasks", () => {
      const taskId = seedRealtimeTask(db);
      seedRealtimeTask(db, "task-other");
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);
      sent.length = 0;

      eventBus.emit("realtime:window_ready", {
        windowId: "win-other",
        taskId: "task-other",
        artifactName: "transcript",
        version: 1,
        windowStartAt: "2026-01-01T00:00:00Z",
        windowEndAt: "2026-01-01T00:01:00Z",
      });

      expect(sent.length).toBe(0);
    });

    it("forwards realtime:trigger_fired events", () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);
      sent.length = 0;

      const event: RealtimeTriggerFiredEvent = {
        windowId: "win-trigger",
        taskId,
        confidence: 0.85,
        decision: "triggered",
      };
      eventBus.emit("realtime:trigger_fired", event);

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("trigger.fired");
      expect(messages[0].window_id).toBe("win-trigger");
      expect(messages[0].confidence).toBe(0.85);
      expect(messages[0].decision).toBe("triggered");
    });

    it("forwards realtime:session_state events", () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);
      sent.length = 0;

      eventBus.emit("realtime:session_state", { taskId, state: "active" } as RealtimeSessionStateEvent);

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("session.state");
      expect(messages[0].state).toBe("active");
    });

    it("ignores realtime:session_state events for other tasks", () => {
      const taskId = seedRealtimeTask(db);
      seedRealtimeTask(db, "task-other-2");
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);
      sent.length = 0;

      eventBus.emit("realtime:session_state", { taskId: "task-other-2", state: "active" } as RealtimeSessionStateEvent);

      expect(sent.length).toBe(0);
    });

    it("forwards realtime:timeline_updated events", () => {
      const taskId = seedRealtimeTask(db);
      const { ws, sent } = createMockWs({ taskId, realtimeSessionManager: sessionManager });

      realtimeWsHandlers.open(ws);
      sent.length = 0;

      eventBus.emit("realtime:timeline_updated", {
        taskId,
        entryId: "timeline-1",
        entryType: "summary",
      } as RealtimeTimelineUpdatedEvent);

      const messages = parseSent(sent);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("timeline.updated");
      expect(messages[0].entry_id).toBe("timeline-1");
      expect(messages[0].entry_type).toBe("summary");
    });
  });
});
