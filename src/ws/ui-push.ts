import type { Database } from "bun:sqlite";
import type { ServerWebSocket, Server } from "bun";
import type { WSData, UiPushWSData } from "./types";
import { eventBus } from "../events/bus";
import type { EventName } from "../events/bus";
import {
  taskDetailSummaryFragment,
  taskPhaseStepperFragment,
  taskDelegationsFragment,
  logsTableFragment,
  renderTerminalOutputChunk,
  terminalOutputFragment,
} from "../html/components";
import { taskListFragment } from "../html/taskListFragment";
import { dashboardRealtimeTimelineFragment } from "../html/dashboardRealtimeTimelineFragment";
import { dashboardPhaseIndicatorFragment } from "../html/dashboardPhaseIndicatorFragment";
import { dashboardEscalationsFragment } from "../html/dashboardEscalationsFragment";
import { dashboardDelegationGroupsFragment } from "../html/dashboardDelegationGroupsFragment";
import { dashboardActiveAgentsCountFragment } from "../html/dashboardActiveAgentsCountFragment";
import { dashboardRunningInstancesFragment } from "../html/dashboardRunningInstancesFragment";
import { dashboardQueueFragment } from "../html/dashboardQueueFragment";
import { selectDashboardFocusTasks } from "../html/selectDashboardFocusTasks";
import { dashboardSteerPanelSlotFragment } from "../html/dashboardSteerPanelFragment";
import { dashboardActiveTaskFragment } from "../html/dashboardActiveTaskFragment";
import { recentActivityFragment } from "../html/recentActivityFragment";
import { chatPartFragment, chatUserBubble, chatAssistantMessage } from "../html/chatPartFragment";
import { escalationCountFragment } from "../html/fragments/escalation-count.fragment";
import { sidebarEscalationFooter } from "../html/pages/command-center.page";
import { renderSidebarListBody } from "../html/pages/command-center.page";
import { buildCommandCenterViewModel } from "../html/view-models/command-center.vm";
import type {
  RecentLogEntry,
  LogEntryData,
  DashboardData,
} from "../html/components";
import {
  timelineEntriesFragment,
  notesFragment,
  runningAgentsFragment,
} from "../html/realtime-components";
import type {
  TimelineEntry,
  TaskNote,
  RunningAgentInstance,
} from "../html/realtime-components";
import { notesPanel } from "../html/panels/notes.panel";
import { escalationCardPanel, type EscalationCardData } from "../html/panels/escalation-card.panel";
import { dashboardSteerListFragment, steerCardInfoMarkup, type SteeringOption } from "../html/dashboardLatestSteerFragment";
import { dashboardNotesFragment } from "../html/dashboardNotesFragment";
import type { TaskNoteData } from "../html/components";
import { renderPhaseStripFragment, parseTerminalActivity } from "../html/pages/command-center.page";
import {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchDashboardRealtimeTimeline,
  fetchDashboardPhaseIndicatorTask,
  getPollIntervalSeconds,
} from "../routes/pages";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { topicMatches } from "./fragment-registry";
import { formatTimestamp } from "../html/atoms/format-timestamp";
import { escapeHtml } from "../html/atoms/escape-html";

import { terminalJsonSummary } from "../html/terminalJsonSummary";

const DEBOUNCE_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const DASHBOARD_ACTIVITY_LIMIT = 250;

export function fetchLatestAssistantMessage(db: Database, agentId: string): string | null {
  const rows = db.prepare(
    "SELECT data FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout' ORDER BY id DESC LIMIT 20",
  ).all(agentId) as { data: string }[];
  for (const row of rows) {
    const text = row.data.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed.type === "assistant") {
        const summary = terminalJsonSummary(parsed);
        if (summary) return summary;
      }
    } catch { /* skip */ }
  }
  return null;
}

function fetchDashboardRunningInstances(db: Database): NonNullable<DashboardData["runningInstances"]> {
  return db.prepare(
    `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS template_agent_name, ai.task_id, t.title AS task_title,
            ai.status, ai.parent_instance_id, ai.root_instance_id, ai.created_at, ai.updated_at
     FROM agent_instances ai
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     LEFT JOIN tasks t ON t.id = ai.task_id
     WHERE ai.status IN ('running', 'waiting_delegation')
     ORDER BY ai.updated_at DESC`,
  ).all() as NonNullable<DashboardData["runningInstances"]>;
}

/**
 * Pushes server-rendered HTML fragments to connected WebSocket clients.
 *
 * Features:
 * - Topic-based subscriptions: clients subscribe to topics and only receive matching fragments
 * - Batch sends: multiple OOB swaps in a single WebSocket message
 * - Heartbeat: ping every 30s for connection health
 * - Debouncing: high-frequency events are coalesced
 */
