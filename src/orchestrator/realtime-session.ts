import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { ArtifactManager } from "./artifact-manager";
import type { AgentManager } from "../agents/manager";
import type { TaskScheduler } from "../tasks/scheduler";
import { eventBus } from "../events/bus";
import { logError } from "../logging";
import { getRealtimeConfig } from "../realtime/config";
import { createTranscriptionAdapter } from "../realtime/transcription";
import { getSkipperConfig, getEntrypointAgentId } from "../agents/skipper";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { deduplicateOverlap } from "../realtime/dedup";
import { unlinkSync, readdirSync } from "fs";

export interface InputChunk {
  sourceType: "audio" | "text";
  sourceRef?: string;
  contentType?: string;
  contentBody: string;
  chunkStartAt?: string;
  chunkEndAt?: string;
  metadata?: Record<string, unknown>;
}

interface ActiveSession {
  taskId: string;
  cadenceTimer: ReturnType<typeof setInterval> | null;
  sequenceCounter: number;
  stopped: boolean;
  tickInProgress: boolean;
  ingestInProgress: number;
}

interface SummarizerRun {
  taskId: string;
  segmentIds: string[];
  result: string | null;
}

export class RealtimeSessionManager {
  private db: Database;
  private artifactManager: ArtifactManager;
  private agentManager: AgentManager | null;
  private sessions: Map<string, ActiveSession> = new Map();
  private activeSummarizerRuns: Map<string, SummarizerRun> = new Map();
  private disposed = false;
  private readonly onAgentSignal = (event: import("../events/bus").AgentSignalEvent): void => {
    this.handleSummarizerSignal(event);
  };
  private readonly onAgentExit = (event: import("../events/bus").AgentExitEvent): void => {
    this.handleSummarizerExit(event);
  };

  private emitTimelineUpdated(taskId: string, entryId: string, entryType: string): void {
    eventBus.emit("realtime:timeline_updated", { taskId, entryId, entryType });
  }

  constructor(
    db?: Database,
    artifactManager?: ArtifactManager,
    agentManager?: AgentManager | null,
    _taskScheduler?: TaskScheduler | null,
  ) {
    this.db = db ?? getDb();
    this.artifactManager = artifactManager ?? new ArtifactManager(this.db);
    this.agentManager = agentManager ?? null;

    // Clean up any stale temp files from a previous crash
    RealtimeSessionManager.cleanupStaleTempFiles();

    // Resume sessions for any tasks that were running before a server restart
    this.autoResumeSessions();

    // Listen for summarizer agent signals and exits
    eventBus.on("agent:signal", this.onAgentSignal);
    eventBus.on("agent:exit", this.onAgentExit);
  }

  /**
   * Remove any leftover /tmp/skipper-*.webm and /tmp/skipper-*.wav files
   * from prior runs that may have crashed mid-transcription.
   */
  static cleanupStaleTempFiles(): void {
    try {
      const files = readdirSync("/tmp");
      for (const f of files) {
        if (f.startsWith("skipper-") && (f.endsWith(".webm") || f.endsWith(".wav"))) {
          // Best effort: stale temp audio — another process may have removed it.
          try { unlinkSync(`/tmp/${f}`); } catch { }
        }
      }
    } catch { /* best effort: /tmp unreadable — skip cleanup */ }
  }

  startSession(taskId: string): { session_id: string; state: string } {
    if (this.sessions.has(taskId)) {
      throw new Error("Session already active for this task");
    }

    const config = getRealtimeConfig(this.db);

    // Initialize pipeline state
    this.db
      .prepare(
        `INSERT INTO realtime_pipeline_state (task_id, cadence_timer_active) VALUES (?, 1)
         ON CONFLICT(task_id) DO UPDATE SET
           cadence_timer_active = 1,
           updated_at = datetime('now')`,
      )
      .run(taskId);

    const session: ActiveSession = {
      taskId,
      cadenceTimer: null,
      sequenceCounter: this.getMaxSequence(taskId),
      stopped: false,
      tickInProgress: false,
      ingestInProgress: 0,
    };
    this.sessions.set(taskId, session);

    // Start cadence timer
    console.log(`[realtime-session] startSession: task=${taskId} cadence=${config.cadence_seconds}s`);
    session.cadenceTimer = setInterval(() => {
      this.processCadenceTick(taskId).catch((err) => {
        logError(this.db, "realtime.cadence_tick", { taskId }, err);
      });
    }, config.cadence_seconds * 1000);

    eventBus.emit("realtime:session_state", { taskId, state: "active" });
    return { session_id: taskId, state: "active" };
  }

