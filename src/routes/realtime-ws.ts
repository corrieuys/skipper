import type { ServerWebSocket } from "bun";
import type { RealtimeSessionManager, InputChunk } from "../orchestrator/realtime-session";
import { logError } from "../logging";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";
import type { RealtimeWindowReadyEvent, RealtimeTriggerFiredEvent, RealtimeSessionStateEvent, RealtimeTimelineUpdatedEvent } from "../events/bus";
import type { WSData } from "../ws/types";

export type RealtimeWSData = WSData & { type: "realtime" };

/** Track per-connection event handlers for cleanup */
const wsCleanupHandlers = new WeakMap<ServerWebSocket<WSData>, () => void>();

/**
 * Handle WebSocket upgrade for realtime input ingestion.
 * Supports both spec URL /ws/tasks/:id/realtime and legacy /api/tasks/:id/realtime/ws
 */
export function tryUpgradeRealtimeWs(
  req: Request,
  server: import("bun").Server,
  realtimeSessionManager: RealtimeSessionManager,
): boolean {
  const url = new URL(req.url);
  // Support both: spec-compliant /ws/tasks/:id/realtime and legacy /api/tasks/:id/realtime/ws
  const specMatch = url.pathname.match(/^\/ws\/tasks\/([^/]+)\/realtime$/);
  const legacyMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/realtime\/ws$/);
  const match = specMatch || legacyMatch;
  if (!match) return false;

  const taskId = match[1];

  // Validate task exists and is real_time type
  try {
    const db = getDb();
    const taskRow = db
      .prepare("SELECT task_type, status FROM tasks WHERE id = ?")
      .get(taskId) as { task_type: string; status: string } | null;
    if (!taskRow || taskRow.task_type !== "real_time") {
      return false;
    }
  } catch {
    return false;
  }

  const upgraded = server.upgrade(req, {
    data: {
      type: "realtime" as const,
      taskId,
      realtimeSessionManager,
    } satisfies WSData & { type: "realtime" },
  });

  return upgraded;
}

