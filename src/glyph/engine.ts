// GlyphEngine: the renderer agent's loop. Event-driven, not polled.
//
//   bus event on task X  ->  debounce  ->  (only if an overlay for X is open)
//   -> fetch the delta since the last wake -> one-shot model call (session
//   resumed) -> parse RENDER/PATCH/NOOP -> apply to the task's GlyphScreen ->
//   push {t, s, frame} on topic `glyph:<taskId>` via ui-push.
//
// Zero model calls while no overlay is open, and none when nothing landed on
// the task's registers. The model is the same provider-generic one-shot runner
// Greg and the dictation rewriter use (src/agents/oneshot.ts), picked on the
// config page under "Glyph renderer".

import type { Database } from "bun:sqlite";
import { eventBus, type EventMap, type EventName } from "../events/bus";
import { assetTextSync } from "../assets";
import { runOneShotText, CLAUDE_ISOLATION_ARGS } from "../agents/oneshot";
import { getAgentTypeDefinition } from "../agents/types";
import { agentSpawnPath } from "../paths";
import { getGlyphModelChoice } from "../config/model-settings";
import { isExperimental } from "../config/feature-flags";
import { logError } from "../logging";
import { fetchGlyphDelta, EMPTY_GLYPH_CURSOR, type GlyphCursor } from "../data/glyph";
import { GlyphScreen, type GlyphPushPayload } from "./screen";
import { resolveGlyphSource, webSources } from "./sources";
import { ProtocolError } from "./protocol";
import { buildWakeMessage, parseGlyphReply, describeRejection } from "./renderer";
import { loadGlyphScreen, saveGlyphScreen, deleteGlyphScreen } from "./store";
import { issueRendererToken, revokeRendererToken } from "../mcp/auth";
import { writeFileSync, unlinkSync } from "node:fs";

const PROMPT_ASSET = "prompts/glyph.md";
const DEFAULT_DEBOUNCE_MS = 3000;
const MODEL_TIMEOUT_MS = 180_000;
// Tool turns per wake: read a few artifacts, then answer.
const MAX_TURNS = 12;
/** The renderer's tool names as the claude CLI sees them (server "skipper-daemon" in the mcp config). */
const RENDERER_TOOLS = ["mcp__skipper-daemon__list_artifacts", "mcp__skipper-daemon__get_artifact"];
const COMPACT_EVERY_N_CALLS = 15;
// Command attempts per wake: the first reply plus retries, each retry carrying
// the exact rejection (error, caret position, ids on screen, hint).
const MAX_COMMAND_ATTEMPTS = 4;

const WAKE_EVENTS = [
  "task:note_added",
  "task:message_posted",
  "artifact:created",
  "escalation:created",
  "escalation:resolved",
  "task:phase_changed",
  "task:needs_review_changed",
  "task:state_changed",
  "task:run_completed",
  "task:run_failed",
  "realtime:timeline_updated",
] as const satisfies readonly EventName[];

export interface GlyphModelCall {
  taskId: string;
  prompt: string;
  systemPrompt: string;
  sessionId: string | null;
}
export interface GlyphModelReply {
  text: string;
  sessionId: string | null;
}
/** Injectable so tests never spawn a provider CLI. */
export type GlyphModelRunner = (call: GlyphModelCall) => Promise<GlyphModelReply | null>;

/** The slice of ui-push the engine needs; tests pass a stub. */
export interface GlyphPush {
  broadcastJson(event: string, resource: string, id: string | null, data: unknown, topics: string[]): void;
  hasJsonClients(topics: string[]): boolean;
}

export type GlyphRenderState = "idle" | "rendering" | "error";

export interface GlyphStatus {
  taskId: string;
  /** The model's frame (sources as written). */
  frame: string;
  /** The frame the browser renders (sources resolved to URLs). */
  view: string;
  state: GlyphRenderState;
  error: string | null;
  calls: number;
  hasSession: boolean;
  /** Agent instances running or pending on the task right now. */
  activeAgents: number;
}