  async ingestInput(taskId: string, input: InputChunk): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session || session.stopped) {
      throw new Error("No active session for this task");
    }

    session.ingestInProgress++;
    try {
      session.sequenceCounter++;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      // Determine transcription status based on source type
      const transcriptionStatus =
        input.sourceType === "text" ? "not_applicable" : "pending";

      console.log(`[realtime-session] ingestInput: task=${taskId} type=${input.sourceType} seq=${session.sequenceCounter} status=${transcriptionStatus} size=${input.contentBody.length}`);

      this.db
        .prepare(
          `INSERT INTO task_input_streams (id, task_id, source_type, source_ref, content_type, content_body, chunk_start_at, chunk_end_at, sequence, metadata, transcription_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          taskId,
          input.sourceType,
          input.sourceRef ?? null,
          input.contentType ?? "text/plain",
          input.contentBody,
          input.chunkStartAt ?? now,
          input.chunkEndAt ?? now,
          session.sequenceCounter,
          input.metadata ? JSON.stringify(input.metadata) : "{}",
          transcriptionStatus,
        );

      // For text inputs: immediately create a timeline entry
      if (input.sourceType === "text") {
        const timelineId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO realtime_timeline (id, task_id, entry_type, content, source_segment_ids, priority)
             VALUES (?, ?, 'text', ?, ?, 'high')`,
          )
          .run(timelineId, taskId, input.contentBody, JSON.stringify([id]));
        this.emitTimelineUpdated(taskId, timelineId, "text");
      }

      eventBus.emit("realtime:window_ready", {
        windowId: id,
        taskId,
        artifactName: input.sourceType === "text" ? "text-input" : "audio-input",
        version: session.sequenceCounter,
        windowStartAt: input.chunkStartAt ?? now,
        windowEndAt: input.chunkEndAt ?? now,
      });

      // For manual text input, don't wait for cadence when the pipeline is idle.
      // This keeps realtime tasks responsive for note/message-style interactions.
      if (input.sourceType === "text" && this.shouldForceImmediateTick(taskId)) {
        console.log(`[realtime-session] ingestInput: task=${taskId} forcing immediate tick after text input`);
        this.processCadenceTick(taskId).catch((err) => {
          logError(this.db, "realtime.immediate_tick", { taskId, sourceType: "text" }, err);
        });
      }
    } finally {
      session.ingestInProgress--;
    }
  }

  private shouldForceImmediateTick(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session || session.stopped || session.tickInProgress) return false;

    // Only force when the entrypoint/delegations are idle.
    if (this.isSkipperBusy(taskId)) return false;

    // If transcription is already queued or in-flight, let cadence handle it.
    const pendingTranscription = (this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM task_input_streams WHERE task_id = ? AND transcription_status = 'pending'",
      )
      .get(taskId) as { c: number }).c;
    if (pendingTranscription > 0) return false;

    // If a summarizer run is currently active for this task, avoid overlapping work.
    const summarizerInFlight = Array.from(this.activeSummarizerRuns.values())
      .some((run) => run.taskId === taskId);
    if (summarizerInFlight) return false;

    // If segments are currently marked as pending summary, wait for that flow to settle.
    const pendingSummary = (this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM task_input_streams WHERE task_id = ? AND summary_batch_id LIKE 'pending:%'",
      )
      .get(taskId) as { c: number }).c;
    if (pendingSummary > 0) return false;

    return true;
  }

  async processCadenceTick(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session || session.stopped) return;

    if (session.tickInProgress) {
      console.log(`[realtime-session] cadenceTick: task=${taskId} SKIPPED (previous tick still running)`);
      return;
    }

    session.tickInProgress = true;
    try {
      console.log(`[realtime-session] cadenceTick: task=${taskId}`);
      // Transcription and summarization always run — they fill the timeline
      // even while Skipper is busy processing prior entries.
      await this.transcribePendingSegments(taskId);
      this.spawnSummarizer(taskId);

      // Only feed Skipper if it (and any delegated sub-agents) are idle.
      // While Skipper is busy, unfed timeline entries accumulate and will
      // be batched into the next feed once Skipper becomes available.
      if (this.isSkipperBusy(taskId)) {
        const unfedCount = (this.db
          .prepare(
            "SELECT COUNT(*) as c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0",
          )
          .get(taskId) as { c: number }).c;
        console.log(`[realtime-session] cadenceTick: task=${taskId} SKIPPER BUSY — deferring feed (${unfedCount} unfed entries accumulating)`);

        // Persist the busy state so it survives restarts
        this.db
          .prepare(
            `UPDATE realtime_pipeline_state SET analyst_status = 'busy', updated_at = datetime('now') WHERE task_id = ?`,
          )
          .run(taskId);
      } else {
        // Update pipeline state to idle before feeding
        this.db
          .prepare(
            `UPDATE realtime_pipeline_state SET analyst_status = 'idle', updated_at = datetime('now') WHERE task_id = ?`,
          )
          .run(taskId);

        this.feedSkipper(taskId);
      }
    } finally {
      session.tickInProgress = false;
    }
  }

  /**
   * Check whether Skipper or any of its delegated sub-agents are currently busy.
   * Returns true if Skipper should NOT be fed new timeline entries.
   *
   * Skipper is considered busy when:
   * 1. Its process is running (mid-response), OR
   * 2. It has active delegations (children pending/running) — even if Skipper's
   *    own process has exited, it's waiting for delegation results, OR
   * 3. It has an active delegation group (batch delegation in progress)
   */
  isSkipperBusy(taskId: string): boolean {
    const entrypointAgentId = this.resolveRealtimeEntrypointAgentId(taskId);
    if (!entrypointAgentId) return false;

    // 1. Entrypoint process is currently running (producing output)
    if (this.agentManager) {
      const runningAgent = this.agentManager.getRunningAgent(entrypointAgentId);
      if (runningAgent) {
        return true;
      }
    }

    // 2. Entrypoint has active individual delegations (children still working)
    // parent_instance_id may be the template ID (legacy/template-keyed row) or
    // a runtime UUID whose template_agent_id matches. Check both.
    const activeDelegation = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM delegations
         WHERE (parent_instance_id = ? OR parent_instance_id IN (
           SELECT id FROM agent_instances WHERE template_agent_id = ? AND task_id = ?
         )) AND task_id = ? AND status IN ('pending', 'running')`,
      )
      .get(entrypointAgentId, entrypointAgentId, taskId, taskId) as { c: number };
    if (activeDelegation.c > 0) {
      return true;
    }

    // 3. Entrypoint has an active delegation group (batch delegation)
    const activeGroup = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM delegation_groups
         WHERE (parent_instance_id = ? OR parent_instance_id IN (
           SELECT id FROM agent_instances WHERE template_agent_id = ? AND task_id = ?
         )) AND task_id = ? AND status = 'running'`,
      )
      .get(entrypointAgentId, entrypointAgentId, taskId, taskId) as { c: number };
    if (activeGroup.c > 0) {
      return true;
    }

    return false;
  }

  /**
   * Resolve the realtime entrypoint agent for a task.
   * Realtime tasks may not have a team, so we fall back to the default Skipper agent.
   */
  private resolveRealtimeEntrypointAgentId(taskId: string): string | null {
    const teamEntrypoint = getEntrypointAgentId(this.db, taskId);
    if (teamEntrypoint) return teamEntrypoint;

    const skipperRow = this.db
      .prepare("SELECT id FROM agents WHERE id = 'skipper'")
      .get() as { id: string } | null;
    return skipperRow?.id ?? null;
  }

  async transcribePendingForTask(taskId: string): Promise<void> {
    return this.transcribePendingSegments(taskId);
  }

  async drainAndTranscribe(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) {
      await this.transcribePendingSegments(taskId);
      return;
    }

    // Wait for in-flight ingestInput calls (last audio chunk being inserted)
    if (session.ingestInProgress > 0) {
      console.log(`[realtime-session] drainAndTranscribe: task=${taskId} waiting for ${session.ingestInProgress} in-flight ingests`);
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (session.ingestInProgress <= 0) { clearInterval(check); resolve(); }
        }, 50);
      });
    }

    // Wait for in-flight cadence tick (may be mid-transcription)
    if (session.tickInProgress) {
      console.log(`[realtime-session] drainAndTranscribe: task=${taskId} waiting for cadence tick to finish`);
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!session.tickInProgress) { clearInterval(check); resolve(); }
        }, 100);
      });
    }

    // Transcribe any remaining pending segments
    await this.transcribePendingSegments(taskId);
  }

  private async transcribePendingSegments(taskId: string): Promise<void> {
    const config = getRealtimeConfig(this.db);
    const adapter = createTranscriptionAdapter(config);

    const pending = this.db
      .prepare(
        "SELECT * FROM task_input_streams WHERE task_id = ? AND transcription_status = 'pending' ORDER BY sequence",
      )
      .all(taskId) as Array<{
        id: string;
        content_body: string;
        sequence: number;
        metadata: string;
      }>;

    console.log(`[realtime-session] transcribePending: task=${taskId} provider=${config.transcription_provider} pending=${pending.length} configured=${adapter.isConfigured()}`);
    if (pending.length === 0) return;

    if (!adapter.isConfigured()) {
      for (const segment of pending) {
        this.db
          .prepare(
            "UPDATE task_input_streams SET transcription_status = 'failed', transcribed_text = ?, content_body = '' WHERE id = ?",
          )
          .run(`[${adapter.notConfiguredReason()}]`, segment.id);
      }

      const timelineId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO realtime_timeline (id, task_id, entry_type, content, source_segment_ids)
           VALUES (?, ?, 'error', ?, ?)`,
        )
        .run(
          timelineId,
          taskId,
          `Transcription failed: ${adapter.notConfiguredReason()}`,
          JSON.stringify(pending.map((s) => s.id)),
        );
      this.emitTimelineUpdated(taskId, timelineId, "error");
      return;
    }

    // Process in parallel batches of 5
    const BATCH_SIZE = 5;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (segment) => {
          let format = "webm";
          try {
            const meta = JSON.parse(segment.metadata || "{}") as { format?: unknown };
            if (typeof meta.format === "string" && meta.format.trim()) {
              format = meta.format.trim();
            }
          } catch { /* metadata parse failure — fall back to webm */ }

          const transcribed = await adapter.transcribe(
            segment.content_body,
            format,
          );
          return { id: segment.id, text: transcribed };
        }),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const segment = batch[j];

        if (result.status === "fulfilled") {
          let finalText = result.value.text;

          // Deduplicate overlap: if this segment was recorded with audio overlap,
          // the first few seconds duplicate the tail of the previous segment.
          try {
            const meta = JSON.parse(segment.metadata || "{}");
            if (meta.overlap_seconds > 0) {
              const prevSegment = this.db
                .prepare(
                  "SELECT transcribed_text FROM task_input_streams WHERE task_id = ? AND sequence < ? AND transcription_status = 'transcribed' ORDER BY sequence DESC LIMIT 1",
                )
                .get(taskId, segment.sequence) as { transcribed_text: string | null } | null;

              if (prevSegment?.transcribed_text) {
                finalText = deduplicateOverlap(prevSegment.transcribed_text, finalText);
              }
            }
          } catch { /* metadata parse failure — skip dedup */ }

          // Strip whisper filler/pause markers and check if anything meaningful remains
          const strippedText = finalText
            .replace(/\[pause\]/gi, "")
            .replace(/\[silence\]/gi, "")
            .replace(/\[blank_audio\]/gi, "")
            .replace(/\[music\]/gi, "")
            .trim();

          if (!strippedText || strippedText.split(/\s+/).length < 3) {
            // Too short / only filler — mark as transcribed but empty
            this.db
              .prepare(
                "UPDATE task_input_streams SET transcription_status = 'transcribed', transcribed_text = '', content_body = '' WHERE id = ?",
              )
              .run(segment.id);
          } else {
            this.db
              .prepare(
                "UPDATE task_input_streams SET transcription_status = 'transcribed', transcribed_text = ?, content_body = '' WHERE id = ?",
              )
              .run(strippedText, segment.id);
          }
        } else {
          const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.db
            .prepare(
              "UPDATE task_input_streams SET transcription_status = 'failed', transcribed_text = ?, content_body = '' WHERE id = ?",
            )
            .run(`[Transcription failed: ${errorMessage}]`, segment.id);

          const timelineId = crypto.randomUUID();
          this.db
            .prepare(
              `INSERT INTO realtime_timeline (id, task_id, entry_type, content, source_segment_ids)
               VALUES (?, ?, 'error', ?, ?)`,
            )
            .run(
              timelineId,
              taskId,
              `Transcription failed: ${errorMessage}`,
              JSON.stringify([segment.id]),
            );
          this.emitTimelineUpdated(taskId, timelineId, "error");

          logError(
            this.db,
            "realtime.transcription",
            { taskId, segmentId: segment.id },
            result.reason,
          );
        }
      }
    }
  }

  /**
   * Find the summarizer agent configured for a task (agent with "summarization" capability).
   */
  private findSummarizerAgent(taskId: string): { id: string; name: string; type: string } | null {
    const cfg = this.getRealtimeTaskConfig(taskId);
    const candidates: string[] = [];
    if (cfg.summarizer_agent_id && cfg.summarizer_agent_id.trim()) {
      candidates.push(cfg.summarizer_agent_id.trim());
    }
    candidates.push("realtime-summarizer");

    const teamRows = this.db
      .prepare(
        `SELECT ta.agent_id
         FROM tasks t
         JOIN team_agents ta ON ta.team_id = t.team_id
         WHERE t.id = ? AND ta.agent_id != 'skipper'`,
      )
      .all(taskId) as Array<{ agent_id: string }>;
    for (const row of teamRows) {
      const id = row.agent_id;
      if (!candidates.includes(id)) candidates.push(id);
    }
    const assigned = Array.isArray(cfg.assigned_agent_ids) ? cfg.assigned_agent_ids : [];
    for (const id of assigned) {
      if (typeof id === "string" && id.trim() && !candidates.includes(id.trim())) {
        candidates.push(id.trim());
      }
    }

    for (const candidateId of candidates) {
      const row = this.db
        .prepare("SELECT id, name, type, capabilities FROM agents WHERE id = ?")
        .get(candidateId) as { id: string; name: string; type: string; capabilities: string } | null;
      if (!row) continue;
      try {
        const caps = JSON.parse(row.capabilities) as string[];
        if (Array.isArray(caps) && caps.includes("summarization")) {
          return { id: row.id, name: row.name, type: row.type };
        }
      } catch { /* malformed capabilities — skip candidate, fallback below */ }
    }

    const fallback = this.db
      .prepare(
        `SELECT id, name, type
         FROM agents
         WHERE EXISTS (
           SELECT 1 FROM json_each(agents.capabilities) WHERE value = 'summarization'
         )
         ORDER BY CASE WHEN id = 'realtime-summarizer' THEN 0 ELSE 1 END, name
         LIMIT 1`,
      )
      .get() as { id: string; name: string; type: string } | null;
    return fallback;
  }

  private getRealtimeTaskConfig(taskId: string): {
    summarizer_agent_id?: string;
    assigned_agent_ids?: string[];
  } {
    const taskRow = this.db
      .prepare("SELECT task_config FROM tasks WHERE id = ?")
      .get(taskId) as { task_config: string } | null;
    try {
      return JSON.parse(taskRow?.task_config || "{}");
    } catch {
      return {};
    }
  }

  private getRealtimeDelegationAgentIds(taskId: string): string[] {
    const ids = new Set<string>();
    const cfg = this.getRealtimeTaskConfig(taskId);

    const teamRows = this.db
      .prepare(
        `SELECT ta.agent_id
         FROM tasks t
         JOIN team_agents ta ON ta.team_id = t.team_id
         WHERE t.id = ? AND ta.agent_id != 'skipper'`,
      )
      .all(taskId) as Array<{ agent_id: string }>;
    for (const row of teamRows) ids.add(row.agent_id);

    const assigned = Array.isArray(cfg.assigned_agent_ids) ? cfg.assigned_agent_ids : [];
    for (const id of assigned) {
      if (typeof id === "string" && id.trim() && id !== "skipper") ids.add(id.trim());
    }

    const summarizer = this.findSummarizerAgent(taskId);
    if (summarizer && summarizer.id !== "skipper") {
      ids.add(summarizer.id);
    }

    return Array.from(ids);
  }

  /**
   * Spawn the configured summarizer agent to summarize newly transcribed segments.
   * The summarizer outputs [NOTE] signals which get captured by handleSummarizerSignal
   * and written to the timeline.
   */
  private spawnSummarizer(taskId: string): void {
    const session = this.sessions.get(taskId);

    const ready = this.db
      .prepare(
        `SELECT * FROM task_input_streams
         WHERE task_id = ? AND transcription_status = 'transcribed' AND summary_batch_id IS NULL
         ORDER BY sequence`,
      )
      .all(taskId) as Array<{
        id: string;
        transcribed_text: string | null;
        sequence: number;
      }>;

    if (ready.length === 0) return;

    // If session is stopped, use raw transcript (don't spawn new agents)
    if (session?.stopped) {
      this.createRawTranscriptTimeline(taskId, ready);
      return;
    }

    // If no agent manager, fall back to raw transcript timeline entries
    if (!this.agentManager) {
      this.createRawTranscriptTimeline(taskId, ready);
      return;
    }

    const summarizer = this.findSummarizerAgent(taskId);
    if (!summarizer) {
      // Fallback: no summarizer configured — create timeline entries directly from raw transcriptions
      console.log(`[realtime-session] spawnSummarizer: no summarizer agent configured for task=${taskId}, using raw transcriptions`);
      this.createRawTranscriptTimeline(taskId, ready);
      return;
    }

    // Don't spawn if summarizer already running
    if (this.agentManager.getRunningAgent(summarizer.id)) {
      console.log(`[realtime-session] spawnSummarizer: ${summarizer.id} still running, skipping`);
      return;
    }
    if (this.activeSummarizerRuns.has(summarizer.id)) {
      return;
    }

    const concatenated = ready
      .map((s) => s.transcribed_text ?? "")
      .filter((t) => t.trim().length > 0)
      .join("\n");

    if (!concatenated.trim()) {
      // All transcriptions were empty — mark as summarized with empty content
      this.createRawTranscriptTimeline(taskId, ready);
      return;
    }

    const segmentIds = ready.map((s) => s.id);
    const firstSeq = ready[0].sequence;
    const lastSeq = ready[ready.length - 1].sequence;

    // Mark segments as pending summary (use a placeholder batch ID)
    const pendingBatchId = `pending:${crypto.randomUUID()}`;
    const placeholders = segmentIds.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE task_input_streams SET summary_batch_id = ? WHERE id IN (${placeholders})`,
      )
      .run(pendingBatchId, ...segmentIds);

    // Track this run
    this.activeSummarizerRuns.set(summarizer.id, {
      taskId,
      segmentIds,
      result: null,
    });

    const prompt = [
      `You are processing raw transcribed audio from a live session (segments ${firstSeq}-${lastSeq}).`,
      "",
      "TRANSCRIBED TEXT:",
      concatenated,
      "",
      "Your job is to clean up and condense this raw transcription into readable text.",
      "",
      "Instructions:",
      "1. Fix obvious transcription errors, broken words, and garbled text.",
      "2. Remove filler words (um, uh, like, you know) and false starts.",
      "3. Remove incoherent fragments that don't form meaningful content — these are transcription artifacts, not real speech.",
      "4. If the text is short and already coherent, keep it as-is with minimal cleanup.",
      "5. If the text is long or repetitive, condense it into a concise summary that preserves all key details, decisions, names, numbers, and action items.",
      "6. Preserve the speaker's intent and meaning. Do not add information that was not spoken.",
      "",
      "Output the cleaned text using [DELEGATE_COMPLETE] followed by the result.",
      "If the entire transcription is incoherent noise with no meaningful content, output [DELEGATE_COMPLETE] with an empty string.",
    ].join("\n");

    console.log(`[realtime-session] spawnSummarizer: spawning ${summarizer.id} for task=${taskId} segments=${firstSeq}-${lastSeq} (${segmentIds.length} segments)`);

    this.agentManager.clearSessionId(summarizer.id);
    const summarizerType = getAgentTypeDefinition(summarizer.type, this.db);
    const summarizerUsesInlinePrompt = summarizerType ? agentTypeUsesInlinePrompt(summarizerType) : false;
    const summarizerTask = this.db.prepare("SELECT working_directory FROM tasks WHERE id = ?").get(taskId) as { working_directory: string } | null;
    const summarizerWorkingDir = summarizerTask?.working_directory || process.cwd();
    this.agentManager
      .spawnAgent(summarizer.id, { workingDir: summarizerWorkingDir, taskId, initialPrompt: summarizerUsesInlinePrompt ? prompt : undefined })
      .then(() => {
        if (!summarizerUsesInlinePrompt) {
          this.agentManager!.sendInput(summarizer.id, prompt, true);
        }

        this.db
          .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
          .run(taskId, summarizer.id);
      })
      .catch((err) => {
        // Spawn failed — revert the pending batch and fall back to raw text
        this.db
          .prepare(
            `UPDATE task_input_streams SET summary_batch_id = NULL WHERE summary_batch_id = ?`,
          )
          .run(pendingBatchId);
        this.activeSummarizerRuns.delete(summarizer.id);
        this.createRawTranscriptTimeline(taskId, ready);
        logError(this.db, "realtime.spawn_summarizer", { taskId, agentId: summarizer.id }, err);
      });
  }

  /**
   * Handle [DELEGATE_COMPLETE] signals from summarizer agents — capture the summary.
   */
  private resolveSummarizerRun(agentId: string): { key: string; run: SummarizerRun } | null {
    const direct = this.activeSummarizerRuns.get(agentId);
    if (direct) return { key: agentId, run: direct };
    // agentId is a runtime UUID — resolve to template agent ID via
    // the in-memory map (agent_instances row may not exist for summarizers
    // spawned with taskId:null).
    if (this.agentManager) {
      const templateId = this.agentManager.getTemplateAgentId(agentId);
      if (templateId) {
        const byTemplate = this.activeSummarizerRuns.get(templateId);
        if (byTemplate) return { key: templateId, run: byTemplate };
      }
    }
    return null;
  }

  private handleSummarizerSignal(event: { agentId: string; signalType: string; content?: string }): void {
    const resolved = this.resolveSummarizerRun(event.agentId);
    if (!resolved) return;
    const run = resolved.run;

    if (event.signalType === "delegate_complete" && event.content) {
      run.result = event.content;
      console.log(`[realtime-session] summarizerSignal: ${event.agentId} produced DELEGATE_COMPLETE (${event.content.length} chars)`);
    }
  }

  /**
   * Handle summarizer exit — finalize timeline entry from the delegate_complete result.
   */
  private handleSummarizerExit(event: { agentId: string }): void {
    const resolved = this.resolveSummarizerRun(event.agentId);
    if (!resolved) return;
    const run = resolved.run;

    this.activeSummarizerRuns.delete(resolved.key);

    if (run.result) {
      const summaryContent = run.result;
      const timelineId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO realtime_timeline (id, task_id, entry_type, content, source_segment_ids)
           VALUES (?, ?, 'summary', ?, ?)`,
        )
        .run(timelineId, run.taskId, summaryContent, JSON.stringify(run.segmentIds));
      this.emitTimelineUpdated(run.taskId, timelineId, "summary");

      // Update segments to point to the real timeline entry
      const placeholders = run.segmentIds.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE task_input_streams SET summary_batch_id = ? WHERE id IN (${placeholders})`,
        )
        .run(timelineId, ...run.segmentIds);

      // Create summary artifact
      try {
        this.artifactManager.createArtifact({
          taskId: run.taskId,
          name: "realtime-summary",
          kind: "summary",
          description: `Agent-produced summary of ${run.segmentIds.length} audio segments`,
          body: summaryContent,
        });
      } catch (err) {
        logError(this.db, "realtime.summary_artifact", { taskId: run.taskId, timelineId }, err);
      }

      console.log(`[realtime-session] summarizerExit: ${event.agentId} — created timeline entry (${summaryContent.length} chars, ${run.segmentIds.length} segments)`);
    } else {
      // Summarizer exited without producing a result — fall back to raw transcription
      console.log(`[realtime-session] summarizerExit: ${event.agentId} produced no result, falling back to raw transcriptions`);
      const segments = this.db
        .prepare(
          `SELECT id, transcribed_text, sequence FROM task_input_streams WHERE id IN (${run.segmentIds.map(() => "?").join(",")})`,
        )
        .all(...run.segmentIds) as Array<{ id: string; transcribed_text: string | null; sequence: number }>;

      this.createRawTranscriptTimeline(run.taskId, segments);
    }
  }

  /**
   * Fallback: create timeline entries directly from raw transcriptions (no summarizer agent).
   */
  private createRawTranscriptTimeline(
    taskId: string,
    segments: Array<{ id: string; transcribed_text?: string | null; sequence: number }>,
  ): void {
    const concatenated = segments
      .map((s) => s.transcribed_text ?? "")
      .filter((t) => t.trim().length > 0)
      .join("\n");

    if (!concatenated.trim() && segments.length > 0) {
      // All empty — just mark as consumed
      const segmentIds = segments.map((s) => s.id);
      const batchId = `empty:${crypto.randomUUID()}`;
      const placeholders = segmentIds.map(() => "?").join(",");
      this.db
        .prepare(`UPDATE task_input_streams SET summary_batch_id = ? WHERE id IN (${placeholders})`)
        .run(batchId, ...segmentIds);
      return;
    }

    const segmentIds = segments.map((s) => s.id);

    const timelineId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO realtime_timeline (id, task_id, entry_type, content, source_segment_ids)
         VALUES (?, ?, 'summary', ?, ?)`,
      )
      .run(timelineId, taskId, concatenated, JSON.stringify(segmentIds));
    this.emitTimelineUpdated(taskId, timelineId, "summary");

    const placeholders = segmentIds.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE task_input_streams SET summary_batch_id = ? WHERE id IN (${placeholders})`)
      .run(timelineId, ...segmentIds);

    // No artifact created here — this is raw unsummarized text. Artifacts are
    // only created by the summarizer agent, Skipper, or delegated sub-agents.
  }

  /**
   * Feed unfed timeline entries to Skipper. Skipper is the orchestrator for realtime tasks,
   * using the realtime_prompt from skipper_config. On the first call it's spawned fresh;
   * on subsequent calls it's resumed with new entries so it maintains context.
   */
  feedSkipper(taskId: string): void {
    const unfed = this.db
      .prepare(
        "SELECT * FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0 ORDER BY created_at",
      )
      .all(taskId) as Array<{
        id: string;
        entry_type: string;
        content: string;
        priority: string;
        created_at: string;
      }>;

    if (unfed.length === 0) return;

    if (!this.agentManager) {
      const ids = unfed.map((e) => e.id);
      const markPlaceholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE realtime_timeline SET fed_to_skipper = 1 WHERE id IN (${markPlaceholders})`,
        )
        .run(...ids);
      return;
    }

    const entrypointAgentId = this.resolveRealtimeEntrypointAgentId(taskId);
    if (!entrypointAgentId) {
      console.error(`[realtime-session] feedSkipper: no entrypoint agent found for task=${taskId}`);
      return;
    }

    const ids = unfed.map((e) => e.id);
    const markFed = () => {
      const markPlaceholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE realtime_timeline SET fed_to_skipper = 1 WHERE id IN (${markPlaceholders})`,
        )
        .run(...ids);
    };

    // Format chronological feed
    const feedLines = unfed.map((entry) => {
      const time = entry.created_at.split("T")[1]?.split(".")[0] ?? entry.created_at;
      const typeLabel = entry.entry_type.toUpperCase();
      const priorityTag = entry.priority === "high" ? " PRIORITY:HIGH" : "";
      return `[${time} ${typeLabel}${priorityTag}] ${entry.content}`;
    });

    // Build available agents roster from assigned team members + individual selections.
    const taskRow = this.db
      .prepare("SELECT title, description FROM tasks WHERE id = ?")
      .get(taskId) as { title: string; description: string | null } | null;

    let agentRows: Array<{
      id: string;
      name: string;
      capabilities: string;
      instruction: string | null;
    }>;

    const availableIds = this.getRealtimeDelegationAgentIds(taskId)
      .filter((id) => id !== entrypointAgentId);
    if (availableIds.length > 0) {
      const placeholders = availableIds.map(() => "?").join(",");
      agentRows = this.db
        .prepare(
          `SELECT a.id, a.name, a.capabilities, json_extract(a.config, '$.instruction') AS instruction
           FROM agents a
           WHERE a.id IN (${placeholders})
           ORDER BY a.name`,
        )
        .all(...availableIds) as typeof agentRows;
    } else {
      agentRows = [];
    }

    const rosterLines: string[] = [];
    if (agentRows.length > 0) {
      rosterLines.push("AVAILABLE AGENTS (use these IDs for delegate({ target: \"<agent-id>\", work: \"...\" })):");
      for (const agent of agentRows) {
        let caps: string[] = [];
        try { caps = JSON.parse(agent.capabilities); } catch { /* malformed — renders as "general" */ }
        const capStr = caps.length > 0 ? caps.join(", ") : "general";
        const roleStr = agent.instruction ? ` | Role: ${agent.instruction.slice(0, 120)}` : "";
        rosterLines.push(`- ID: ${agent.id} | Name: ${agent.name} | Capabilities: ${capStr}${roleStr}`);
      }
      rosterLines.push("");
    }

    const taskContext: string[] = [`TASK_ID: ${taskId}`];
    if (taskRow?.title) taskContext.push(`TASK: ${taskRow.title}`);
    if (taskRow?.description) taskContext.push(`DESCRIPTION: ${taskRow.description}`);

    const feedMessage = [
      ...taskContext,
      "",
      ...rosterLines,
      "[REALTIME_FEED]",
      ...feedLines,
      "[END_REALTIME_FEED]",
    ].join("\n");

    // Check if entrypoint is already running (resume with new entries)
    const existingAgent = this.agentManager.getRunningAgent(entrypointAgentId);
    if (existingAgent) {
      console.log(`[realtime-session] feedSkipper: resuming entrypoint with ${unfed.length} new timeline entries for task=${taskId}`);
      this.agentManager
        .sendResumeMessage(entrypointAgentId, feedMessage, true)
        .then(() => { markFed(); })
        .catch((err) => {
          logError(this.db, "realtime.feed_skipper_resume", { taskId, entryCount: unfed.length }, err);
        });
      return;
    }

    // First spawn: include realtime prompt when present, otherwise fall back
    // to the main Skipper prompt.
    const skipperConfig = getSkipperConfig(this.db);
    const realtimePrompt = skipperConfig.realtime_prompt.trim().length > 0
      ? skipperConfig.realtime_prompt
      : skipperConfig.prompt;
    const initialMessage = realtimePrompt
      ? `${realtimePrompt}\n\n${feedMessage}`
      : feedMessage;

    // Resume the prior session if one exists — keeps a single conversation
    // across cadence ticks instead of spawning a fresh agent every time.
    const priorSessionId = this.agentManager.getEntrypointSessionIdForTask(taskId, entrypointAgentId);

    console.log(`[realtime-session] feedSkipper: ${priorSessionId ? "resuming" : "spawning"} entrypoint for task=${taskId} with ${unfed.length} timeline entries${priorSessionId ? ` (session=${priorSessionId})` : ""}`);

    const entrypoint = typeof this.agentManager.getAgent === "function"
      ? this.agentManager.getAgent(entrypointAgentId)
      : null;
    const entrypointType = entrypoint ? getAgentTypeDefinition(entrypoint.type, this.db) : null;
    const entrypointUsesInlinePrompt = entrypointType ? agentTypeUsesInlinePrompt(entrypointType) : false;
    const feedTask = this.db.prepare("SELECT working_directory FROM tasks WHERE id = ?").get(taskId) as { working_directory: string } | null;
    const feedWorkingDir = feedTask?.working_directory || process.cwd();
    this.agentManager
      .spawnAgent(entrypointAgentId, {
        workingDir: feedWorkingDir,
        taskId,
        sessionId: priorSessionId ?? undefined,
        initialPrompt: entrypointUsesInlinePrompt ? (priorSessionId ? feedMessage : initialMessage) : undefined,
      })
      .then((spawned) => {
        if (!entrypointUsesInlinePrompt) {
          // Target the spawned runtime instance, not the template id — avoids
          // misrouting to a sibling same-team task's stdin under parallel runs.
          this.agentManager!.sendInput(spawned.id, priorSessionId ? feedMessage : initialMessage, true);
        }

        markFed();

        this.db
          .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
          .run(taskId, entrypointAgentId);
      })
      .catch((err) => {
        logError(
          this.db,
          "realtime.feed_skipper",
          { taskId, entryCount: unfed.length },
          err,
        );
      });

    eventBus.emit("realtime:trigger_fired", {
      windowId: unfed[unfed.length - 1].id,
      taskId,
      confidence: 1.0,
      decision: "fed",
    });
  }

  async stopSession(
    taskId: string,
  ): Promise<{ session_id: string; state: string }> {
    const session = this.sessions.get(taskId);
    if (!session) {
      return { session_id: taskId, state: "paused" };
    }

    // Mark stopped first to prevent any in-flight tick from spawning new work
    session.stopped = true;

    // Clear cadence timer so no new tick fires while we flush
    if (session.cadenceTimer) {
      clearInterval(session.cadenceTimer);
      session.cadenceTimer = null;
    }

    // Wait for any in-flight tick to complete before we flush
    if (session.tickInProgress) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!session.tickInProgress) { clearInterval(check); resolve(); }
        }, 100);
      });
    }

    // Flush any pending audio segments before pausing
    console.log(`[realtime-session] stopSession: task=${taskId} — flushing pending transcriptions`);
    await this.transcribePendingSegments(taskId);

    // Spawn summarizer for any freshly transcribed segments
    this.spawnSummarizer(taskId);

    // Flush any unfed timeline entries to Skipper (only if not already busy)
    if (!this.isSkipperBusy(taskId)) {
      this.feedSkipper(taskId);
    }

    // Update pipeline state
    this.db
      .prepare(
        "UPDATE realtime_pipeline_state SET cadence_timer_active = 0, updated_at = datetime('now') WHERE task_id = ?",
      )
      .run(taskId);

    // Mark any running entrypoint instances as completed so the agent tree
    // doesn't show stale "running" rows after pause.
    const entrypointAgentId = this.resolveRealtimeEntrypointAgentId(taskId);
    if (entrypointAgentId) {
      this.db
        .prepare("UPDATE agent_instances SET status = 'completed' WHERE template_agent_id = ? AND task_id = ? AND status = 'running'")
        .run(entrypointAgentId, taskId);
    }

    this.sessions.delete(taskId);
    eventBus.emit("realtime:session_state", { taskId, state: "paused" });
    console.log(`[realtime-session] stopSession: task=${taskId} — paused`);

    return { session_id: taskId, state: "paused" };
  }

  resumeSession(taskId: string): { session_id: string; state: string } {
    if (this.sessions.has(taskId)) {
      throw new Error("Session already active for this task");
    }

    const config = getRealtimeConfig(this.db);

    // Initialize pipeline state (ON CONFLICT UPDATE for resume case)
    this.db
      .prepare(
        `INSERT INTO realtime_pipeline_state (task_id, cadence_timer_active) VALUES (?, 1)
         ON CONFLICT(task_id) DO UPDATE SET
           cadence_timer_active = 1,
           updated_at = datetime('now')`,
      )
      .run(taskId);

    const session: ActiveSession = {
      taskId,
      cadenceTimer: null,
      sequenceCounter: this.getMaxSequence(taskId),
      stopped: false,
      tickInProgress: false,
      ingestInProgress: 0,
    };
    this.sessions.set(taskId, session);

    // Start cadence timer
    console.log(`[realtime-session] resumeSession: task=${taskId} cadence=${config.cadence_seconds}s seq=${session.sequenceCounter}`);
    session.cadenceTimer = setInterval(() => {
      this.processCadenceTick(taskId).catch((err) => {
        logError(this.db, "realtime.cadence_tick", { taskId }, err);
      });
    }, config.cadence_seconds * 1000);

    eventBus.emit("realtime:session_state", { taskId, state: "active" });
    return { session_id: taskId, state: "active" };
  }

  /**
   * Force-close a specific session without finalization (used on cancel/fail).
   */
  closeSession(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (!session) return;
    if (session.cadenceTimer) {
      clearInterval(session.cadenceTimer);
    }
    this.sessions.delete(taskId);
    eventBus.emit("realtime:session_state", { taskId, state: "closed" });
  }

  isSessionActive(taskId: string): boolean {
    return this.sessions.has(taskId) && !this.sessions.get(taskId)!.stopped;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Force-close all sessions (used during shutdown/cancel).
   */
  closeAllSessions(): void {
    for (const [taskId, session] of this.sessions) {
      if (session.cadenceTimer) {
        clearInterval(session.cadenceTimer);
      }
      eventBus.emit("realtime:session_state", { taskId, state: "stopped" });
    }
    this.sessions.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.closeAllSessions();
    eventBus.off("agent:signal", this.onAgentSignal);
    eventBus.off("agent:exit", this.onAgentExit);
    this.activeSummarizerRuns.clear();
    this.disposed = true;
  }

  private getMaxSequence(taskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) as max_seq FROM task_input_streams WHERE task_id = ?",
      )
      .get(taskId) as { max_seq: number };
    return row.max_seq;
  }

  private autoResumeSessions(): void {
    try {
      // Only resume sessions that were actively recording (cadence_timer_active = 1).
      // Paused sessions have cadence_timer_active = 0 and should stay paused.
      const runningTasks = this.db
        .prepare(`SELECT t.id FROM tasks t
          JOIN realtime_pipeline_state rps ON rps.task_id = t.id
          WHERE t.task_type = 'real_time' AND t.status = 'running' AND rps.cadence_timer_active = 1`)
        .all() as { id: string }[];

      for (const task of runningTasks) {
        try {
          this.resumeSession(task.id);
          console.log(`[realtime-session] auto-resumed session for task=${task.id}`);
        } catch (err) {
          console.error(`[realtime-session] auto-resume failed for task=${task.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[realtime-session] autoResumeSessions error:", err);
    }
  }

}
