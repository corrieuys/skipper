import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ArtifactManager } from "./artifact-manager";
import { RealtimeSessionManager } from "./realtime-session";
import { unlinkSync } from "fs";

const TEST_DB = "test-realtime-session.db";

let db: Database;
let artifactManager: ArtifactManager;
let sessionManager: RealtimeSessionManager;

function seedRealtimeTask(
  database: Database,
  id = "task-rt-1",
  config: Record<string, unknown> = {},
): string {
  database
    .prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)")
    .run("team-1", "Test Team");
  database
    .prepare(
      "INSERT INTO tasks (id, title, team_id, status, task_type, task_config) VALUES (?, ?, ?, 'running', 'real_time', ?)",
    )
    .run(id, "Realtime Task", "team-1", JSON.stringify(config));
  return id;
}

function seedRealtimeTaskWithoutTeam(
  database: Database,
  id = "task-rt-no-team",
  config: Record<string, unknown> = {},
): string {
  database
    .prepare(
      "INSERT INTO tasks (id, title, team_id, status, task_type, task_config) VALUES (?, ?, NULL, 'running', 'real_time', ?)",
    )
    .run(id, "Realtime Task Without Team", JSON.stringify(config));
  return id;
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
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch { }
});

describe("RealtimeSessionManager", () => {
  describe("startSession", () => {
    it("starts a session for a running realtime task", () => {
      const taskId = seedRealtimeTask(db);
      const result = sessionManager.startSession(taskId);
      expect(result.session_id).toBe(taskId);
      expect(result.state).toBe("active");
      expect(sessionManager.isSessionActive(taskId)).toBe(true);
    });

    it("initializes pipeline state in DB", () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      const row = db
        .prepare(
          "SELECT * FROM realtime_pipeline_state WHERE task_id = ?",
        )
        .get(taskId) as Record<string, unknown> | null;
      expect(row).not.toBeNull();
      expect(row!.cadence_timer_active).toBe(1);
    });

    it("throws if session already active", () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      expect(() => sessionManager.startSession(taskId)).toThrow(
        "Session already active",
      );
    });
  });

  describe("ingestInput", () => {
    it("stores text input in the database with transcription_status = not_applicable", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "Hello world",
      });

      const row = db
        .prepare("SELECT * FROM task_input_streams WHERE task_id = ?")
        .get(taskId) as Record<string, unknown> | null;
      expect(row).not.toBeNull();
      expect(row!.content_body).toBe("Hello world");
      expect(row!.source_type).toBe("text");
      expect(row!.sequence).toBe(1);
      expect(row!.transcription_status).toBe("not_applicable");
    });

    it("creates a timeline entry immediately for text inputs", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "User note: customer is VIP",
      });

      const timeline = db
        .prepare(
          "SELECT * FROM realtime_timeline WHERE task_id = ?",
        )
        .get(taskId) as Record<string, unknown> | null;
      expect(timeline).not.toBeNull();
      expect(timeline!.entry_type).toBe("text");
      expect(timeline!.content).toBe("User note: customer is VIP");
    });

    it("stores audio input with transcription_status = pending and no timeline entry", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "audio",
        contentBody: "base64-audio-data",
      });

      const row = db
        .prepare("SELECT * FROM task_input_streams WHERE task_id = ?")
        .get(taskId) as Record<string, unknown> | null;
      expect(row).not.toBeNull();
      expect(row!.source_type).toBe("audio");
      expect(row!.transcription_status).toBe("pending");

      // No timeline entry for audio (needs transcription + summarization first)
      const timeline = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ?",
        )
        .get(taskId) as { c: number };
      expect(timeline.c).toBe(0);
    });

    it("throws for inactive session", async () => {
      expect(
        sessionManager.ingestInput("no-session", {
          sourceType: "text",
          contentBody: "test",
        }),
      ).rejects.toThrow("No active session");
    });

    it("forces an immediate tick for text input when pipeline is idle", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "Immediate note",
      });

      // Immediate tick runs asynchronously; give it a brief turn.
      await Bun.sleep(30);

      const timeline = db
        .prepare(
          "SELECT content, fed_to_skipper FROM realtime_timeline WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(taskId) as { content: string; fed_to_skipper: number } | null;
      expect(timeline).not.toBeNull();
      expect(timeline!.content).toBe("Immediate note");
      expect(timeline!.fed_to_skipper).toBe(1);
    });

    it("does not force an immediate tick for text input when transcription is pending", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "audio",
        contentBody: "audio-payload",
      });
      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "Wait for cadence",
      });

      // If immediate tick were forced, pending audio would be processed/failed.
      await Bun.sleep(30);

      const pendingAudio = db
        .prepare(
          "SELECT transcription_status FROM task_input_streams WHERE task_id = ? AND source_type = 'audio' ORDER BY sequence DESC LIMIT 1",
        )
        .get(taskId) as { transcription_status: string } | null;
      expect(pendingAudio).not.toBeNull();
      expect(pendingAudio!.transcription_status).toBe("pending");

      const textTimeline = db
        .prepare(
          "SELECT fed_to_skipper FROM realtime_timeline WHERE task_id = ? AND entry_type = 'text' ORDER BY created_at DESC LIMIT 1",
        )
        .get(taskId) as { fed_to_skipper: number } | null;
      expect(textTimeline).not.toBeNull();
      expect(textTimeline!.fed_to_skipper).toBe(0);
    });
  });

  describe("processCadenceTick", () => {
    it("is a no-op when there are no pending segments", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.processCadenceTick(taskId);

      const timeline = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ?",
        )
        .get(taskId) as { c: number };
      expect(timeline.c).toBe(0);
    });

    it("marks audio segments as failed when no transcription endpoint configured", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "audio",
        contentBody: "audio-data",
      });

      await sessionManager.processCadenceTick(taskId);

      const row = db
        .prepare("SELECT * FROM task_input_streams WHERE task_id = ?")
        .get(taskId) as Record<string, unknown> | null;
      expect(row!.transcription_status).toBe("failed");

      // Error should appear in the timeline
      const timeline = db
        .prepare(
          "SELECT * FROM realtime_timeline WHERE task_id = ? AND entry_type = 'error'",
        )
        .get(taskId) as Record<string, unknown> | null;
      expect(timeline).not.toBeNull();
      expect((timeline!.content as string)).toContain("no whisper endpoint configured");
    });

    it("marks audio segments as failed when openai provider has no API key", async () => {
      // Set provider to openai but ensure no API key
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      db.prepare(
        "INSERT INTO realtime_config (key, value) VALUES ('transcription_provider', 'openai') ON CONFLICT(key) DO UPDATE SET value = 'openai'",
      ).run();

      try {
        const taskId = seedRealtimeTask(db);
        sessionManager.startSession(taskId);

        await sessionManager.ingestInput(taskId, {
          sourceType: "audio",
          contentBody: "audio-data",
        });

        await sessionManager.processCadenceTick(taskId);

        const row = db
          .prepare("SELECT * FROM task_input_streams WHERE task_id = ?")
          .get(taskId) as Record<string, unknown> | null;
        expect(row!.transcription_status).toBe("failed");

        const timeline = db
          .prepare(
            "SELECT * FROM realtime_timeline WHERE task_id = ? AND entry_type = 'error'",
          )
          .get(taskId) as Record<string, unknown> | null;
        expect(timeline).not.toBeNull();
        expect((timeline!.content as string)).toContain("OPENAI_API_KEY");
      } finally {
        if (originalKey !== undefined) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it("uses the recorded segment format when transcribing audio", async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      const originalFetch = globalThis.fetch;
      process.env.OPENAI_API_KEY = "sk-test-key";

      db.prepare(
        "INSERT INTO realtime_config (key, value) VALUES ('transcription_provider', 'openai') ON CONFLICT(key) DO UPDATE SET value = 'openai'",
      ).run();

      let capturedFile: File | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        const formData = init?.body as FormData;
        capturedFile = formData.get("file") as File | null;
        return new Response(JSON.stringify({ text: "transcribed from mp3" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const taskId = seedRealtimeTask(db);
        sessionManager.startSession(taskId);

        await sessionManager.ingestInput(taskId, {
          sourceType: "audio",
          contentType: "audio/mp3",
          contentBody: Buffer.from("fake-mp3-audio").toString("base64"),
          metadata: { format: "mp3" },
        });

        await sessionManager.processCadenceTick(taskId);

        const row = db
          .prepare("SELECT transcription_status, transcribed_text FROM task_input_streams WHERE task_id = ?")
          .get(taskId) as { transcription_status: string; transcribed_text: string | null } | null;
        expect(row).not.toBeNull();
        expect(row!.transcription_status).toBe("transcribed");
        expect(row!.transcribed_text).toBe("transcribed from mp3");
        expect(capturedFile).not.toBeNull();
        expect(capturedFile!.name).toBe("audio.mp3");
        expect(capturedFile!.type).toBe("audio/mpeg");
      } finally {
        globalThis.fetch = originalFetch;
        if (originalKey !== undefined) {
          process.env.OPENAI_API_KEY = originalKey;
        } else {
          delete process.env.OPENAI_API_KEY;
        }
      }
    });
  });

  describe("summarization (via processCadenceTick)", () => {
    it("creates a timeline entry from transcribed audio segments (fallback when no summarizer agent)", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      // Manually insert a transcribed segment (simulating completed transcription)
      const segId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO task_input_streams (id, task_id, source_type, content_type, content_body, sequence, transcription_status, transcribed_text)
         VALUES (?, ?, 'audio', 'audio/wav', 'raw-audio', 1, 'transcribed', 'The customer asked about billing.')`,
      ).run(segId, taskId);

      // Run cadence tick — transcription step will find nothing pending,
      // summarization step should pick up the transcribed segment
      await sessionManager.processCadenceTick(taskId);

      const timeline = db
        .prepare(
          "SELECT * FROM realtime_timeline WHERE task_id = ? AND entry_type = 'summary'",
        )
        .get(taskId) as Record<string, unknown> | null;
      expect(timeline).not.toBeNull();
      expect(timeline!.entry_type).toBe("summary");
      expect((timeline!.content as string)).toContain(
        "The customer asked about billing.",
      );

      // Verify segment was linked to the timeline entry via summary_batch_id
      const seg = db
        .prepare("SELECT summary_batch_id FROM task_input_streams WHERE id = ?")
        .get(segId) as { summary_batch_id: string | null };
      expect(seg.summary_batch_id).toBe(timeline!.id);
    });

    it("does not create artifacts from raw transcript fallback (no summarizer)", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const segId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO task_input_streams (id, task_id, source_type, content_type, content_body, sequence, transcription_status, transcribed_text)
         VALUES (?, ?, 'audio', 'audio/wav', 'raw-audio', 1, 'transcribed', 'Agent offered 20% discount.')`,
      ).run(segId, taskId);

      await sessionManager.processCadenceTick(taskId);

      // Raw transcript fallback should NOT create artifacts — only timeline entries
      const artifact = artifactManager.getArtifact(
        taskId,
        "realtime-summary",
      );
      expect(artifact).toBeNull();

      // But the timeline entry should still exist
      const timeline = db
        .prepare(
          "SELECT * FROM realtime_timeline WHERE task_id = ? AND entry_type = 'summary'",
        )
        .get(taskId) as Record<string, unknown> | null;
      expect(timeline).not.toBeNull();
      expect((timeline!.content as string)).toContain("Agent offered 20% discount.");
    });

    it("does not re-summarize already batched segments", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      const segId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO task_input_streams (id, task_id, source_type, content_type, content_body, sequence, transcription_status, transcribed_text, summary_batch_id)
         VALUES (?, ?, 'audio', 'audio/wav', 'raw', 1, 'transcribed', 'Already summarized.', 'batch-1')`,
      ).run(segId, taskId);

      await sessionManager.processCadenceTick(taskId);

      const timeline = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ?",
        )
        .get(taskId) as { c: number };
      expect(timeline.c).toBe(0);
    });
  });

  describe("feedSkipper", () => {
    it("collects unfed timeline entries and marks them as fed", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      // Seed two unfed timeline entries directly.
      db.prepare(
        `INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper)
         VALUES (?, ?, 'text', ?, 0)`,
      ).run("tl-feed-1", taskId, "First note");
      db.prepare(
        `INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper)
         VALUES (?, ?, 'text', ?, 0)`,
      ).run("tl-feed-2", taskId, "Second note");

      // Verify both are unfed
      const unfedBefore = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0",
        )
        .get(taskId) as { c: number };
      expect(unfedBefore.c).toBe(2);

      // Feed Skipper (no agent manager, so it just marks entries as fed)
      sessionManager.feedSkipper(taskId);

      // Verify all are now fed
      const unfedAfter = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0",
        )
        .get(taskId) as { c: number };
      expect(unfedAfter.c).toBe(0);

      const fedCount = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 1",
        )
        .get(taskId) as { c: number };
      expect(fedCount.c).toBe(2);
    });

    it("is a no-op when no unfed entries exist", () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      // Should not throw
      sessionManager.feedSkipper(taskId);
    });

    it("falls back to default skipper entrypoint for realtime tasks without team", async () => {
      const taskId = seedRealtimeTaskWithoutTeam(db, "task-rt-fallback");
      db.prepare(
        "INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'claude-code', 'default')",
      ).run();

      let spawned = false;
      const sentInputs: string[] = [];
      const running = { process: { pid: 4242 } };
      const fakeAgentManager = {
        getRunningAgent: () => (spawned ? running : undefined),
        clearSessionId: () => { },
        spawnAgent: async () => {
          spawned = true;
          return running;
        },
        sendInput: (_agentId: string, input: string) => {
          sentInputs.push(input);
        },
        getSessionId: () => "sess-fallback",
        getEntrypointSessionIdForTask: () => "sess-fallback",
      } as unknown as RealtimeSessionManager["agentManager"];

      const managerWithAgent = new RealtimeSessionManager(
        db,
        artifactManager,
        fakeAgentManager,
      );

      expect(managerWithAgent.isSessionActive(taskId)).toBe(true);
      await managerWithAgent.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "hello realtime",
      });

      managerWithAgent.feedSkipper(taskId);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spawned).toBe(true);
      expect(sentInputs.length).toBe(1);
      managerWithAgent.dispose();
    });

    it("uses main skipper prompt when realtime prompt is empty", async () => {
      const taskId = seedRealtimeTaskWithoutTeam(db, "task-rt-prompt-fallback");
      db.prepare(
        "INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'claude-code', 'default')",
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO skipper_config (key, value) VALUES ('prompt', 'MAIN SKIPPER PROMPT')",
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO skipper_config (key, value) VALUES ('realtime_prompt', '')",
      ).run();

      let spawned = false;
      const sentInputs: string[] = [];
      const running = { process: { pid: 4243 } };
      const fakeAgentManager = {
        getRunningAgent: () => (spawned ? running : undefined),
        clearSessionId: () => { },
        spawnAgent: async () => {
          spawned = true;
          return running;
        },
        sendInput: (_agentId: string, input: string) => {
          sentInputs.push(input);
        },
        getSessionId: () => null,
        getEntrypointSessionIdForTask: () => null,
      } as unknown as RealtimeSessionManager["agentManager"];

      const managerWithAgent = new RealtimeSessionManager(
        db,
        artifactManager,
        fakeAgentManager,
      );

      expect(managerWithAgent.isSessionActive(taskId)).toBe(true);
      await managerWithAgent.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "feed me",
      });

      managerWithAgent.feedSkipper(taskId);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sentInputs.length).toBe(1);
      expect(sentInputs[0]).toContain("MAIN SKIPPER PROMPT");
      expect(sentInputs[0]).toContain("[REALTIME_FEED]");
      managerWithAgent.dispose();
    });
  });

  describe("stopSession (pause)", () => {
    it("flushes feedSkipper and pauses without completing task", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "trailing content",
      });

      const result = await sessionManager.stopSession(taskId);
      expect(result.state).toBe("paused");
      expect(result.session_id).toBe(taskId);
      expect(sessionManager.isSessionActive(taskId)).toBe(false);

      // Timeline entries should be marked as fed (from final feedSkipper)
      const unfed = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0",
        )
        .get(taskId) as { c: number };
      expect(unfed.c).toBe(0);

      // No session-summary artifact (stop is now pause, not finalize)
      const summary = artifactManager.getArtifact(taskId, "session-summary");
      expect(summary).toBeNull();
    });

    it("updates pipeline state to inactive", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      await sessionManager.stopSession(taskId);

      const state = db
        .prepare(
          "SELECT cadence_timer_active FROM realtime_pipeline_state WHERE task_id = ?",
        )
        .get(taskId) as { cadence_timer_active: number } | null;
      expect(state).not.toBeNull();
      expect(state!.cadence_timer_active).toBe(0);
    });

    it("returns paused for non-existent session", async () => {
      const result = await sessionManager.stopSession("nonexistent");
      expect(result.state).toBe("paused");
    });
  });

  describe("resumeSession", () => {
    it("resumes a paused session", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      await sessionManager.stopSession(taskId);
      expect(sessionManager.isSessionActive(taskId)).toBe(false);

      const result = sessionManager.resumeSession(taskId);
      expect(result.state).toBe("active");
      expect(result.session_id).toBe(taskId);
      expect(sessionManager.isSessionActive(taskId)).toBe(true);
    });

    it("picks up sequence counter from DB", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "first",
      });
      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "second",
      });

      await sessionManager.stopSession(taskId);
      sessionManager.resumeSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "third after resume",
      });

      // Sequence should continue from 2 → 3
      const rows = db
        .prepare(
          "SELECT sequence FROM task_input_streams WHERE task_id = ? ORDER BY sequence",
        )
        .all(taskId) as { sequence: number }[];
      expect(rows.length).toBe(3);
      expect(rows[2].sequence).toBe(3);
    });

    it("throws if session already active", () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      expect(() => sessionManager.resumeSession(taskId)).toThrow(
        "Session already active",
      );
    });

    it("sets pipeline state to active", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      await sessionManager.stopSession(taskId);

      const stateBefore = db
        .prepare(
          "SELECT cadence_timer_active FROM realtime_pipeline_state WHERE task_id = ?",
        )
        .get(taskId) as { cadence_timer_active: number };
      expect(stateBefore.cadence_timer_active).toBe(0);

      sessionManager.resumeSession(taskId);

      const stateAfter = db
        .prepare(
          "SELECT cadence_timer_active FROM realtime_pipeline_state WHERE task_id = ?",
        )
        .get(taskId) as { cadence_timer_active: number };
      expect(stateAfter.cadence_timer_active).toBe(1);
    });
  });

  describe("closeSession (cancel/fail)", () => {
    it("force-closes without finalization or summary", () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      sessionManager.closeSession(taskId);
      expect(sessionManager.isSessionActive(taskId)).toBe(false);

      // No summary artifact should be created
      const summary = artifactManager.getArtifact(taskId, "session-summary");
      expect(summary).toBeNull();
    });

    it("force-closes even with pending input (no finalization)", async () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "some pending content",
      });

      sessionManager.closeSession(taskId);
      expect(sessionManager.isSessionActive(taskId)).toBe(false);

      // Timeline entries remain present (session close should not delete them).
      const timeline = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ?",
        )
        .get(taskId) as { c: number };
      expect(timeline.c).toBe(1);
    });
  });

  describe("isSkipperBusy / deferred feeding", () => {
    function seedTestAgents(database: Database): void {
      // Seed agents needed for delegation FK constraints
      database.prepare(
        "INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'claude-code', 'default')",
      ).run();
      database.prepare(
        "INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('worker-1', 'Worker', 'claude-code', 'default')",
      ).run();
      // Set skipper as entrypoint so isSkipperBusy can find it
      database.prepare(
        "UPDATE teams SET entrypoint_agent_id = 'skipper' WHERE id = 'team-1'",
      ).run();
    }

    it("returns false when no agent manager is set (no agents to be busy)", () => {
      const taskId = seedRealtimeTask(db);
      sessionManager.startSession(taskId);
      expect(sessionManager.isSkipperBusy(taskId)).toBe(false);
    });

    it("returns true when Skipper has active delegations", () => {
      const taskId = seedRealtimeTask(db);
      seedTestAgents(db);
      sessionManager.startSession(taskId);

      db.prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
         VALUES (?, 'skipper', 'worker-1', 'skipper', 'worker-1', ?, 'do something', 'running')`,
      ).run("del-1", taskId);

      expect(sessionManager.isSkipperBusy(taskId)).toBe(true);
    });

    it("returns true when Skipper has an active delegation group", () => {
      const taskId = seedRealtimeTask(db);
      seedTestAgents(db);
      sessionManager.startSession(taskId);

      // delegation_groups.parent_instance_id references agent_instances(id)
      db.prepare(
        `INSERT INTO agent_instances (id, task_id, template_agent_id, root_instance_id, status)
         VALUES ('skipper', ?, 'skipper', 'skipper', 'running')`,
      ).run(taskId);

      db.prepare(
        `INSERT INTO delegation_groups (id, task_id, parent_instance_id, expected_count, status)
         VALUES (?, ?, 'skipper', 3, 'running')`,
      ).run("grp-1", taskId);

      expect(sessionManager.isSkipperBusy(taskId)).toBe(true);
    });

    it("returns false when delegation is completed", () => {
      const taskId = seedRealtimeTask(db);
      seedTestAgents(db);
      sessionManager.startSession(taskId);

      db.prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
         VALUES (?, 'skipper', 'worker-1', 'skipper', 'worker-1', ?, 'do something', 'completed')`,
      ).run("del-done", taskId);

      expect(sessionManager.isSkipperBusy(taskId)).toBe(false);
    });

    it("defers feedSkipper during cadence tick when Skipper has active delegations", async () => {
      const taskId = seedRealtimeTask(db);
      seedTestAgents(db);
      sessionManager.startSession(taskId);

      db.prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
         VALUES (?, 'skipper', 'worker-1', 'skipper', 'worker-1', ?, 'investigating issue', 'running')`,
      ).run("del-active", taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "Message while skipper is busy",
      });

      await sessionManager.processCadenceTick(taskId);

      // Timeline entry should remain unfed (accumulated for next feed)
      const unfed = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0",
        )
        .get(taskId) as { c: number };
      expect(unfed.c).toBe(1);

      // Pipeline state should show busy
      const state = db
        .prepare("SELECT analyst_status FROM realtime_pipeline_state WHERE task_id = ?")
        .get(taskId) as { analyst_status: string };
      expect(state.analyst_status).toBe("busy");
    });

    it("feeds accumulated entries once Skipper becomes idle", async () => {
      const taskId = seedRealtimeTask(db);
      seedTestAgents(db);
      sessionManager.startSession(taskId);

      // Keep Skipper busy first so entries accumulate unfed.
      db.prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
         VALUES (?, 'skipper', 'worker-1', 'skipper', 'worker-1', ?, 'work', 'running')`,
      ).run("del-block", taskId);

      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "First message",
      });
      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "Second message",
      });

      await sessionManager.processCadenceTick(taskId);

      let unfed = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0",
        )
        .get(taskId) as { c: number };
      expect(unfed.c).toBe(2);

      // Now mark delegation as completed (Skipper is idle)
      db.prepare("UPDATE delegations SET status = 'completed' WHERE id = ?")
        .run("del-block");

      // Add a third message
      await sessionManager.ingestInput(taskId, {
        sourceType: "text",
        contentBody: "Third message after unblock",
      });

      // Immediate tick is triggered on text input when idle; give it a turn.
      await Bun.sleep(30);

      unfed = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0",
        )
        .get(taskId) as { c: number };
      expect(unfed.c).toBe(0);

      const fedCount = db
        .prepare(
          "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 1",
        )
        .get(taskId) as { c: number };
      expect(fedCount.c).toBe(3);

      // Pipeline state should show idle
      const state = db
        .prepare("SELECT analyst_status FROM realtime_pipeline_state WHERE task_id = ?")
        .get(taskId) as { analyst_status: string };
      expect(state.analyst_status).toBe("idle");
    });
  });

  describe("getActiveSessionCount", () => {
    it("tracks active session count", () => {
      const t1 = seedRealtimeTask(db, "rt-1");
      const t2 = seedRealtimeTask(db, "rt-2");
      expect(sessionManager.getActiveSessionCount()).toBe(0);

      sessionManager.startSession(t1);
      expect(sessionManager.getActiveSessionCount()).toBe(1);

      sessionManager.startSession(t2);
      expect(sessionManager.getActiveSessionCount()).toBe(2);

      sessionManager.closeSession(t1);
      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });
  });
});