interface TaskState {
  screen: GlyphScreen;
  cursor: GlyphCursor;
  sessionId: string | null;
  calls: number;
  inFlight: boolean;
  pending: boolean;
  timer: Timer | null;
  state: GlyphRenderState;
  error: string | null;
  /** Fingerprint of the task summary at the last wake; a status-only wake with no new registers and the same summary is skipped. */
  lastSummaryFp: string;
  /** `w` source text -> resolved URL, filled by the validator so view() never hits the DB. */
  sources: Map<string, string>;
  /** Screen came from storage after a restart; the next wake says so and the model's memory may be gone. */
  restored: boolean;
  /** Session id came from storage and has not answered yet; a failed call drops it and retries once without. */
  sessionUnverified: boolean;
  /** Last zoom the overlay needed to fit the screen in its viewport (1 = fits). */
  fit: number;
}

export function glyphTopic(taskId: string): string {
  return `glyph:${taskId}`;
}

export class GlyphEngine {
  private readonly tasks = new Map<string, TaskState>();
  private readonly busOffs: Array<() => void> = [];
  private readonly runner: GlyphModelRunner;
  private readonly debounceMs: number;
  private started = false;

  constructor(
    private readonly db: Database,
    private readonly push: GlyphPush,
    opts: { runner?: GlyphModelRunner; debounceMs?: number; daemonPort?: () => number } = {},
  ) {
    this.runner = opts.runner ?? ((call) => this.defaultRunner(call));
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.daemonPort = opts.daemonPort ?? (() => Number(process.env.PORT) || 5005);
  }