export class UIWebSocketManager {
  private readonly clients = new Set<ServerWebSocket<WSData>>();
  private readonly debounceTimers = new Map<string, Timer>();
  private heartbeatTimer: Timer | null = null;
  // Last steer-panel HTML we broadcast. Agent/task/instance state changes fire
  // constantly while work runs; re-pushing the identical panel OOB-swaps the
  // form out from under the user mid-type/mid-click. Only push on real change.
  private lastSteeringFragment = "";
  private lastV2SteerRuntimeIds = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly daemon: Pick<ManagerDaemon, "listRuntimeSteeringOptions" | "getConversationManager">,
  ) {
    this.registerEventHandlers();
    this.startHeartbeat();
  }

  tryUpgrade(req: Request, server: Server): boolean {
    const url = new URL(req.url);
    if (url.pathname !== "/ws/ui") return false;

    const format: "html" | "json" = url.searchParams.get("format") === "json" ? "json" : "html";

    // Parse initial topics from query param
    const topicsParam = url.searchParams.get("topics");
    const initialTopics = new Set<string>();
    if (topicsParam) {
      for (const t of topicsParam.split(",")) {
        const trimmed = t.trim();
        if (trimmed) initialTopics.add(trimmed);
      }
    }

    return server.upgrade(req, {
      data: {
        type: "ui-push" as const,
        subscriptions: initialTopics,
        format,
      } satisfies UiPushWSData,
    });
  }

  readonly wsHandlers = {
    open: (ws: ServerWebSocket<WSData>) => {
      this.clients.add(ws);
    },
    message: (ws: ServerWebSocket<WSData>, message: string | Buffer) => {
      // Handle subscription messages from clients
      try {
        const msg = JSON.parse(typeof message === "string" ? message : message.toString());
        const data = ws.data as UiPushWSData;

        if (msg.type === "subscribe" && Array.isArray(msg.topics)) {
          for (const t of msg.topics) {
            if (typeof t === "string") {
              data.subscriptions.add(t);
              // When a client (re)subscribes to a chat topic, push the current
              // busy state for that conversation so a page that reconnected
              // after a crash or network blip doesn't get stuck on a stale
              // "thinking" indicator (or miss an in-flight one).
              if (t.startsWith("conversation:") && data.format === "html") {
                const convId = t.slice("conversation:".length);
                this.pushBusyToSocket(ws, convId);
              }
            }
          }
        } else if (msg.type === "unsubscribe" && Array.isArray(msg.topics)) {
          for (const t of msg.topics) {
            data.subscriptions.delete(t);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    },
    close: (ws: ServerWebSocket<WSData>) => {
      this.clients.delete(ws);
    },
  };

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const ping = JSON.stringify({ type: "ping", timestamp: Date.now() });
      for (const ws of this.clients) {
        try { ws.send(ping); } catch { this.clients.delete(ws); }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Broadcast HTML fragment to clients subscribed to the given topics.
   * Injects hx-swap-oob="true" for htmx auto-swap.
   */
  private broadcast(html: string, topics: string[] = []): void {
    const oobHtml = oob(html);
    for (const ws of this.clients) {
      const data = ws.data as UiPushWSData;
      if (data.format === "json") continue;
      if (topics.length > 0 && !topicMatches(data.subscriptions, topics)) continue;
      try { ws.send(oobHtml); } catch { this.clients.delete(ws); }
    }
  }

  /**
   * Broadcast multiple HTML fragments as a single WebSocket message.
   * Each fragment should already have hx-swap-oob attributes.
   */
  private broadcastBatch(fragments: Array<{ html: string; topics: string[] }>): void {
    // Group fragments by topic overlap for efficient sending
    for (const ws of this.clients) {
      const data = ws.data as UiPushWSData;
      if (data.format === "json") continue;

      const matching = fragments.filter(f =>
        f.topics.length === 0 || topicMatches(data.subscriptions, f.topics)
      );
      if (matching.length === 0) continue;

      // Concatenate all matching fragments into one message
      const combined = matching.map(f => oob(f.html)).join("\n");
      try { ws.send(combined); } catch { this.clients.delete(ws); }
    }
  }

  private broadcastRaw(html: string, topics: string[] = []): void {
    for (const ws of this.clients) {
      const data = ws.data as UiPushWSData;
      if (data.format === "json") continue;
      if (topics.length > 0 && !topicMatches(data.subscriptions, topics)) continue;
      try { ws.send(html); } catch { this.clients.delete(ws); }
    }
  }

  broadcastNotification(soundUrl: string): void {
    const payload = JSON.stringify({ __sk_notify: { kind: "audio", sound: soundUrl } });
    for (const ws of this.clients) {
      const data = ws.data as UiPushWSData;
      if (data.format !== "html") continue;
      try { ws.send(payload); } catch { this.clients.delete(ws); }
    }
  }

  broadcastJson(event: string, resource: string, id: string | null, data: unknown): void {
    const message = JSON.stringify({
      event,
      resource,
      id,
      data,
      timestamp: new Date().toISOString(),
    });
    for (const ws of this.clients) {
      if ((ws.data as UiPushWSData).format === "json") {
        try { ws.send(message); } catch { this.clients.delete(ws); }
      }
    }
  }

  private debounced(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, DEBOUNCE_MS));
  }

  private registerEventHandlers(): void {
    // --- Task state changed ---
    eventBus.on("task:state_changed", (event) => {
      this.pushDashboardTasks();
      this.pushDashboardInstances();
      this.pushDashboardSteering();
      this.pushDashboardRealtimeTimeline();
      this.pushDashboardPhaseIndicator();
      this.pushV2PhaseStrip(event.taskId);
      this.pushV2SteerPanel(event.taskId);
      this.triggerDashboardRerender();
      this.pushTaskList();
      this.pushTaskDetail(event.taskId);
      // V2 command-center sidebar (Running/Queue/Recent/Drafts groupings) is
      // server-rendered once on page load and otherwise stale — re-broadcast
      // the list body so completed tasks slip out of the "Running" group
      // without a manual refresh.
      this.pushCommandCenterSidebar();
      // V2 workspace refresh — only on terminal transitions (running/completed/
      // failed), not on every intermediate state_changed. Replacing #mc-main
      // wipes scroll position, expanded tree nodes, and re-fires every nested
      // hx-trigger="revealed" — which caused a request flood when there were
      // many agents in the tree. Sub-fragments inside taskMainContent already
      // self-poll every 3-5s for live updates.
      const terminal = event.newStatus === "completed" || event.newStatus === "failed" || event.newStatus === "running";
      if (terminal && event.previousStatus !== event.newStatus) {
        this.pushV2WorkspaceRefresh(event.taskId);
      }
    });

    // --- Instance state changed ---
    eventBus.on("instance:state_changed", (event) => {
      this.pushDashboardInstances();
      this.pushDashboardSteering();
      if (event.taskId) this.pushRtRunningAgents(event.taskId);
      if (event.taskId) this.pushV2SteerPanel(event.taskId);
    });

    // --- Agent state changed ---
    eventBus.on("agent:state_changed", () => {
      this.pushDashboardInstances();
      this.pushDashboardSteering();
    });

    // --- Agent output (debounced) ---
    eventBus.on("agent:output", (event) => {
      this.debounced("recent-activity", () => this.pushRecentActivity());
      this.debounced("log-entries", () => this.pushLogEntries());
      const chunk = renderTerminalOutputChunk(event.stream, event.data);
      this.broadcastRaw(
        `<div id="terminal-lines" hx-swap-oob="beforeend">${chunk}</div>`,
        ["dashboard", `agent:${event.agentId}`],
      );
      const taskRow = this.db.prepare("SELECT task_id FROM agent_instances WHERE id = ?").get(event.agentId) as { task_id: string } | null;
      if (taskRow?.task_id) {
        this.debounced(`v2-activity-${taskRow.task_id}`, () => this.pushV2ActivityFeed(taskRow!.task_id));
        this.debounced(`v2-steer-${taskRow.task_id}`, () => this.pushV2SteerPanel(taskRow!.task_id));
      }
    });

    // --- Agent exit ---
    eventBus.on("agent:exit", (event) => {
      this.pushDashboardTasks();
      this.pushDashboardInstances();
      this.pushDashboardSteering();
      this.pushDashboardPhaseIndicator();
      // Don't push full workspace refresh on agent exit — it resets the active tab.
      // The activity feed polls for updates, and task:state_changed covers status/phase changes.
    });

    // --- Streams drained ---
    eventBus.on("agent:streams_drained", (event) => {
      const session = this.db.prepare(
        "SELECT id FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(event.agentId) as { id: string } | null;
      if (!session) return;
      const rows = this.db.prepare(
        "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
      ).all(event.agentId, session.id) as { stream: string; data: string; sequence: number }[];
      if (rows.length === 0) return;
      const html = terminalOutputFragment(rows);
      this.broadcastRaw(
        `<div id="terminal-lines" hx-swap-oob="innerHTML">${html}</div>`,
        [`agent:${event.agentId}`],
      );
    });

    // --- Agent signal ---
    eventBus.on("agent:signal", (event) => {
      if (event.signalType === "phase_regression") {
        this.pushDashboardPhaseIndicator();
        if (event.taskId) {
          this.pushTaskDetail(event.taskId);
          this.pushV2PhaseStrip(event.taskId);
        }
      }
    });

    // --- Phase review flag toggled ---
    // Without this, the "Approve / Reject" review banner that taskMainContent
    // renders server-side only appears after a manual page refresh. Push a
    // full workspace refresh so the banner surfaces live. (Same heavy-handed
    // mc-main reload as terminal status transitions — fine here because
    // needs_review toggles are rare.)
    eventBus.on("task:needs_review_changed", (event) => {
      this.pushDashboardPhaseIndicator();
      this.pushV2PhaseStrip(event.taskId);
      this.pushTaskDetail(event.taskId);
      this.pushV2WorkspaceRefresh(event.taskId);
    });

    // --- Delegation progress ---
    eventBus.on("delegation_group:progress", (event) => {
      this.pushTaskDelegations(event.taskId);
      this.pushDashboardDelegations();
    });

    // --- Note added ---
    eventBus.on("task:note_added", (event) => {
      this.pushRtNotes(event.taskId);
      this.pushV2Notes(event.taskId);
    });

    // --- Artifact created ---
    eventBus.on("artifact:created", (event) => {
      this.pushArtifactList(event.taskId);
      this.pushV2Artifacts(event.taskId);
    });

    // --- Realtime window ready ---
    eventBus.on("realtime:window_ready", (event) => {
      this.pushRtTimeline(event.taskId);
      this.pushDashboardRealtimeTimeline();
    });

    eventBus.on("realtime:timeline_updated", (event) => {
      this.pushRtTimeline(event.taskId);
      this.pushDashboardRealtimeTimeline();
    });

    // --- Realtime session state ---
    eventBus.on("realtime:session_state", (event) => {
      this.pushDashboardTasks();
      this.pushDashboardPhaseIndicator();
      this.pushRtRunningAgents(event.taskId);
      this.pushRtTimeline(event.taskId);
      this.pushDashboardRealtimeTimeline();
    });

    // --- Escalation ---
    eventBus.on("escalation:created", (event) => {
      this.pushDashboardEscalations();
      this.pushEscalationCount();
      this.pushSidebarEscalationFooter();
      if (event.taskId) this.pushV2TaskEscalations(event.taskId);
    });
    eventBus.on("escalation:resolved", (event) => {
      this.pushDashboardEscalations();
      this.pushEscalationCount();
      this.pushSidebarEscalationFooter();
      // Resolve may have respawned the parent agent (sendResumeMessage / spawnAgentInstance
      // fallbacks in EscalationManager.injectResponse) — refresh running instances so the
      // dashboard count reflects the latest state and the user isn't misled into a second resolve.
      this.pushDashboardInstances();
      if (event.taskId) this.pushV2TaskEscalations(event.taskId);
    });

    // --- Conversation messages ---
    eventBus.on("conversation:message", (event) => {
      this.pushConversationMessage(
        event.conversationId,
        event.messageId,
        event.role,
        event.content,
        event.parts ?? [],
      );
      this.pushSidebarChats();
    });
    eventBus.on("conversation:stream_chunk", (event) => {
      this.pushConversationStreamChunk(event.conversationId, event.turnId, event.blockIndex, event.part);
    });

    // --- Conversation lifecycle ---
    eventBus.on("conversation:created", () => {
      this.pushSidebarChats();
    });
    eventBus.on("conversation:archived", () => {
      this.pushSidebarChats();
    });
    eventBus.on("conversation:busy_changed", (event) => {
      this.pushConversationBusy(event.conversationId, event.busy, event.model);
    });
  }

  // --- Fragment renderers (with topic annotations) ---

  private pushDashboardTasks(): void {
    const dashboardTasks = this.db.prepare(
      "SELECT id, title, status, task_type, created_at FROM tasks WHERE status IN ('running', 'approved', 'completed') ORDER BY created_at DESC",
    ).all() as { id: string; title: string; status: string; task_type?: string; created_at?: string }[];
    const focusTasks = selectDashboardFocusTasks(dashboardTasks);
    this.broadcast(`<div id="active-tasks" class="cmd-layout-focus">${dashboardActiveTaskFragment(focusTasks)}</div>`, ["dashboard"]);
    const queueTasks = dashboardTasks.filter((task) => task.status === "approved");
    this.broadcast(`<div id="dashboard-queue" class="cmd-panel-body-flush cmd-scroll-compact">${dashboardQueueFragment(queueTasks)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:tasks", null, { tasks: focusTasks });
    this.pushDashboardMetrics();
  }

  private triggerDashboardRerender(): void {
    this.broadcast(`<div id="dashboard-rerender-trigger" style="display:none;" hx-get="/" hx-trigger="load" hx-target="body" hx-swap="outerHTML"></div>`, ["dashboard"]);
  }

  private pushDashboardMetrics(): void {
    const allTasks = this.db.prepare(
      "SELECT status FROM tasks",
    ).all() as { status: string }[];
    const running = allTasks.filter((t) => t.status === "running").length;
    const queued = allTasks.filter((t) => t.status === "approved").length;
    const completed = allTasks.filter((t) => t.status === "completed").length;
    const failed = allTasks.filter((t) => t.status === "failed").length;

    const activeAgentCount = fetchDashboardRunningInstances(this.db).length;

    this.broadcast(`<div id="dashboard-metrics" class="cmd-metrics">
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-primary">${running}</span><span class="cmd-metric-label">Running</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-muted">${queued}</span><span class="cmd-metric-label">Queued</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-secondary">${activeAgentCount}</span><span class="cmd-metric-label">Active Agents</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-tertiary">${completed}</span><span class="cmd-metric-label">Completed</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value ${failed > 0 ? "cmd-metric-value-error" : "cmd-metric-value-muted"}">${failed}</span><span class="cmd-metric-label">Failed</span></div>
    </div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:metrics", null, { running, queued, completed, failed, activeAgentCount });
  }

  private pushDashboardDelegations(): void {
    const groups = this.db.prepare(
      `SELECT id, task_id, parent_instance_id, settled_count, expected_count, failed_count, status, created_at, completed_at
       FROM delegation_groups
       WHERE status = 'running'
          OR (status = 'completed' AND completed_at >= datetime('now', '-15 seconds'))
       ORDER BY COALESCE(completed_at, created_at) DESC
       LIMIT 10`,
    ).all() as NonNullable<DashboardData["activeDelegationGroups"]>;
    this.broadcast(`<span id="dashboard-delegations-count" class="cmd-progress-value">${groups.length > 0 ? "latest" : "0"}</span>`, ["dashboard"]);
    this.broadcast(`<span id="dashboard-progress-delegations-stat" class="cmd-progress-stat">${groups.length} delegations</span>`, ["dashboard"]);
    this.broadcast(`<div id="dashboard-delegations" class="cmd-progress-section-body">${dashboardDelegationGroupsFragment(groups)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:delegations", null, { delegationGroups: groups });
  }

  private pushDashboardEscalations(): void {
    const escalations = this.db.prepare(
      `SELECT id, agent_id, task_id, question, created_at
       FROM escalations WHERE status = 'open' ORDER BY created_at DESC LIMIT 5`,
    ).all() as NonNullable<DashboardData["openEscalations"]>;
    this.broadcast(`<div id="dashboard-escalations">${dashboardEscalationsFragment(escalations)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:escalations", null, { escalations });
  }

  /**
   * Push the navbar escalation count badge to every connected client so the badge
   * clears immediately on resolve regardless of which route or page issued the resolve.
   * The fragment id matches `escalation-count.fragment.ts:FRAGMENT_ID` and we inject
   * `hx-swap-oob="outerHTML"` so htmx replaces the existing span on every page.
   */
  private pushEscalationCount(): void {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM escalations WHERE status = 'open'",
    ).get() as { c: number };
    const html = escalationCountFragment(row.c).replace(
      'id="sk-nav-escalation-count"',
      'id="sk-nav-escalation-count" hx-swap-oob="outerHTML"',
    );
    this.broadcastRaw(html, []);
  }

  private pushSidebarEscalationFooter(): void {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM escalations WHERE status = 'open'",
    ).get() as { c: number };
    this.broadcast(
      `<div id="mc-sidebar-escalations" hx-swap-oob="outerHTML">${sidebarEscalationFooter(row.c)}</div>`,
      ["dashboard"],
    );
  }

  private pushDashboardInstances(): void {
    const runningInstances = fetchDashboardRunningInstances(this.db);
    this.broadcast(`<div id="running-instances" class="cmd-progress-section-body">${dashboardRunningInstancesFragment(runningInstances)}</div>`, ["dashboard"]);
    this.broadcast(dashboardActiveAgentsCountFragment(runningInstances.length, getPollIntervalSeconds(this.db)), ["dashboard"]);
    this.broadcast(`<span id="dashboard-progress-agents-stat" class="cmd-progress-stat">${runningInstances.length} agents</span>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:instances", null, { running_instances: runningInstances });
  }

  private pushDashboardSteering(): void {
    const agents = this.db.prepare(
      "SELECT id, name FROM agents ORDER BY created_at",
    ).all() as { id: string; name: string }[];
    const hasRunningTask = (this.db.prepare(
      "SELECT EXISTS(SELECT 1 FROM tasks WHERE status = 'running') AS has_running_task",
    ).get() as { has_running_task: number }).has_running_task === 1;
    const steeringOptions = agents.flatMap((agent) =>
      this.daemon.listRuntimeSteeringOptions(agent.id).map((option) => ({
        template_agent_id: agent.id,
        agent_name: agent.name,
        runtime_id: option.id,
        task_id: option.task_id,
        task_title: option.task_title,
        session_id: option.session_id,
        can_steer: option.can_steer,
        disabled_reason: option.disabled_reason,
      })),
    );
    const fragment = dashboardSteerPanelSlotFragment(steeringOptions, hasRunningTask && steeringOptions.length > 0);
    if (fragment === this.lastSteeringFragment) return;
    this.lastSteeringFragment = fragment;
    this.broadcast(fragment, ["dashboard"]);
  }

  private pushDashboardRealtimeTimeline(): void {
    const timeline = fetchDashboardRealtimeTimeline(this.db);
    this.broadcast(`<div id="dashboard-rt-timeline" class="cmd-panel-body-flush cmd-scroll-compact">${dashboardRealtimeTimelineFragment(timeline)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:realtime-timeline", null, { timeline });
  }

  private pushDashboardPhaseIndicator(): void {
    const task = fetchDashboardPhaseIndicatorTask(this.db);
    const countLabel = task
      ? (task.needs_review ? `phase ${task.current_phase + 1} \u270E` : `phase ${task.current_phase + 1}`)
      : "idle";
    this.broadcast(`<span id="dashboard-phase-indicator-count" class="cmd-progress-value">${countLabel}</span>`, ["dashboard"]);
    this.broadcast(`<span id="dashboard-progress-phase-stat" class="cmd-progress-stat">${countLabel}</span>`, ["dashboard"]);
    this.broadcast(`<div id="dashboard-phase-indicator" class="cmd-progress-phase-body">${dashboardPhaseIndicatorFragment(task)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:phase-indicator", task?.id ?? null, { task });
  }

  private pushRecentActivity(): void {
    const hasRunningTask = (this.db.prepare(
      "SELECT EXISTS(SELECT 1 FROM tasks WHERE status = 'running') AS has_running_task",
    ).get() as { has_running_task: number }).has_running_task === 1;
    if (!hasRunningTask) {
      this.broadcast(`<div id="recent-activity" class="cmd-panel-body-flush cmd-scroll-compact">${recentActivityFragment([])}</div>`, ["dashboard"]);
      return;
    }
    const recentLogs = this.db.prepare(
      `WITH ranked AS (
         SELECT to2.id,
                to2.agent_id,
                COALESCE(a.name, ta.name, ai.template_agent_id, to2.agent_id) AS agent_name,
                to2.stream,
                to2.data,
                to2.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY to2.agent_id, to2.stream, to2.data, to2.created_at
                  ORDER BY to2.id DESC
                ) AS rn
         FROM terminal_outputs to2
         LEFT JOIN agents a ON to2.agent_id = a.id
         LEFT JOIN agent_instances ai ON to2.agent_id = ai.id
         LEFT JOIN agents ta ON ta.id = ai.template_agent_id
         WHERE NOT (json_valid(to2.data) = 1 AND json_extract(to2.data, '$.type') = 'result')
       )
       SELECT agent_id, agent_name, stream, data, created_at
       FROM ranked
       WHERE rn = 1
       ORDER BY id DESC
       LIMIT ${DASHBOARD_ACTIVITY_LIMIT}`,
    ).all() as RecentLogEntry[];
    this.broadcast(`<div id="recent-activity" class="cmd-panel-body-flush cmd-scroll-compact">${recentActivityFragment(recentLogs)}</div>`, ["dashboard"]);
  }

  private pushTaskList(): void {
    const tasks = fetchTasksWithTeams(this.db);
    this.broadcast(`<div id="task-list">${taskListFragment(tasks)}</div>`, ["tasks-page"]);
    this.broadcastJson("updated", "tasks", null, { tasks });
  }

  private pushTaskDetail(taskId: string): void {
    const task = fetchTaskById(this.db, taskId);
    if (!task) return;
    // v1 fragment IDs (consumed by legacy /tasks page polling fragments)
    this.broadcast(taskDetailSummaryFragment(task), [`task:${taskId}`]);
    this.broadcast(taskPhaseStepperFragment(task), [`task:${taskId}`]);
    const delegations = fetchTaskDelegations(this.db, taskId);
    this.broadcast(taskDelegationsFragment(taskId, delegations), [`task:${taskId}`]);
    this.broadcastJson("updated", "task", taskId, { task, delegations });
  }

  private pushTaskDelegations(taskId: string): void {
    const delegations = fetchTaskDelegations(this.db, taskId);
    this.broadcast(taskDelegationsFragment(taskId, delegations), [`task:${taskId}`, "dashboard"]);
    this.broadcastJson("updated", "task:delegations", taskId, { delegations });
  }

  private pushLogEntries(): void {
    const entries = this.db.prepare(
      `SELECT t.id, t.agent_id,
              COALESCE(a.name, ta.name, ai.template_agent_id, t.agent_id) as agent_name,
              t.session_id, t.stream, t.data, t.sequence, t.created_at
       FROM terminal_outputs t
       LEFT JOIN agents a ON t.agent_id = a.id
       LEFT JOIN agent_instances ai ON t.agent_id = ai.id
       LEFT JOIN agents ta ON ta.id = ai.template_agent_id
       ORDER BY t.id DESC LIMIT 1000`,
    ).all() as LogEntryData[];
    this.broadcast(`<div id="log-entries-body">${logsTableFragment(entries)}</div>`, ["logs"]);
  }

  private pushRtNotes(taskId: string): void {
    // Tiebreaker on id so rapid-fire notes in the same second have a stable order
    const notes = this.db.prepare(
      `SELECT id, agent_id, content, created_at
       FROM task_notes WHERE task_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 50`,
    ).all(taskId) as TaskNote[];
    // Legacy realtime fragment (id="rt-notes")
    this.broadcast(`<div id="rt-notes">${notesFragment(notes)}</div>`, [`task:${taskId}`, "dashboard"]);
    // v2 notes panel (id="sk-notes")
    const v2Notes = this.db.prepare(
      `SELECT n.id, n.agent_id, COALESCE(a.name, n.agent_id) AS agent_name, n.content, n.created_at
       FROM task_notes n LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 50`,
    ).all(taskId) as Array<{ id: string; agent_id: string; agent_name: string; content: string; created_at: string }>;
    this.broadcast(notesPanel(taskId, v2Notes), [`task:${taskId}`]);
    this.broadcastJson("updated", "task:notes", taskId, { notes });
  }

  private pushRtTimeline(taskId: string): void {
    const timeline = this.db.prepare(
      "SELECT * FROM realtime_timeline WHERE task_id = ? ORDER BY created_at DESC",
    ).all(taskId) as TimelineEntry[];
    this.broadcast(`<div id="timeline-entries">${timelineEntriesFragment(timeline)}</div>`, [`task:${taskId}`]);
    this.broadcastJson("updated", "task:timeline", taskId, { timeline });
  }

  private pushRtRunningAgents(taskId: string): void {
    const agents = this.db.prepare(
      `SELECT ai.id, ai.template_agent_id, a.name AS agent_name, ai.status, ai.created_at
       FROM agent_instances ai
       JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ?
         AND (ai.status IN ('running', 'pending')
              OR (ai.status IN ('completed', 'failed')
                  AND ai.created_at > datetime('now', '-1 hour')))
       ORDER BY CASE WHEN ai.status IN ('running', 'pending') THEN 0 ELSE 1 END, ai.created_at DESC
       LIMIT 20`,
    ).all(taskId) as RunningAgentInstance[];
    this.broadcast(`<div id="rt-running-agents">${runningAgentsFragment(agents)}</div>`, [`task:${taskId}`]);
    this.broadcastJson("updated", "task:running-agents", taskId, { agents });
  }

  private pushConversationMessage(
    conversationId: string,
    messageId: string,
    role: string,
    content: string,
    parts: import("../events/bus").MessagePart[],
  ): void {
    let html: string | null = null;
    if (role === "user") {
      html = chatUserBubble(messageId, content);
    } else if (role === "assistant" && parts.length === 0) {
      // Non-streaming agent: render consolidated message as a single text bubble.
      html = chatAssistantMessage(messageId, content, parts);
    }
    // role === "assistant" with parts: each bubble was already streamed via
    // pushConversationStreamChunk; skipping HTML push avoids duplicating them on screen.

    if (html) {
      this.broadcastRaw(
        `<div id="chat-messages-${esc(conversationId)}" hx-swap-oob="beforeend">${html}</div>`,
        ["dashboard", `conversation:${conversationId}`],
      );
    }
    this.broadcastJson("created", "conversation:message", conversationId, {
      messageId,
      role,
      content,
      parts,
    });
  }

  private pushConversationStreamChunk(
    conversationId: string,
    turnId: string,
    blockIndex: number,
    part: import("../events/bus").MessagePart,
  ): void {
    const bubble = chatPartFragment(part);
    // Each part bubble is appended to the chat message stream directly. Turn id is
    // attached to the wrapper so future grouping (e.g. visually highlighting one turn)
    // can target it without re-rendering history.
    const wrapped = `<div class="chat-stream-part" data-turn-id="${esc(turnId)}" data-block-index="${blockIndex}">${bubble}</div>`;
    this.broadcastRaw(
      `<div id="chat-messages-${esc(conversationId)}" hx-swap-oob="beforeend">${wrapped}</div>`,
      ["dashboard", `conversation:${conversationId}`],
    );
    this.broadcastJson("created", "conversation:stream_chunk", conversationId, {
      turnId,
      blockIndex,
      part,
    });
  }

  /**
   * Send the current busy fragment to a single socket. Used on subscribe so
   * a freshly-(re)connected client gets the truth instead of relying on
   * whatever stale state it had before the disconnect.
   */
  private pushBusyToSocket(ws: ServerWebSocket<WSData>, conversationId: string): void {
    const cm = this.daemon.getConversationManager();
    const conv = this.db
      .prepare("SELECT template_agent_id FROM conversations WHERE id = ?")
      .get(conversationId) as { template_agent_id: string | null } | null;
    let model: string | undefined;
    if (conv?.template_agent_id) {
      const row = this.db
        .prepare("SELECT model FROM agents WHERE id = ?")
        .get(conv.template_agent_id) as { model: string } | null;
      model = row?.model ?? undefined;
    }
    const busy = cm.isBusy(conversationId);
    const id = esc(conversationId);
    const label = model ? esc(model) : "skipper";
    const inner = busy
      ? `<div class="chat-busy__bubble"><span class="chat-busy__label">${label}</span><span class="chat-typing-dots"><span></span><span></span><span></span></span></div>`
      : "";
    const html = `<div id="chat-busy-${id}" class="chat-busy" data-busy="${busy ? "1" : "0"}" hx-swap-oob="outerHTML">${inner}</div>`;
    try {
      ws.send(oob(html));
    } catch {
      this.clients.delete(ws);
    }
  }

  private pushConversationBusy(conversationId: string, busy: boolean, model?: string): void {
    const id = esc(conversationId);
    const label = model ? esc(model) : "skipper";
    const inner = busy
      ? `<div class="chat-busy__bubble"><span class="chat-busy__label">${label}</span><span class="chat-typing-dots"><span></span><span></span><span></span></span></div>`
      : "";
    this.broadcastRaw(
      `<div id="chat-busy-${id}" class="chat-busy" data-busy="${busy ? "1" : "0"}" hx-swap-oob="outerHTML">${inner}</div>`,
      ["dashboard", `conversation:${conversationId}`],
    );
  }

  private pushSidebarChats(): void {
    const conversations = this.db.prepare(
      // Unbounded — the sidebar scrolls. Archived conversations drop out via
      // status='active'. Matches the initial-render query in command-center.vm.ts.
      "SELECT id, title, status, updated_at FROM conversations WHERE status = 'active' ORDER BY updated_at DESC",
    ).all() as { id: string; title: string; status: string; updated_at: string }[];

    const items = conversations.map(conv => sidebarChatItem(conv)).join("");
    const inner = conversations.length > 0
      ? `<div class="mc-sidebar__group-label">Chats</div>${items}`
      : "";
    this.broadcast(`<div id="mc-sidebar-chats">${inner}</div>`, ["dashboard"]);
  }

  private pushArtifactList(taskId: string): void {
    const rows = this.db.prepare(
      `SELECT a.id, a.name, a.version, a.kind, a.description, a.created_at
       FROM task_artifacts a
       INNER JOIN (
         SELECT name, MAX(version) AS max_version
         FROM task_artifacts
         WHERE task_id = ?
         GROUP BY name
       ) latest ON a.name = latest.name AND a.version = latest.max_version
       WHERE a.task_id = ?
       ORDER BY a.created_at DESC LIMIT 50`,
    ).all(taskId, taskId) as { id: string; name: string; version: number; kind: string; description: string | null; created_at: string }[];

    let content: string;
    if (rows.length === 0) {
      content = `<p class="muted">No artifacts yet.</p>`;
    } else {
      const tableRows = rows.map((r) =>
        `<tr>
          <td><a href="#" hx-get="/fragments/tasks/${taskId}/artifacts/${encodeURIComponent(r.name)}" hx-target="#artifact-detail" hx-swap="innerHTML">${esc(r.name)}</a></td>
          <td>${esc(r.kind)}</td>
          <td>v${r.version}</td>
          <td>${r.created_at}</td>
        </tr>`,
      ).join("");
      content = `<table class="mini-table"><thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Created</th></tr></thead><tbody>${tableRows}</tbody></table>`;
    }
    this.broadcast(`<div id="artifact-list">${content}</div>`, [`task:${taskId}`, "dashboard"]);
    this.broadcastJson("updated", "task:artifacts", taskId, { artifacts: rows });
  }

  /**
   * Push a v2 workspace refresh trigger.
   * Sends a hidden div with hx-get that causes the mc-main area to reload.
   * This ensures the v2 workspace gets real-time updates.
   */
  private pushCommandCenterSidebar(): void {
    const vm = buildCommandCenterViewModel(this.db);
    const body = renderSidebarListBody(vm, null);
    this.broadcastRaw(
      `<div id="mc-sidebar-list" class="mc-sidebar__list" hx-swap-oob="outerHTML">${body}</div>`,
      ["dashboard"],
    );
  }

  private pushV2WorkspaceRefresh(taskId?: string): void {
    // Find the currently running task to refresh
    const runningTask = taskId || (() => {
      const row = this.db.prepare("SELECT id FROM tasks WHERE status = 'running' LIMIT 1").get() as { id: string } | null;
      return row?.id;
    })();

    if (runningTask) {
      // Push a trigger that reloads the main content area for this task —
      // scoped to clients subscribed to `task:<id>`, so a user viewing a
      // different task (e.g. editing a draft) doesn't get their main area
      // ripped out from under them by the running task's state transitions.
      this.broadcastRaw(
        `<div id="mc-main-refresh" hx-swap-oob="innerHTML" style="display:none;"><div hx-get="/workspace/task/${esc(runningTask)}" hx-trigger="load" hx-target="#mc-main" hx-swap="innerHTML"></div></div>`,
        [`task:${runningTask}`],
      );
    } else {
      // No running task — just clear the refresh trigger. Don't replace the whole page
      // as that destroys the chat panel state and other workspace UI.
      this.broadcastRaw(
        `<div id="mc-main-refresh" hx-swap-oob="innerHTML" style="display:none;"></div>`,
        ["dashboard"],
      );
    }

    // Also update the sidebar stats
    const allTasks = this.db.prepare("SELECT status FROM tasks").all() as { status: string }[];
    const running = allTasks.filter(t => t.status === "running").length;
    const completed = allTasks.filter(t => t.status === "completed").length;
    const failed = allTasks.filter(t => t.status === "failed").length;
    this.broadcastRaw(
      `<div id="mc-nav-stats-live" hx-swap-oob="innerHTML"><span><span class="mc-nav-stat-value${running > 0 ? " mc-nav-stat-value--active" : ""}">${running}</span> running</span><span>${completed} done</span>${failed > 0 ? `<span style="color:var(--sk-accent-danger)">${failed} failed</span>` : ""}</div>`,
      ["dashboard"],
    );
  }

  // ── v2 command-center targeted pushes ──────────────────────────────────

  private pushV2TaskEscalations(taskId: string): void {
    const escalations = this.db.prepare(
      `SELECT e.id, e.agent_id, e.task_id, t.title AS task_title,
              e.type, e.question, e.status, e.response, e.created_at, e.resolved_at,
              COALESCE(a.name, e.agent_id) AS agent_name
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       LEFT JOIN agents a ON a.id = e.agent_id
       WHERE e.task_id = ?
       ORDER BY CASE WHEN e.status = 'open' THEN 0 ELSE 1 END, e.created_at DESC`,
    ).all(taskId) as EscalationCardData[];

    const open = escalations.filter((e) => e.status === "open");
    const content = open.length === 0 ? "" : open.map((e) => escalationCardPanel(e)).join("");
    this.broadcast(`<div id="mc-task-escalations-${esc(taskId)}">${content}</div>`, [`dashboard`, `task:${taskId}`]);
  }

  private pushV2SteerPanel(taskId: string): void {
    const instances = this.db.prepare(
      `SELECT ai.id AS runtime_id, ai.template_agent_id,
              COALESCE(a.name, ai.template_agent_id) AS agent_name,
              ai.task_id, t.title AS task_title, ai.status, ai.process_pid,
              ai.session_id
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.status IN ('running', 'waiting_delegation')
         AND ai.task_id = ?
       ORDER BY ai.updated_at DESC`,
    ).all(taskId) as Array<{
      runtime_id: string; template_agent_id: string; agent_name: string;
      task_id: string; task_title: string | null; status: string;
      process_pid: number | null; session_id: string | null;
    }>;

    const options: SteeringOption[] = instances.map((inst) => ({
      template_agent_id: inst.template_agent_id,
      agent_name: inst.agent_name,
      runtime_id: inst.runtime_id,
      task_id: inst.task_id,
      task_title: inst.task_title,
      session_id: inst.session_id,
      process_pid: inst.process_pid,
      can_steer: inst.status === "running",
      disabled_reason: inst.status !== "running" ? "Agent is not in a steerable state" : null,
      latest_message: fetchLatestAssistantMessage(this.db, inst.runtime_id),
    }));

    const topics = [`dashboard`, `task:${taskId}`];
    const steerable = options.filter(o => o.can_steer);
    const currentIds = steerable.map(o => o.runtime_id).sort().join(",");
    const previousIds = this.lastV2SteerRuntimeIds.get(taskId) ?? "";
    this.lastV2SteerRuntimeIds.set(taskId, currentIds);

    if (currentIds === previousIds && steerable.length > 0) {
      this.broadcastRaw(steerable.map(o => oob(steerCardInfoMarkup(o))).join("\n"), topics);
    } else {
      this.broadcast(`<div id="mc-steer-${esc(taskId)}">${dashboardSteerListFragment(options)}</div>`, topics);
    }
  }

  private pushV2PhaseStrip(taskId: string): void {
    const vm = buildCommandCenterViewModel(this.db);
    const task = vm.allTasks.find((t: any) => t.id === taskId);
    if (!task) return;
    const mission = vm.missionsByTask?.get(taskId);
    const phases = mission?.phases ?? [];
    const isRunning = task.status === "running";
    const fragment = renderPhaseStripFragment(phases, taskId, isRunning);
    this.broadcastRaw(
      fragment.replace(/^(<\w+)/, '$1 hx-swap-oob="outerHTML"'),
      [`dashboard`, `task:${taskId}`],
    );
  }

  private pushV2ActivityFeed(taskId: string): void {
    const rows = this.db.prepare(
      `SELECT t.stream, t.data, COALESCE(a.name, ai.template_agent_id) AS agent_name, t.created_at
       FROM terminal_outputs t
       JOIN agent_instances ai ON ai.id = t.agent_id
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ?
       ORDER BY t.id DESC LIMIT 200`,
    ).all(taskId) as Array<{ stream: string; data: string; agent_name: string; created_at: string }>;

    const content = rows.length === 0
      ? `<div class="mc-activity__empty">No activity yet</div>`
      : parseTerminalActivity(rows);
    this.broadcastRaw(`<div id="mc-activity-feed-${esc(taskId)}" hx-swap-oob="innerHTML">${content}</div>`, [`dashboard`, `task:${taskId}`]);
  }

  private pushV2Notes(taskId: string): void {
    const notes = this.db.prepare(
      `SELECT n.*, a.name AS agent_name
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ?
       ORDER BY n.created_at DESC
       LIMIT 30`,
    ).all(taskId) as TaskNoteData[];
    this.broadcastRaw(`<div hx-swap-oob="innerHTML:#mc-notes-${esc(taskId)}">${dashboardNotesFragment(notes, taskId)}</div>`, [`dashboard`, `task:${taskId}`]);
  }

  private pushV2Artifacts(taskId: string): void {
    const rows = this.db.prepare(
      `SELECT a.id, a.name, a.version, a.kind, a.description, a.created_at
       FROM task_artifacts a
       INNER JOIN (
         SELECT name, MAX(version) AS max_version
         FROM task_artifacts
         WHERE task_id = ?
         GROUP BY name
       ) latest ON a.name = latest.name AND a.version = latest.max_version
       WHERE a.task_id = ?
       ORDER BY a.created_at DESC
       LIMIT 50`,
    ).all(taskId, taskId) as { id: string; name: string; version: number; kind: string; description: string | null; created_at: string }[];

    let content: string;
    if (rows.length === 0) {
      content = `<p class="muted">No artifacts yet.</p>`;
    } else {
      const tableRows = rows.map((r) =>
        `<tr>
          <td><a href="#" onclick="openTaskArtifactModal(); return false;" hx-get="/fragments/tasks/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(r.name)}" hx-target="#task-artifact-modal-body" hx-swap="innerHTML">${escapeHtml(r.name)}</a></td>
          <td>${escapeHtml(r.kind)}</td>
          <td>v${r.version}</td>
          <td>${formatTimestamp(r.created_at)}</td>
        </tr>`,
      ).join("");
      content = `<table class="data-table">
        <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Updated</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;
    }
    this.broadcastRaw(`<div hx-swap-oob="innerHTML:#mc-artifacts-${esc(taskId)}">${content}</div>`, [`dashboard`, `task:${taskId}`]);
  }
}

function sidebarChatItem(conv: { id: string; title: string; status: string; updated_at: string }): string {
  const dotClass = conv.status === "active" ? "mc-sidebar__item-dot--active" : "mc-sidebar__item-dot--archived";
  return `<a class="mc-sidebar__item" style="cursor:pointer;"
      hx-get="/fragments/chat/${esc(conv.id)}" hx-target="#dashboard-chat-panel" hx-swap="innerHTML"
      onclick="if(!document.getElementById('mc-workspace').classList.contains('mc-workspace--chat-open')){Skipper.chat.toggle();}">
    <span class="mc-sidebar__item-dot ${dotClass}"></span>
    <span class="mc-sidebar__item-title">${esc(conv.title)}</span>
    <span class="mc-sidebar__item-time">${formatTimestamp(conv.updated_at)}</span>
  </a>`;
}

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inject hx-swap-oob="true" into the root element of an HTML fragment. */
function oob(html: string): string {
  return html.replace(/^(<\w+\s+id="[^"]*")/, '$1 hx-swap-oob="true"');
}