export const realtimeWsHandlers = {
  open(ws: ServerWebSocket<WSData>) {
    const { taskId } = ws.data;

    // Send initial session state
    ws.send(JSON.stringify({
      type: "session.state",
      state: ws.data.realtimeSessionManager.isSessionActive(taskId) ? "active" : "paused",
    }));

    // Subscribe to event bus for live push events
    const windowHandler = (event: RealtimeWindowReadyEvent) => {
      if (event.taskId !== taskId) return;
      const msgType = event.artifactName === "summary"
        ? "summary.window_ready"
        : "transcript.window_ready";
      try {
        ws.send(JSON.stringify({
          type: msgType,
          window_id: event.windowId,
          artifact_name: event.artifactName,
          version: event.version,
          window_start_at: event.windowStartAt,
          window_end_at: event.windowEndAt,
        }));
      } catch { /* ws closed */ }
    };

    const triggerHandler = (event: RealtimeTriggerFiredEvent) => {
      if (event.taskId !== taskId) return;
      try {
        ws.send(JSON.stringify({
          type: "trigger.fired",
          window_id: event.windowId,
          confidence: event.confidence,
          decision: event.decision,
          delegation_id: event.delegationId,
        }));
      } catch { /* ws closed */ }
    };

    const sessionHandler = (event: RealtimeSessionStateEvent) => {
      if (event.taskId !== taskId) return;
      try {
        ws.send(JSON.stringify({ type: "session.state", state: event.state }));
      } catch { /* ws closed */ }
    };

    const timelineHandler = (event: RealtimeTimelineUpdatedEvent) => {
      if (event.taskId !== taskId) return;
      try {
        ws.send(JSON.stringify({
          type: "timeline.updated",
          entry_id: event.entryId,
          entry_type: event.entryType,
        }));
      } catch { /* ws closed */ }
    };

    eventBus.on("realtime:window_ready", windowHandler);
    eventBus.on("realtime:trigger_fired", triggerHandler);
    eventBus.on("realtime:session_state", sessionHandler);
    eventBus.on("realtime:timeline_updated", timelineHandler);

    // Store cleanup function for this connection
    wsCleanupHandlers.set(ws, () => {
      eventBus.off("realtime:window_ready", windowHandler);
      eventBus.off("realtime:trigger_fired", triggerHandler);
      eventBus.off("realtime:session_state", sessionHandler);
      eventBus.off("realtime:timeline_updated", timelineHandler);
    });
  },

  async message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
    const { taskId, realtimeSessionManager } = ws.data;

    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: "error", code: "INVALID_JSON", message: "Invalid JSON" }));
        return;
      }

      const msgType = parsed.type as string;

      switch (msgType) {
        case "ping": {
          ws.send(JSON.stringify({ type: "ack", ref: "ping" }));
          return;
        }

        case "session.start": {
          try {
            const result = realtimeSessionManager.startSession(taskId);
            ws.send(JSON.stringify({ type: "ack", ref: "session.start" }));
            ws.send(JSON.stringify({ type: "session.state", state: result.state }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", code: "SESSION_START_FAILED", message: msg }));
          }
          return;
        }

        case "session.stop": {
          try {
            const result = await realtimeSessionManager.stopSession(taskId);
            ws.send(JSON.stringify({ type: "ack", ref: "session.stop" }));
            ws.send(JSON.stringify({ type: "session.state", state: result.state }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", code: "SESSION_STOP_FAILED", message: msg }));
          }
          return;
        }

        case "session.resume": {
          try {
            const result = realtimeSessionManager.resumeSession(taskId);
            ws.send(JSON.stringify({ type: "ack", ref: "session.resume" }));
            ws.send(JSON.stringify({ type: "session.state", state: result.state }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", code: "SESSION_RESUME_FAILED", message: msg }));
          }
          return;
        }

        case "input.text": {
          const content = parsed.content as string;
          if (!content) {
            ws.send(JSON.stringify({ type: "error", code: "MISSING_CONTENT", message: "content field required for input.text" }));
            return;
          }
          const textInput: InputChunk = {
            sourceType: "text",
            contentBody: content,
            chunkStartAt: parsed.timestamp as string | undefined,
            chunkEndAt: parsed.timestamp as string | undefined,
          };
          await realtimeSessionManager.ingestInput(taskId, textInput);
          ws.send(JSON.stringify({ type: "ack", ref: "input.text" }));
          return;
        }

        case "recording.stopped": {
          // Wait for in-flight ingests + cadence ticks to finish, then transcribe
          // remaining segments — ensures whisper stays alive until all audio is done.
          try {
            await realtimeSessionManager.drainAndTranscribe(taskId);
          } catch (err) {
            logError(getDb(), "realtime_ws.recording_stopped_transcribe", { taskId }, err);
          }
          fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/whisper/stop`, { method: "POST" }).catch(() => {});
          ws.send(JSON.stringify({ type: "ack", ref: "recording.stopped" }));
          return;
        }

        case "input.audio_chunk": {
          const data = parsed.data as string;
          if (!data) {
            ws.send(JSON.stringify({ type: "error", code: "MISSING_DATA", message: "data field required for input.audio_chunk" }));
            return;
          }
          const format = (parsed.format as string) ?? "webm";
          console.log(`[realtime-ws] audio chunk received — task: ${taskId}, format: ${format}, base64 length: ${data.length}, timestamp: ${parsed.timestamp ?? "none"}`);
          const audioInput: InputChunk = {
            sourceType: "audio",
            contentType: `audio/${format}`,
            contentBody: data,
            chunkStartAt: parsed.timestamp as string | undefined,
            chunkEndAt: parsed.timestamp as string | undefined,
            metadata: { format, overlap_seconds: parsed.overlap_seconds ?? 0 },
          };
          await realtimeSessionManager.ingestInput(taskId, audioInput);
          ws.send(JSON.stringify({ type: "ack", ref: "input.audio_chunk" }));
          return;
        }

        default: {
          ws.send(JSON.stringify({ type: "error", code: "UNKNOWN_TYPE", message: `Unknown message type: ${msgType}` }));
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: "error", code: "INTERNAL_ERROR", message: msg }));
      logError(getDb(), "realtime_ws.message", { taskId }, err);
    }
  },

  close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
    // Clean up event bus subscriptions for this connection
    const cleanup = wsCleanupHandlers.get(ws);
    if (cleanup) {
      cleanup();
      wsCleanupHandlers.delete(ws);
    }
    void code;
    void reason;
  },
};