  private readonly daemonPort: () => number;

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const name of WAKE_EVENTS) {
      const listener = (event: EventMap[typeof name][0]): void => {
        const taskId = (event as { taskId?: string }).taskId;
        if (!taskId) return;
        if (name === "task:state_changed" && (event as EventMap["task:state_changed"][0]).newStatus === "deleted") {
          this.forget(taskId);
          return;
        }
        this.requestWake(taskId);
      };
      eventBus.on(name, listener as never);
      this.busOffs.push(() => eventBus.off(name, listener as never));
    }
    // Active-agent count for the bar: not a render trigger, just a live badge.
    const onInstance = (event: EventMap["instance:state_changed"][0]): void => this.pushActiveAgents(event.taskId);
    eventBus.on("instance:state_changed", onInstance);
    this.busOffs.push(() => eventBus.off("instance:state_changed", onInstance));
  }

  /** Running + pending agent instances on the task (what the Canvas bar shows). */
  activeAgents(taskId: string): number {
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS c FROM agent_instances WHERE task_id = ? AND status IN ('running', 'pending')",
      ).get(taskId) as { c: number } | null;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  private pushActiveAgents(taskId: string): void {
    if (!this.push.hasJsonClients([glyphTopic(taskId)])) return;
    this.push.broadcastJson("updated", "glyph:agents", taskId, { active: this.activeAgents(taskId) }, [glyphTopic(taskId)]);
  }

  stop(): void {
    for (const off of this.busOffs.splice(0)) off();
    for (const t of this.tasks.values()) if (t.timer) clearTimeout(t.timer);
    this.tasks.clear();
    this.started = false;
  }

  /** Current frame for a task ("" when nothing rendered yet). */
  frame(taskId: string): string {
    return this.tasks.get(taskId)?.screen.serialize() ?? "";
  }

  status(taskId: string): GlyphStatus {
    const t = this.tasks.get(taskId);
    return {
      taskId,
      frame: t?.screen.serialize() ?? "",
      view: t ? this.view(t) : "",
      state: t?.state ?? "idle",
      error: t?.error ?? null,
      calls: t?.calls ?? 0,
      hasSession: !!t?.sessionId,
      activeAgents: this.activeAgents(taskId),
    };
  }

  /**
   * An overlay opened. Returns the current screen immediately (kept in memory
   * per task, so switching tasks and coming back resumes where it was) and
   * schedules a catch-up wake: events that arrived while no overlay was open
   * were skipped, so the delta since the last wake is fetched now. When
   * nothing landed in between, the wake returns before any model call.
   */
  open(taskId: string): GlyphStatus {
    this.requestWake(taskId, { immediate: true, force: true });
    return this.status(taskId);
  }

  /** The overlay reports how much it had to zoom the screen to avoid a scrollbar (1 = fits). */
  viewport(taskId: string, fit: number): void {
    if (!Number.isFinite(fit)) return;
    this.stateFor(taskId).fit = Math.max(0.1, Math.min(1, fit));
  }

  /** Drop the screen and the model session; the next wake starts from scratch. */
  reset(taskId: string): GlyphStatus {
    const t = this.stateFor(taskId);
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    t.sessionId = null;
    t.cursor = { ...EMPTY_GLYPH_CURSOR };
    t.calls = 0;
    t.error = null;
    t.screen.clear();
    t.sources.clear();
    t.restored = false;
    t.sessionUnverified = false;
    this.persist(taskId, t);
    this.broadcast(taskId, t);
    this.requestWake(taskId, { immediate: true, force: true });
    return this.status(taskId);
  }

  /**
   * Schedule a wake. Skipped outright when the feature is off or nobody has
   * the task's overlay open (`force` bypasses the client check for an explicit
   * open/reset, where the socket may not have connected yet).
   */
  requestWake(taskId: string, opts: { immediate?: boolean; force?: boolean } = {}): void {
    if (!isExperimental()) return;
    if (!opts.force && !this.push.hasJsonClients([glyphTopic(taskId)])) return;
    const t = this.stateFor(taskId);
    if (t.inFlight) { t.pending = true; return; }
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      // Re-check at fire time: the overlay may have closed during the debounce
      // window, and a wake nobody will see is wasted tokens.
      if (!opts.force && !this.push.hasJsonClients([glyphTopic(taskId)])) return;
      this.wake(taskId).catch((err) => logError(this.db, "glyph.wake", { taskId }, err));
    }, opts.immediate ? 0 : this.debounceMs);
  }

  /** Awaitable wake for tests and the reset route. */
  async wake(taskId: string): Promise<void> {
    const t = this.stateFor(taskId);
    if (t.inFlight) { t.pending = true; return; }
    t.inFlight = true;
    t.pending = false;
    try {
      await this.wakeOnce(taskId, t);
    } finally {
      t.inFlight = false;
      if (t.pending) {
        t.pending = false;
        this.requestWake(taskId);
      }
    }
  }

  private async wakeOnce(taskId: string, t: TaskState): Promise<void> {
    const delta = fetchGlyphDelta(this.db, taskId, t.cursor);
    if (!delta) { this.forget(taskId); return; }
    const nothingNew = delta.notes.length + delta.messages.length + delta.artifacts.length + delta.inputs.length
      + delta.newEscalations.length + delta.resolvedEscalations.length === 0;
    // A status/phase-only wake still matters (the subtitle and NEEDS YOU row
    // change), but only once a screen exists; an empty screen with no
    // registers would just render the task header, which is fine too. So only
    // skip when nothing changed AND there is already a screen AND the last
    // summary line is identical — cheap fingerprint on the task summary.
    const summaryFp = JSON.stringify(delta.task);
    if (nothingNew && !t.screen.isEmpty() && summaryFp === t.lastSummaryFp) return;

    const firstWake = !t.sessionId;
    const systemPrompt = loadSystemPrompt();
    const restored = t.restored;
    t.restored = false;
    let prompt = buildWakeMessage(delta, t.screen.serialize(), { firstWake, lastError: null, restored, fit: t.fit });

    this.setState(taskId, t, "rendering", null);
    if (t.sessionId && t.calls > 0 && t.calls % COMPACT_EVERY_N_CALLS === 0) await this.compact(t);

    let reply = await this.runner({ taskId, prompt, systemPrompt, sessionId: t.sessionId });
    if (!reply && t.sessionUnverified) {
      // The stored session may be gone (provider changed, CLI store pruned):
      // retry once without it, as a fresh session with the description.
      t.sessionId = null;
      t.sessionUnverified = false;
      prompt = buildWakeMessage(delta, t.screen.serialize(), { firstWake: true, lastError: null, restored });
      reply = await this.runner({ taskId, prompt, systemPrompt, sessionId: null });
    }
    if (!reply) {
      // Provider down or timed out: keep the cursor so the delta is re-sent next time.
      t.restored = restored;
      this.setState(taskId, t, "error", "renderer call failed");
      return;
    }
    t.sessionUnverified = false;
    t.calls++;
    t.sessionId = reply.sessionId ?? t.sessionId;
    t.cursor = delta.next;
    t.lastSummaryFp = summaryFp;
    this.persist(taskId, t);

    // Retry with the rejection described in detail; after the last attempt the
    // screen simply stays as it was.
    for (let attempt = 1; attempt <= MAX_COMMAND_ATTEMPTS; attempt++) {
      const err = this.applyReply(taskId, t, reply.text, { n: attempt, max: MAX_COMMAND_ATTEMPTS });
      if (!err) { this.setState(taskId, t, "idle", null); return; }
      if (attempt === MAX_COMMAND_ATTEMPTS) { this.setState(taskId, t, "error", err.split("\n")[1] ?? err); return; }
      prompt = buildWakeMessage(
        { ...delta, notes: [], messages: [], artifacts: [], inputs: [], newEscalations: [], resolvedEscalations: [] },
        t.screen.serialize(),
        { firstWake: false, lastError: err },
      );
      reply = await this.runner({ taskId, prompt, systemPrompt, sessionId: t.sessionId });
      if (!reply) { this.setState(taskId, t, "error", err); return; }
      t.calls++;
      t.sessionId = reply.sessionId ?? t.sessionId;
    }
  }

  /** Apply one model reply to the screen; returns the rejection feedback to send back, or null on success. */
  private applyReply(taskId: string, t: TaskState, text: string, attempt: { n: number; max: number }): string | null {
    const cmd = parseGlyphReply(text);
    if (!cmd) {
      console.warn("[glyph] no command in reply for task %s (attempt %d/%d): %s", taskId, attempt.n, attempt.max, text.slice(0, 200));
      return describeRejection(null, new Error("no glyph command found in the reply"), t.screen.serialize(), attempt);
    }
    if (cmd.kind === "noop") return null;
    try {
      const validate = this.sourceValidator(taskId, t);
      let refresh: string[] = [];
      if (cmd.kind === "render") t.screen.render(cmd.frame, validate);
      else refresh = t.screen.patch(cmd.ops, validate);
      this.broadcast(taskId, t, refresh);
      this.persist(taskId, t);
      return null;
    } catch (e) {
      const msg = e instanceof ProtocolError ? e.message : String(e);
      const label = cmd.kind === "render" ? "RENDER" : "PATCH";
      console.warn("[glyph] %s rejected for task %s (attempt %d/%d): %s | %s", label, taskId, attempt.n, attempt.max, msg, (cmd.kind === "render" ? cmd.frame : cmd.ops).slice(0, 300));
      return describeRejection(cmd, e, t.screen.serialize(), attempt);
    }
  }

  /**
   * Every `w` source on the screen must resolve to something the task may show
   * (artifact, a file in its working directory, an https url). Resolved URLs
   * are cached per task so the view can be rebuilt without touching the DB.
   */
  private sourceValidator(taskId: string, t: TaskState): (root: import("./protocol").UNode | null) => void {
    return (root) => {
      for (const text of webSources(root)) {
        if (t.sources.has(text)) continue;
        t.sources.set(text, resolveGlyphSource(this.db, taskId, text).url);
      }
    };
  }

  private view(t: TaskState): string {
    return t.screen.view((text) => t.sources.get(text) ?? "about:blank");
  }

  private broadcast(taskId: string, t: TaskState, refresh: string[] = []): void {
    const view = this.view(t);
    const payload: GlyphPushPayload = { t: "frame", s: view, frame: view };
    if (refresh.length > 0) payload.refresh = refresh;
    this.push.broadcastJson("updated", "glyph", taskId, payload, [glyphTopic(taskId)]);
  }

  private setState(taskId: string, t: TaskState, state: GlyphRenderState, error: string | null): void {
    t.state = state;
    t.error = error;
    this.push.broadcastJson("updated", "glyph:status", taskId, { state, error }, [glyphTopic(taskId)]);
  }

  private stateFor(taskId: string): TaskState {
    let t = this.tasks.get(taskId);
    if (!t) {
      t = {
        screen: new GlyphScreen(),
        cursor: { ...EMPTY_GLYPH_CURSOR },
        sessionId: null,
        calls: 0,
        inFlight: false,
        pending: false,
        timer: null,
        state: "idle",
        error: null,
        lastSummaryFp: "",
        sources: new Map(),
        restored: false,
        sessionUnverified: false,
        fit: 1,
      };
      this.restore(taskId, t);
      this.tasks.set(taskId, t);
    }
    return t;
  }

  /**
   * First touch of a task after boot: load the persisted screen, cursor and
   * session so the overlay shows the last state at once and the next wake is
   * a delta, not a re-read. A source that no longer resolves (file gone)
   * renders blank rather than dropping the whole screen.
   */
  private restore(taskId: string, t: TaskState): void {
    let stored;
    try {
      stored = loadGlyphScreen(this.db, taskId);
    } catch (err) {
      logError(this.db, "glyph.restore", { taskId }, err);
      return;
    }
    if (!stored || !stored.frame.trim()) return;
    try {
      t.screen.render(stored.frame);
    } catch (err) {
      console.warn("[glyph] stored screen for task %s is unreadable, starting fresh: %s", taskId, err instanceof Error ? err.message : String(err));
      return;
    }
    for (const text of webSources(t.screen.root())) {
      try {
        t.sources.set(text, resolveGlyphSource(this.db, taskId, text).url);
      } catch {
        t.sources.set(text, "about:blank");
      }
    }
    t.cursor = stored.cursor;
    t.lastSummaryFp = stored.summaryFp;
    t.sessionId = stored.sessionId;
    t.sessionUnverified = !!stored.sessionId;
    t.calls = stored.calls;
    t.restored = true;
  }

  private persist(taskId: string, t: TaskState): void {
    try {
      if (t.screen.isEmpty()) deleteGlyphScreen(this.db, taskId);
      else saveGlyphScreen(this.db, taskId, { frame: t.screen.serialize(), cursor: t.cursor, sessionId: t.sessionId, calls: t.calls, summaryFp: t.lastSummaryFp });
    } catch (err) {
      logError(this.db, "glyph.persist", { taskId }, err);
    }
  }

  private forget(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    this.tasks.delete(taskId);
  }

  // --- provider glue ---

  private usesClaude(): boolean {
    return getAgentTypeDefinition(getGlyphModelChoice(this.db).agent_type, this.db)?.command === "claude";
  }

  /**
   * One model call with the renderer's read-only artifact tools attached: a
   * per-call bearer token scoped to the task (revoked afterwards) and a temp
   * mcp config pointing the CLI at the daemon's own /mcp. Claude only; other
   * providers run tool-less and get the artifact bodies inline in the prompt.
   */
  private async defaultRunner(call: GlyphModelCall): Promise<GlyphModelReply | null> {
    const choice = getGlyphModelChoice(this.db);
    const isClaude = this.usesClaude();
    let token: string | null = null;
    let configPath: string | null = null;
    let extraArgs: string[] = [];
    if (isClaude) {
      token = issueRendererToken(call.taskId);
      configPath = `/tmp/skipper-glyph-mcp-${crypto.randomUUID()}.json`;
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          "skipper-daemon": {
            type: "http",
            url: `http://127.0.0.1:${this.daemonPort()}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }), "utf-8");
      extraArgs = [
        "--max-turns", String(MAX_TURNS),
        "--strict-mcp-config", "--mcp-config", configPath,
        "--tools", "",              // no built-in tools; the MCP pair is the whole tool surface
        "--setting-sources", "",   // no user/project settings or hooks
        "--allowedTools", RENDERER_TOOLS.join(","),
        "--dangerously-skip-permissions",
      ];
    }
    try {
      const result = await runOneShotText({
        db: this.db,
        agentType: choice.agent_type,
        model: choice.model,
        prompt: call.prompt,
        // `--resume` does not carry the system prompt forward; send it every call.
        systemPrompt: call.systemPrompt,
        sessionId: call.sessionId,
        timeoutMs: MODEL_TIMEOUT_MS,
        extraArgs,
        env: { PATH: agentSpawnPath() },
      });
      if (!result) return null;
      return { text: result.text, sessionId: result.sessionId };
    } finally {
      if (token) revokeRendererToken(token);
      if (configPath) { try { unlinkSync(configPath); } catch { /* already gone */ } }
    }
  }

  private async compact(t: TaskState): Promise<void> {
    if (!t.sessionId || !this.usesClaude()) return;
    const choice = getGlyphModelChoice(this.db);
    const result = await runOneShotText({
      db: this.db,
      agentType: choice.agent_type,
      model: choice.model,
      prompt: "/compact",
      sessionId: t.sessionId,
      timeoutMs: MODEL_TIMEOUT_MS,
      extraArgs: ["--max-turns", "1", ...CLAUDE_ISOLATION_ARGS],
      env: { PATH: agentSpawnPath() },
    });
    if (result?.sessionId) t.sessionId = result.sessionId;
  }
}

function loadSystemPrompt(): string {
  try {
    return assetTextSync(PROMPT_ASSET).trim();
  } catch (err) {
    console.warn("[glyph] could not read %s: %s", PROMPT_ASSET, err instanceof Error ? err.message : String(err));
    return "You are the glyph renderer. Reply with one ```glyph block containing RENDER <frame>, PATCH <ops>, or NOOP.";
  }
}
