import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { eventBus } from "../events/bus";
import type { MessagePart } from "../events/bus";
import type { AgentManager, PermissionMode } from "../agents/manager";
import { getChatModelOverride } from "../config/model-settings";
import { logError } from "../logging";

const PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "plan",
  "bypassPermissions",
]);

export interface Conversation {
  id: string;
  title: string;
  status: "active" | "archived";
  agent_instance_id: string | null;
  session_id: string | null;
  template_agent_id: string | null;
  system_prompt: string;
  permission_mode: PermissionMode;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: MessagePart[];
  created_at: string;
}

interface ConversationRow {
  id: string;
  title: string;
  status: string;
  agent_instance_id: string | null;
  session_id: string | null;
  template_agent_id: string | null;
  system_prompt: string | null;
  permission_mode: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  parts: string | null;
  created_at: string;
}

interface TurnState {
  turnId: string;
  blockCount: number;
  parts: MessagePart[];
  textChunks: string[];
}

function rowToConversation(row: ConversationRow): Conversation {
  const mode = (row.permission_mode ?? "bypassPermissions") as PermissionMode;
  return {
    id: row.id,
    title: row.title,
    status: row.status as "active" | "archived",
    agent_instance_id: row.agent_instance_id,
    session_id: row.session_id,
    template_agent_id: row.template_agent_id,
    system_prompt: row.system_prompt ?? "",
    permission_mode: PERMISSION_MODES.has(mode) ? mode : "bypassPermissions",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToMessage(row: ConversationMessageRow): ConversationMessage {
  let parts: MessagePart[] = [];
  if (row.parts) {
    try {
      const parsed = JSON.parse(row.parts);
      if (Array.isArray(parsed)) parts = parsed as MessagePart[];
    } catch {
      // Treat malformed JSON as no parts; consolidated content still renders.
    }
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    parts,
    created_at: row.created_at,
  };
}


export class ConversationManager {
  private db: Database;
  private agentManager: AgentManager;
  // conversationId -> current runtimeId
  private activeAgents: Map<string, string> = new Map();
  // runtimeId -> in-progress turn state (parts collected before final flush)
  private turns: Map<string, TurnState> = new Map();
  // conversationId -> last-emitted busy flag, so we never emit duplicate
  // transitions (chat UI re-renders the indicator slot on every change).
  private busy: Map<string, boolean> = new Map();

  constructor(db: Database, agentManager: AgentManager) {
    this.db = db;
    this.agentManager = agentManager;
    this.registerEventHandlers();
  }

  private getOrStartTurn(conversationId: string, runtimeId: string): TurnState {
    let turn = this.turns.get(runtimeId);
    if (!turn) {
      turn = { turnId: randomUUID(), blockCount: 0, parts: [], textChunks: [] };
      this.turns.set(runtimeId, turn);
      eventBus.emit("conversation:turn_started", { conversationId, turnId: turn.turnId });
    }
    return turn;
  }

  private emitPart(conversationId: string, runtimeId: string, part: MessagePart): void {
    const turn = this.getOrStartTurn(conversationId, runtimeId);
    const blockIndex = turn.blockCount++;
    turn.parts.push(part);
    if (part.kind === "text") turn.textChunks.push(part.content);
    eventBus.emit("conversation:stream_chunk", {
      conversationId,
      turnId: turn.turnId,
      blockIndex,
      part,
    });
  }

  private processContentArray(
    conversationId: string,
    runtimeId: string,
    content: unknown,
    sourceRole: "assistant" | "user",
  ): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const type = typeof b.type === "string" ? b.type : "";

      if (sourceRole === "assistant" && type === "text" && typeof b.text === "string" && b.text.length > 0) {
        this.emitPart(conversationId, runtimeId, { kind: "text", content: b.text });
      } else if (sourceRole === "assistant" && type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0) {
        this.emitPart(conversationId, runtimeId, { kind: "thinking", content: b.thinking });
      } else if (sourceRole === "assistant" && type === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "(tool)";
        const id = typeof b.id === "string" ? b.id : undefined;
        const input = b.input;
        const display = typeof input === "string" ? input : JSON.stringify(input ?? null, null, 2);
        this.emitPart(conversationId, runtimeId, {
          kind: "tool_use",
          name,
          input,
          toolUseId: id,
          content: display,
        });
      } else if (sourceRole === "user" && type === "tool_result") {
        const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
        let display = "";
        const rc = b.content;
        if (typeof rc === "string") {
          display = rc;
        } else if (Array.isArray(rc)) {
          display = rc
            .map((c) => {
              if (c && typeof c === "object") {
                const cc = c as Record<string, unknown>;
                if (typeof cc.text === "string") return cc.text;
              }
              return "";
            })
            .filter(Boolean)
            .join("\n");
        }
        this.emitPart(conversationId, runtimeId, {
          kind: "tool_result",
          toolUseId,
          content: display,
        });
      }
    }
  }

  private finalizeTurn(conversationId: string, runtimeId: string, fallbackResult?: string): void {
    const turn = this.turns.get(runtimeId);
    if (!turn) {
      // No streamed blocks yet; some agents emit only a `result` event with the final text.
      if (fallbackResult && fallbackResult.trim()) {
        this.storeAssistantMessage(conversationId, fallbackResult.trim(), []).catch((err) => {
          logError(this.db, "conversation.store_assistant_message", { conversationId }, err);
        });
      }
      return;
    }
    this.turns.delete(runtimeId);

    const consolidated = turn.textChunks.join("\n\n").trim() || (fallbackResult?.trim() ?? "");
    if (consolidated || turn.parts.length > 0) {
      this.storeAssistantMessage(conversationId, consolidated, turn.parts).catch((err) => {
        logError(this.db, "conversation.store_assistant_message", { conversationId }, err);
      });
    }
  }

  private registerEventHandlers(): void {
    eventBus.on("agent:output", (event) => {
      const conversationId = this.isConversationAgent(event.agentId);
      if (!conversationId || event.stream !== "stdout") return;

      for (const line of event.data.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const json = JSON.parse(trimmed) as Record<string, unknown>;

          // Persist session_id as soon as we see it
          const sessionId =
            (json.session_id ?? json.thread_id ?? json.sessionID) as string | undefined;
          if (sessionId) {
            try {
              this.db
                .prepare(
                  `UPDATE conversations
                   SET session_id = ?, updated_at = datetime('now')
                   WHERE id = ? AND (session_id IS NULL OR session_id != ?)`,
                )
                .run(sessionId, conversationId, sessionId);
            } catch (err) {
              logError(this.db, "conversation.capture_session_id", { conversationId }, err);
            }
          }

          const eventType = typeof json.type === "string" ? json.type : "";

          // Stream per content block for assistant and user (tool_result) events.
          if (eventType === "assistant" || eventType === "user") {
            const msg = json.message as Record<string, unknown> | undefined;
            if (msg && Array.isArray(msg.content)) {
              this.processContentArray(conversationId, event.agentId, msg.content, eventType);
            }
          }

          // Finalize and persist the turn on completion markers.
          if (eventType === "result" || eventType === "turn.completed" || eventType === "step_finish") {
            const fallback = eventType === "result" && typeof json.result === "string"
              ? (json.result as string)
              : undefined;
            this.finalizeTurn(conversationId, event.agentId, fallback);
          }
        } catch {
          // Not JSON — skip
        }
      }
    });

    // Clean up tracking on agent exit
    eventBus.on("agent:exit", (event) => {
      if (event.isRespawn) return;
      const conversationId = this.isConversationAgent(event.agentId);
      if (!conversationId) return;
      // Flush any in-flight turn so the user does not lose content on early exit.
      if (this.turns.has(event.agentId)) {
        this.finalizeTurn(conversationId, event.agentId);
      }
      // If a newer runtime has already taken over (interrupt flow killed this
      // one and spawned a replacement), leave activeAgents + busy alone — the
      // new turn owns them.
      const stillActive = this.activeAgents.get(conversationId) === event.agentId;
      if (!stillActive) return;
      this.activeAgents.delete(conversationId);
      this.setBusy(conversationId, false);
    });
  }

  /**
   * Track per-conversation busy state and emit a transition event for the UI.
   * Idempotent: re-emits at the same state are suppressed so the chat slot
   * doesn't churn while the agent streams chunks.
   */
  private setBusy(conversationId: string, busy: boolean): void {
    if (this.busy.get(conversationId) === busy) return;
    this.busy.set(conversationId, busy);
    const conv = this.getConversation(conversationId);
    let model: string | undefined;
    if (conv?.template_agent_id) {
      const row = this.db
        .prepare("SELECT model FROM agents WHERE id = ?")
        .get(conv.template_agent_id) as { model: string } | null;
      model = row?.model ?? undefined;
    }
    // The machine-scoped chat override (config page) wins for the displayed model.
    model = this.chatSpawnOverride().modelOverride ?? model;
    eventBus.emit("conversation:busy_changed", { conversationId, busy, model });
  }

  /** Public: snapshot the current busy state for a conversation (used by initial render). */
  isBusy(conversationId: string): boolean {
    return this.busy.get(conversationId) === true;
  }

  /**
   * Machine-scoped provider/model override for the chat agent (config page).
   * Empty fields fall through to the chat-skipper agent row at spawn time.
   */
  private chatSpawnOverride(): { agentTypeOverride?: string; modelOverride?: string } {
    const o = getChatModelOverride(this.db);
    return { agentTypeOverride: o.agent_type, modelOverride: o.model };
  }

  /**
   * On server restart, restore tracking for active conversations.
   * We do NOT re-spawn agents — they'll be spawned on-demand when the user
   * sends the next message (via sendMessage() which uses session_id to resume).
   * This prevents duplicate "Online. What you need?" messages on every restart.
   */
  async restoreConversations(): Promise<void> {
    // Nothing to spawn — conversations with session_id will resume on next sendMessage().
    // But the previous process may have crashed mid-turn, leaving connected
    // browsers stuck on a stale busy=true indicator. Emit a clean busy=false
    // for every active conversation so reconnecting clients land in a known
    // good state. We bypass setBusy() because the in-memory map is empty here
    // (would short-circuit) and we want the event regardless.
    const rows = this.db
      .prepare(
        "SELECT id, template_agent_id FROM conversations WHERE status = 'active'",
      )
      .all() as { id: string; template_agent_id: string | null }[];
    for (const row of rows) {
      this.busy.set(row.id, false);
      let model: string | undefined;
      if (row.template_agent_id) {
        const agentRow = this.db
          .prepare("SELECT model FROM agents WHERE id = ?")
          .get(row.template_agent_id) as { model: string } | null;
        model = agentRow?.model ?? undefined;
      }
      eventBus.emit("conversation:busy_changed", {
        conversationId: row.id,
        busy: false,
        model,
      });
    }
  }

  /**
   * Create a new conversation, spawn its agent with the system prompt.
   * systemPromptContent is the full initial system/context prompt.
   */
  async createConversation(systemPromptContent: string, title?: string): Promise<Conversation> {
    // Find the chat agent — look for an agent named "Chat Skipper" or with conversation role
    const agentRow = this.db
      .prepare(
        "SELECT a.id FROM agents a WHERE a.name LIKE '%chat%skipper%' OR a.name LIKE '%skipper%chat%' ORDER BY a.created_at ASC LIMIT 1",
      )
      .get() as { id: string } | null;
    if (!agentRow) {
      throw new Error(
        "No chat agent found. Create an agent named 'Chat Skipper' in the agents panel.",
      );
    }

    const id = randomUUID();
    const convTitle = title?.trim() || "New Conversation";
    this.db
      .prepare(
        "INSERT INTO conversations (id, title, status, template_agent_id, system_prompt) VALUES (?, ?, 'active', ?, ?)",
      )
      .run(id, convTitle, agentRow.id, systemPromptContent);

    // No agent spawn here. The agent starts on the first user message so we
    // don't burn a turn (and a model billing call) generating an unsolicited
    // greeting the user never asked for.

    eventBus.emit("conversation:created", { conversationId: id });
    return this.getConversation(id)!;
  }

  /**
   * Send a user message to an active conversation.
   * Returns the stored user message immediately; the assistant response
   * arrives asynchronously via agent:output and conversation:message events.
   */
  async sendMessage(conversationId: string, content: string): Promise<ConversationMessage> {
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error("Conversation not found");
    if (conv.status === "archived") throw new Error("Conversation is archived");
    if (!conv.template_agent_id) throw new Error("Conversation has no agent template configured");

    // Store user message
    const messageId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO conversation_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
      )
      .run(messageId, conversationId, content);
    this.db
      .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
      .run(conversationId);
    eventBus.emit("conversation:message", { conversationId, messageId, role: "user", content });

    // Check if agent is still running (e.g. previous turn still processing)
    const currentRuntimeId = this.activeAgents.get(conversationId);
    const isStillRunning =
      currentRuntimeId !== undefined &&
      this.agentManager.getRunningAgent(currentRuntimeId) !== undefined;

    if (isStillRunning && currentRuntimeId) {
      // INTERRUPT: a previous turn is still running. Kill it and resume the
      // session with the new message so input takes effect immediately.
      //
      // Why not just sendInput? For inline-prompt agent types (codex with
      // sessionId) sendInput throws outright. For claude-code, stdin was
      // already closed by the previous sendInput(closeStdin=true) and the
      // process is in --print mode (one-shot), so a second write either
      // errors or is silently ignored. Either way the user gets no response.
      // Kill + resume gives uniform, immediate interrupt across agent types.
      const priorSessionId = this.agentManager.getSessionId(currentRuntimeId);
      this.agentManager.killAgent(currentRuntimeId);
      try {
        await this.agentManager.waitForExit(currentRuntimeId, 5000);
      } catch {
        // Best-effort wait — proceed even if streams_drained doesn't fire in time.
      }
      this.activeAgents.delete(conversationId);
      const newRuntimeId = randomUUID();
      const resumeSession = priorSessionId ?? conv.session_id ?? undefined;
      await this.agentManager.spawnAgentInstance(conv.template_agent_id, newRuntimeId, {
        workingDir: process.cwd(),
        sessionId: resumeSession,
        taskId: null,
        permissionMode: conv.permission_mode,
        ...this.chatSpawnOverride(),
      });
      this.agentManager.sendInput(newRuntimeId, content, true);
      this.activeAgents.set(conversationId, newRuntimeId);
      this.db
        .prepare(
          "UPDATE conversations SET agent_instance_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(newRuntimeId, conversationId);
    } else if (conv.session_id) {
      // Resume a new process with the existing session
      const runtimeId = randomUUID();
      await this.agentManager.spawnAgentInstance(conv.template_agent_id, runtimeId, {
        workingDir: process.cwd(),
        sessionId: conv.session_id,
        taskId: null,
        permissionMode: conv.permission_mode,
        ...this.chatSpawnOverride(),
      });
      this.agentManager.sendInput(runtimeId, content, true);
      this.activeAgents.set(conversationId, runtimeId);
      this.db
        .prepare(
          "UPDATE conversations SET agent_instance_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(runtimeId, conversationId);
    } else {
      // First turn for this conversation — agent was not spawned at create time
      // so we spawn it now and prefix the user message with the system prompt.
      const runtimeId = randomUUID();
      await this.agentManager.spawnAgentInstance(conv.template_agent_id, runtimeId, {
        workingDir: process.cwd(),
        taskId: null,
        permissionMode: conv.permission_mode,
        ...this.chatSpawnOverride(),
      });
      const initialPrompt = conv.system_prompt
        ? `${conv.system_prompt}\n\n${content}`
        : content;
      this.agentManager.sendInput(runtimeId, initialPrompt, true);
      this.activeAgents.set(conversationId, runtimeId);
      this.db
        .prepare(
          "UPDATE conversations SET agent_instance_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(runtimeId, conversationId);
    }

    // Agent has the user message — flip busy on so the UI shows a "thinking"
    // indicator until either the turn finalizes or the process exits.
    this.setBusy(conversationId, true);

    return this.db
      .prepare("SELECT * FROM conversation_messages WHERE id = ?")
      .get(messageId) as ConversationMessageRow as unknown as ConversationMessage;
  }

  async storeAssistantMessage(
    conversationId: string,
    content: string,
    parts: MessagePart[] = [],
  ): Promise<void> {
    const messageId = randomUUID();
    const partsJson = JSON.stringify(parts);
    this.db
      .prepare(
        "INSERT INTO conversation_messages (id, conversation_id, role, content, parts) VALUES (?, ?, 'assistant', ?, ?)",
      )
      .run(messageId, conversationId, content, partsJson);
    this.db
      .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
      .run(conversationId);
    eventBus.emit("conversation:message", {
      conversationId,
      messageId,
      role: "assistant",
      content,
      parts,
    });
  }

  /**
   * Update the conversation's --permission-mode override. If a chat turn is
   * currently running (the `claude --print` process is mid-stream), kill it so
   * the user's next message spawns a fresh process with the new mode. When the
   * agent is idle (chat processes only live for one turn), nothing to kill —
   * the change takes effect on the next message via the existing resume path
   * which now reads conv.permission_mode.
   */
  async setPermissionMode(conversationId: string, mode: PermissionMode): Promise<Conversation> {
    if (!PERMISSION_MODES.has(mode)) {
      throw new Error(`Invalid permission_mode: ${mode}`);
    }
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error("Conversation not found");
    if (conv.status === "archived") throw new Error("Conversation is archived");

    this.db
      .prepare(
        "UPDATE conversations SET permission_mode = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(mode, conversationId);

    const currentRuntimeId = this.activeAgents.get(conversationId);
    const isStillRunning =
      currentRuntimeId !== undefined &&
      this.agentManager.getRunningAgent(currentRuntimeId) !== undefined;
    if (isStillRunning && currentRuntimeId) {
      this.agentManager.killAgent(currentRuntimeId);
      try {
        await this.agentManager.waitForExit(currentRuntimeId, 5000);
      } catch { /* best-effort */ }
      this.activeAgents.delete(conversationId);
      this.turns.delete(currentRuntimeId);
      this.setBusy(conversationId, false);
    }

    eventBus.emit("conversation:permission_mode_changed", { conversationId, mode });
    return this.getConversation(conversationId)!;
  }

  async archiveConversation(conversationId: string): Promise<void> {
    const runtimeId = this.activeAgents.get(conversationId);
    if (runtimeId) {
      try {
        this.agentManager.killAgent(runtimeId);
      } catch {
        // Ignore — process may already be gone
      }
      this.activeAgents.delete(conversationId);
      this.turns.delete(runtimeId);
    }
    this.db
      .prepare(
        "UPDATE conversations SET status = 'archived', updated_at = datetime('now') WHERE id = ?",
      )
      .run(conversationId);
    eventBus.emit("conversation:archived", { conversationId });
  }

  renameConversation(conversationId: string, title: string): Conversation {
    this.db
      .prepare(
        "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(title.trim(), conversationId);
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error("Conversation not found");
    return conv;
  }

  getConversations(status?: "active" | "archived"): Conversation[] {
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM conversations WHERE status = ? ORDER BY updated_at DESC")
          .all(status) as ConversationRow[])
      : (this.db
          .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
          .all() as ConversationRow[]);
    return rows.map(rowToConversation);
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | null;
    return row ? rowToConversation(row) : undefined;
  }

  getMessages(conversationId: string, afterId?: string): ConversationMessage[] {
    if (afterId) {
      const afterRow = this.db
        .prepare("SELECT created_at FROM conversation_messages WHERE id = ?")
        .get(afterId) as { created_at: string } | null;
      if (afterRow) {
        return (
          this.db
            .prepare(
              "SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC",
            )
            .all(conversationId, afterRow.created_at) as ConversationMessageRow[]
        ).map(rowToMessage);
      }
    }
    return (
      this.db
        .prepare(
          "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
        )
        .all(conversationId) as ConversationMessageRow[]
    ).map(rowToMessage);
  }

  /**
   * Returns the conversationId if the given runtimeId belongs to a conversation agent.
   */
  isConversationAgent(runtimeId: string): string | undefined {
    for (const [convId, rtId] of this.activeAgents) {
      if (rtId === runtimeId) return convId;
    }
    return undefined;
  }

  getRuntimeId(conversationId: string): string | undefined {
    return this.activeAgents.get(conversationId);
  }
}
