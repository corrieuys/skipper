import type { Database } from "bun:sqlite";
import type { ServerWebSocket, Server } from "bun";
import type { WSData, UiPushWSData } from "./types";
import { eventBus } from "../events/bus";
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
import { renderSidebarListBody } from "../html/pages/command-center.page";
import { buildCommandCenterViewModel } from "../html/view-models/command-center.vm";
import type {
  LogEntryData,
  DashboardData,
} from "../html/components";
import {
  timelineEntriesFragment,
  notesFragment,
  runningAgentsFragment,
} from "../html/realtime-components";
import type { TaskNote } from "../html/realtime-components";
import { notesPanel } from "../html/panels/notes.panel";
import { taskEscalationsSection, type EscalationCardData } from "../html/panels/escalation-card.panel";
import { dashboardSteerListFragment, steerCardInfoMarkup, type SteeringOption } from "../html/dashboardLatestSteerFragment";
import { buildTeamAgentTiles } from "../data/queries";
import { dashboardNotesFragment } from "../html/dashboardNotesFragment";
import { taskMessagesFragment } from "../html/fragments/task-message.fragment";
import { taskTimelineFragment } from "../html/fragments/task-timeline.fragment";
import { PRIMARY_ARTIFACT_LIST_VARIANT, artifactListFragment } from "../html/fragments/artifact-list.fragment";
import { MessageManager } from "../messages/manager";
import type { TaskNoteData } from "../html/components";
import { renderPhaseStripFragment, escalationHeaderSlot } from "../html/pages/command-center.page";
import {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchDashboardRealtimeTimeline,
  fetchDashboardPhaseIndicatorTask,
  fetchDashboardRunningInstances,
  fetchRecentActivity,
} from "../data/queries";
import { fetchRealtimeTimeline, fetchRealtimeTaskAgents } from "../data/realtime";
import { deriveDisplayStatus } from "../tasks/status";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { topicMatches } from "./fragment-registry";
import { buildDashboardActivity } from "./dashboard-activity";

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

  private readonly messageManager: MessageManager;

  constructor(
    private readonly db: Database,
    private readonly daemon: Pick<ManagerDaemon, "listRuntimeSteeringOptions">,
  ) {
    this.messageManager = new MessageManager(db);
    this.registerEventHandlers();
    this.startHeartbeat();
  }

  tryUpgrade(req: Request, server: Server<WSData>): boolean {
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
      // JSON machine clients (e.g. the terminal dashboard) get a one-shot full
      // snapshot on connect, so they render immediately instead of waiting for
      // the next event. HTML clients seed from the server-rendered page.
      const data = ws.data as UiPushWSData;
      if (data.type === "ui-push" && data.format === "json") {
        try {
          ws.send(this.buildDashboardSnapshotMessage());
        } catch {
          /* client vanished between upgrade and open */
        }
      }
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

  /** Full teardown: heartbeat, pending debounce timers, bus handlers, client set. */
  destroy(): void {
    this.stopHeartbeat();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    // Unsubscribe every bus handler registerEventHandlers attached — a destroyed
    // manager holding a closed DB must not keep reacting to task events (stale
    // handlers throwing inside emit() break the emitter's synchronous callers).
    for (const off of this.busOffs) off();
    this.busOffs = [];
    this.clients.clear();
  }

  private busOffs: Array<() => void> = [];

  /** eventBus.on with teardown tracking (see destroy). */
  private trackOn<K extends import("../events/bus").EventName>(
    event: K,
    listener: (...args: import("../events/bus").EventMap[K]) => void,
  ): void {
    eventBus.on(event, listener);
    this.busOffs.push(() => eventBus.off(event, listener));
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

  broadcastJson(event: string, resource: string, id: string | null, data: unknown, topics: string[] = []): void {
    const message = JSON.stringify({
      event,
      resource,
      id,
      data,
      timestamp: new Date().toISOString(),
    });
    for (const ws of this.clients) {
      const wsData = ws.data as UiPushWSData;
      if (wsData.format !== "json") continue;
      // Same topic semantics as the HTML broadcasts: no topics = send to all.
      if (topics.length > 0 && !topicMatches(wsData.subscriptions, topics)) continue;
      try { ws.send(message); } catch { this.clients.delete(ws); }
    }
  }

  /**
   * True when at least one socket of `format` would receive a push on
   * `topics`. The heavy debounced renders (1000-row logs table, dashboard
   * activity) used to run their queries on every agent:output tick and only
   * THEN discover nobody was listening.
   */
  private hasClients(format: "html" | "json", topics: string[]): boolean {
    for (const ws of this.clients) {
      const data = ws.data as UiPushWSData;
      if (data.format !== format) continue;
      if (topics.length > 0 && !topicMatches(data.subscriptions, topics)) continue;
      return true;
    }
    return false;
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
    this.trackOn("task:state_changed", (event) => {
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
      // V2 workspace refresh: only on real status transitions (draft/active/
      // settled changes), not on every same-status state_changed. Replacing
      // #mc-main wipes scroll position, expanded tree nodes, and re-fires every
      // nested hx-trigger="revealed", which caused a request flood when there
      // were many agents in the tree. Sub-fragments inside taskMainContent
      // already self-poll every 3-5s for live updates. Run settle refreshes
      // ride on task:run_completed / task:run_failed below.
      if (event.previousStatus !== event.newStatus && event.newStatus !== "deleted") {
        this.pushV2WorkspaceRefresh(event.taskId);
      }
    });

    // --- Run settled (task stays active; completion pushes key on these now) ---
    this.trackOn("task:run_completed", (event) => {
      this.pushDashboardTasks();
      this.pushDashboardPhaseIndicator();
      this.pushTaskList();
      this.pushTaskDetail(event.taskId);
      this.pushCommandCenterSidebar();
      this.pushV2WorkspaceRefresh(event.taskId);
    });
    this.trackOn("task:run_failed", (event) => {
      this.pushDashboardTasks();
      this.pushDashboardPhaseIndicator();
      this.pushTaskList();
      this.pushTaskDetail(event.taskId);
      this.pushCommandCenterSidebar();
      this.pushV2WorkspaceRefresh(event.taskId);
    });

    // --- Instance state changed ---
    this.trackOn("instance:state_changed", (event) => {
      this.pushDashboardInstances();
      this.pushDashboardSteering();
      if (event.taskId) this.pushRtRunningAgents(event.taskId);
      if (event.taskId) this.pushV2SteerPanel(event.taskId);
      // The timeline's transient live-agents indicator tracks instance
      // liveness; debounced because delegation fan-out bursts these events.
      if (event.taskId) {
        const taskId = event.taskId;
        this.debounced(`v2-timeline-live:${taskId}`, () => this.pushV2Timeline(taskId));
      }
    });

    // --- Agent state changed ---
    this.trackOn("agent:state_changed", () => {
      this.pushDashboardInstances();
      this.pushDashboardSteering();
    });

    // --- Agent output (debounced) ---
    this.trackOn("agent:output", (event) => {
      this.debounced("recent-activity", () => this.pushRecentActivity());
      this.debounced("log-entries", () => this.pushLogEntries());
      this.debounced("dashboard-activity", () => this.pushDashboardActivity());
      const chunk = renderTerminalOutputChunk(event.stream, event.data);
      this.broadcastRaw(
        `<div id="terminal-lines" hx-swap-oob="beforeend">${chunk}</div>`,
        ["dashboard", `agent:${event.agentId}`],
      );
      const taskRow = this.db.prepare("SELECT task_id FROM agent_instances WHERE id = ?").get(event.agentId) as { task_id: string } | null;
      if (taskRow?.task_id) {
        this.debounced(`v2-activity-${taskRow.task_id}`, () => this.pushV2ActivityPoke(taskRow!.task_id));
        this.debounced(`v2-steer-${taskRow.task_id}`, () => this.pushV2SteerPanel(taskRow!.task_id));
      }
    });

    // --- Agent exit ---
    this.trackOn("agent:exit", (event) => {
      this.pushDashboardTasks();
      this.pushDashboardInstances();
      this.pushDashboardSteering();
      this.pushDashboardPhaseIndicator();
      // Settle the V2 command-center orb roster the instant the process dies.
      // agent:exit carries no taskId, so resolve it from the instance. Without
      // this the 3D cube keeps its --active class (still tumbling) until the
      // steer fragment's next 3s poll, reading as out of sync with a stopped
      // agent.
      const taskRow = this.db.prepare("SELECT task_id FROM agent_instances WHERE id = ?").get(event.agentId) as { task_id: string | null } | null;
      if (taskRow?.task_id) this.pushV2SteerPanel(taskRow.task_id);
      // Don't push full workspace refresh on agent exit — it resets the active tab.
      // The activity feed polls for updates, and task:state_changed covers status/phase changes.
    });

    // --- Streams drained ---
    this.trackOn("agent:streams_drained", (event) => {
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
    this.trackOn("agent:signal", (event) => {
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
    this.trackOn("task:needs_review_changed", (event) => {
      this.pushDashboardPhaseIndicator();
      this.pushV2PhaseStrip(event.taskId);
      this.pushTaskDetail(event.taskId);
      this.pushV2WorkspaceRefresh(event.taskId);
    });

    // --- Delegation progress ---
    this.trackOn("delegation_group:progress", (event) => {
      this.pushTaskDelegations(event.taskId);
      this.pushDashboardDelegations();
    });

    // --- Note added ---
    this.trackOn("task:note_added", (event) => {
      this.pushRtNotes(event.taskId);
      this.pushV2Notes(event.taskId);
      // Notes are interleaved into the terminal dashboard's output feed.
      this.pushDashboardActivity();
    });

    // --- Operator message posted (experimental) ---
    this.trackOn("task:message_posted", (event) => {
      this.pushV2Messages(event.taskId);
      this.pushV2Timeline(event.taskId);
    });

    // --- Artifact created ---
    this.trackOn("artifact:created", (event) => {
      this.pushArtifactList(event.taskId);
      this.pushV2Artifacts(event.taskId);
    });

    // --- Realtime window ready ---
    this.trackOn("realtime:window_ready", (event) => {
      this.pushRtTimeline(event.taskId);
      this.pushDashboardRealtimeTimeline();
    });

    this.trackOn("realtime:timeline_updated", (event) => {
      this.pushRtTimeline(event.taskId);
      this.pushDashboardRealtimeTimeline();
      // Typed input + transcribed audio render in the v2 timeline.
      this.pushV2Timeline(event.taskId);
    });

    // --- Realtime session state ---
    this.trackOn("realtime:session_state", (event) => {
      this.pushDashboardTasks();
      this.pushDashboardPhaseIndicator();
      this.pushRtRunningAgents(event.taskId);
      this.pushRtTimeline(event.taskId);
      this.pushDashboardRealtimeTimeline();
    });

    // --- Escalation ---
    this.trackOn("escalation:created", (event) => {
      this.pushDashboardEscalations();
      this.pushCommandCenterSidebar();
      if (event.taskId) this.pushV2TaskEscalations(event.taskId);
      if (event.taskId) this.pushV2TaskHeaderEscalation(event.taskId);
      if (event.taskId) this.pushV2Timeline(event.taskId);
    });
    this.trackOn("escalation:resolved", (event) => {
      this.pushDashboardEscalations();
      this.pushCommandCenterSidebar();
      // Resolve may have respawned the parent agent (sendResumeMessage / spawnAgentInstance
      // fallbacks in EscalationManager.injectResponse) — refresh running instances so the
      // dashboard count reflects the latest state and the user isn't misled into a second resolve.
      this.pushDashboardInstances();
      if (event.taskId) this.pushV2TaskEscalations(event.taskId);
      if (event.taskId) this.pushV2TaskHeaderEscalation(event.taskId);
      if (event.taskId) this.pushV2Timeline(event.taskId);
    });
  }

  // --- Fragment renderers (with topic annotations) ---

  /**
   * Dashboard task rows: active tasks plus cleanly settled ones (settled with
   * an error result are the old "failed" set and stay out, matching the old
   * running/approved/completed filter). Each row carries the new mode/paused/
   * display_status fields plus the deprecated task_type compat mirror.
   */
  private fetchDashboardTaskRows(): {
    id: string; title: string; status: string; task_type?: string; mode?: string;
    paused?: boolean; display_status?: string; created_at?: string;
  }[] {
    const rows = this.db.prepare(
      `SELECT id, title, status, mode, paused, needs_review, wake_requested_at, started_at, result, created_at
       FROM tasks
       WHERE status = 'active'
          OR (status = 'settled' AND (result IS NULL OR json_valid(result) = 0 OR json_extract(result, '$.error') IS NULL))
       ORDER BY created_at DESC`,
    ).all() as { id: string; title: string; status: string; mode: string; paused: number; needs_review: number; wake_requested_at: string | null; started_at: string | null; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      task_type: r.mode === "conversational" ? "real_time" : "standard",
      mode: r.mode,
      paused: !!r.paused,
      display_status: deriveDisplayStatus(this.db, r),
      created_at: r.created_at,
    }));
  }

  private pushDashboardTasks(): void {
    const dashboardTasks = this.fetchDashboardTaskRows();
    const focusTasks = selectDashboardFocusTasks(dashboardTasks);
    this.broadcast(`<div id="active-tasks" class="cmd-layout-focus">${dashboardActiveTaskFragment(focusTasks)}</div>`, ["dashboard"]);
    const queueTasks = dashboardTasks.filter((task) => task.display_status === "queued");
    this.broadcast(`<div id="dashboard-queue" class="cmd-panel-body-flush cmd-scroll-compact">${dashboardQueueFragment(queueTasks)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:tasks", null, { tasks: focusTasks }, ["dashboard"]);
    this.pushDashboardMetrics();
  }

  private triggerDashboardRerender(): void {
    this.broadcast(`<div id="dashboard-rerender-trigger" style="display:none;" hx-get="/" hx-trigger="load" hx-target="body" hx-swap="outerHTML"></div>`, ["dashboard"]);
  }

  private pushDashboardMetrics(): void {
    const { running, queued, completed, failed, activeAgentCount } = this.dashboardCounts();

    this.broadcast(`<div id="dashboard-metrics" class="cmd-metrics">
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-primary">${running}</span><span class="cmd-metric-label">Running</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-muted">${queued}</span><span class="cmd-metric-label">Queued</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-secondary">${activeAgentCount}</span><span class="cmd-metric-label">Active Agents</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value cmd-metric-value-tertiary">${completed}</span><span class="cmd-metric-label">Completed</span></div>
      <div class="cmd-metric"><span class="cmd-metric-value ${failed > 0 ? "cmd-metric-value-error" : "cmd-metric-value-muted"}">${failed}</span><span class="cmd-metric-label">Failed</span></div>
    </div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:metrics", null, { running, queued, completed, failed, activeAgentCount }, ["dashboard"]);
  }

  /**
   * One-shot dashboard snapshot for a freshly-connected JSON client. Same
   * resource shapes the live `dashboard:*` JSON pushes use, bundled under a
   * single `dashboard:snapshot` frame so the client hydrates in one message.
   */
  private buildDashboardSnapshotMessage(): string {
    const dashboardTasks = this.fetchDashboardTaskRows();
    const focusTasks = selectDashboardFocusTasks(dashboardTasks);
    const runningInstances = fetchDashboardRunningInstances(this.db);
    return JSON.stringify({
      event: "snapshot",
      resource: "dashboard:snapshot",
      id: null,
      data: {
        tasks: focusTasks,
        running_instances: runningInstances,
        metrics: this.dashboardCounts(),
        phase_indicator: fetchDashboardPhaseIndicatorTask(this.db),
        activity: buildDashboardActivity(this.db, DASHBOARD_ACTIVITY_LIMIT),
      },
      timestamp: new Date().toISOString(),
    });
  }

  private pushDashboardActivity(): void {
    if (!this.hasClients("json", ["dashboard"])) return;
    this.broadcastJson("updated", "dashboard:activity", null, { activity: buildDashboardActivity(this.db, DASHBOARD_ACTIVITY_LIMIT) }, ["dashboard"]);
  }

  /**
   * Task/agent counts shown in the dashboard header (matches pushDashboardMetrics).
   * Unified-model mapping: running = active + started, queued = active not yet
   * started, completed/failed = settled without/with an error result.
   */
  private dashboardCounts(): { running: number; queued: number; completed: number; failed: number; activeAgentCount: number } {
    const allTasks = this.db.prepare("SELECT status, started_at, result FROM tasks").all() as { status: string; started_at: string | null; result: string | null }[];
    const hasError = (result: string | null): boolean => {
      if (!result) return false;
      try {
        const parsed = JSON.parse(result);
        return !!(parsed && typeof parsed === "object" && "error" in parsed && (parsed as { error?: unknown }).error != null);
      } catch {
        return false;
      }
    };
    return {
      running: allTasks.filter((t) => t.status === "active" && t.started_at != null).length,
      queued: allTasks.filter((t) => t.status === "active" && t.started_at == null).length,
      completed: allTasks.filter((t) => t.status === "settled" && !hasError(t.result)).length,
      failed: allTasks.filter((t) => t.status === "settled" && hasError(t.result)).length,
      activeAgentCount: fetchDashboardRunningInstances(this.db).length,
    };
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
    this.broadcastJson("updated", "dashboard:delegations", null, { delegationGroups: groups }, ["dashboard"]);
  }

  private pushDashboardEscalations(): void {
    const escalations = this.db.prepare(
      `SELECT id, agent_id, task_id, question, created_at
       FROM escalations WHERE status = 'open' ORDER BY created_at DESC LIMIT 5`,
    ).all() as NonNullable<DashboardData["openEscalations"]>;
    this.broadcast(`<div id="dashboard-escalations">${dashboardEscalationsFragment(escalations)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:escalations", null, { escalations }, ["dashboard"]);
  }

  private pushDashboardInstances(): void {
    const runningInstances = fetchDashboardRunningInstances(this.db);
    this.broadcast(`<div id="running-instances" class="cmd-progress-section-body">${dashboardRunningInstancesFragment(runningInstances)}</div>`, ["dashboard"]);
    this.broadcast(dashboardActiveAgentsCountFragment(runningInstances.length), ["dashboard"]);
    this.broadcast(`<span id="dashboard-progress-agents-stat" class="cmd-progress-stat">${runningInstances.length} agents</span>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:instances", null, { running_instances: runningInstances }, ["dashboard"]);
  }

  private pushDashboardSteering(): void {
    const agents = this.db.prepare(
      "SELECT id, name FROM agents ORDER BY created_at",
    ).all() as { id: string; name: string }[];
    const hasRunningTask = (this.db.prepare(
      "SELECT EXISTS(SELECT 1 FROM tasks WHERE status = 'active') AS has_running_task",
    ).get() as { has_running_task: number }).has_running_task === 1;
    const steeringOptions = agents.flatMap((agent) =>
      this.daemon.listRuntimeSteeringOptions(agent.id).map((option) => ({
        template_agent_id: agent.id,
        agent_name: agent.name,
        runtime_id: option.id,
        task_id: option.task_id,
        task_title: option.task_title,
        session_id: option.session_id,
        process_pid: option.process_pid,
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
    this.broadcast(`<div id="dashboard-rt-timeline" class="cmd-panel-body-flush cmd-scroll-compact">${dashboardRealtimeTimelineFragment(timeline ?? null)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:realtime-timeline", null, { timeline }, ["dashboard"]);
  }

  private pushDashboardPhaseIndicator(): void {
    const task = fetchDashboardPhaseIndicatorTask(this.db);
    const countLabel = task
      ? (task.needs_review ? `phase ${task.current_phase + 1} \u270E` : `phase ${task.current_phase + 1}`)
      : "idle";
    this.broadcast(`<span id="dashboard-phase-indicator-count" class="cmd-progress-value">${countLabel}</span>`, ["dashboard"]);
    this.broadcast(`<span id="dashboard-progress-phase-stat" class="cmd-progress-stat">${countLabel}</span>`, ["dashboard"]);
    this.broadcast(`<div id="dashboard-phase-indicator" class="cmd-progress-phase-body">${dashboardPhaseIndicatorFragment(task ?? null)}</div>`, ["dashboard"]);
    this.broadcastJson("updated", "dashboard:phase-indicator", task?.id ?? null, { task }, ["dashboard"]);
  }

  private pushRecentActivity(): void {
    if (!this.hasClients("html", ["dashboard"])) return;
    const hasRunningTask = (this.db.prepare(
      "SELECT EXISTS(SELECT 1 FROM tasks WHERE status = 'active') AS has_running_task",
    ).get() as { has_running_task: number }).has_running_task === 1;
    if (!hasRunningTask) {
      this.broadcast(`<div id="recent-activity" class="cmd-panel-body-flush cmd-scroll-compact">${recentActivityFragment([])}</div>`, ["dashboard"]);
      return;
    }
    const recentLogs = fetchRecentActivity(this.db, DASHBOARD_ACTIVITY_LIMIT);
    this.broadcast(`<div id="recent-activity" class="cmd-panel-body-flush cmd-scroll-compact">${recentActivityFragment(recentLogs)}</div>`, ["dashboard"]);
  }

  private pushTaskList(): void {
    const tasks = fetchTasksWithTeams(this.db);
    this.broadcast(`<div id="task-list">${taskListFragment(tasks)}</div>`, ["tasks-page"]);
    this.broadcastJson("updated", "tasks", null, { tasks }, ["tasks-page", "dashboard"]);
  }

  private pushTaskDetail(taskId: string): void {
    const task = fetchTaskById(this.db, taskId);
    if (!task) return;
    // v1 fragment IDs (consumed by legacy /tasks page polling fragments)
    this.broadcast(taskDetailSummaryFragment(task), [`task:${taskId}`]);
    this.broadcast(taskPhaseStepperFragment(task), [`task:${taskId}`]);
    const delegations = fetchTaskDelegations(this.db, taskId);
    this.broadcast(taskDelegationsFragment(taskId, delegations), [`task:${taskId}`]);
    this.broadcastJson("updated", "task", taskId, { task, delegations }, [`task:${taskId}`, "dashboard"]);
  }

  private pushTaskDelegations(taskId: string): void {
    const delegations = fetchTaskDelegations(this.db, taskId);
    this.broadcast(taskDelegationsFragment(taskId, delegations), [`task:${taskId}`, "dashboard"]);
    this.broadcastJson("updated", "task:delegations", taskId, { delegations }, [`task:${taskId}`, "dashboard"]);
  }

  private pushLogEntries(): void {
    if (!this.hasClients("html", ["logs"])) return;
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
    this.broadcastJson("updated", "task:notes", taskId, { notes }, [`task:${taskId}`, "dashboard"]);
  }

  private pushRtTimeline(taskId: string): void {
    const timeline = fetchRealtimeTimeline(this.db, taskId);
    this.broadcast(`<div id="timeline-entries">${timelineEntriesFragment(timeline)}</div>`, [`task:${taskId}`]);
    this.broadcastJson("updated", "task:timeline", taskId, { timeline }, [`task:${taskId}`]);
  }

  private pushRtRunningAgents(taskId: string): void {
    const agents = fetchRealtimeTaskAgents(this.db, taskId);
    this.broadcast(`<div id="rt-running-agents">${runningAgentsFragment(agents)}</div>`, [`task:${taskId}`]);
    this.broadcastJson("updated", "task:running-agents", taskId, { agents }, [`task:${taskId}`]);
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
          <td><a href="#" onclick="skOpenArtifactPanel(); return false;" hx-get="/fragments/tasks/${taskId}/artifacts/${encodeURIComponent(r.name)}" hx-target="#sk-artifact-detail" hx-swap="innerHTML">${esc(r.name)}</a></td>
          <td>${esc(r.kind)}</td>
          <td>v${r.version}</td>
          <td>${r.created_at}</td>
        </tr>`,
      ).join("");
      content = `<table class="mini-table"><thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Created</th></tr></thead><tbody>${tableRows}</tbody></table>`;
    }
    this.broadcast(`<div id="artifact-list">${content}</div>`, [`task:${taskId}`, "dashboard"]);
    this.broadcastJson("updated", "task:artifacts", taskId, { artifacts: rows }, [`task:${taskId}`, "dashboard"]);
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
    // Find the currently active task to refresh
    const runningTask = taskId || (() => {
      const row = this.db.prepare("SELECT id FROM tasks WHERE status = 'active' AND started_at IS NOT NULL LIMIT 1").get() as { id: string } | null;
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
    const { running, completed, failed } = this.dashboardCounts();
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

    const content = taskEscalationsSection(escalations);
    this.broadcast(`<div id="mc-task-escalations-${esc(taskId)}">${content}</div>`, [`dashboard`, `task:${taskId}`]);
  }

  // OOB-swap the task-header escalation label so it appears/clears live when an
  // escalation is raised or resolved while the task is open (the header itself
  // is not otherwise re-pushed on escalation events).
  private pushV2TaskHeaderEscalation(taskId: string): void {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM escalations WHERE task_id = ? AND status = 'open'")
      .get(taskId) as { n: number } | null;
    this.broadcast(escalationHeaderSlot(taskId, row?.n ?? 0), [`dashboard`, `task:${taskId}`]);
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
    // Change-detection key spans the full active roster (running AND
    // waiting_delegation) plus each status — not just the steerable subset.
    // The cube tiles reflect every active agent, so a parent flipping
    // running<->waiting_delegation, or exiting while its children keep running,
    // must force a full tile rebuild. Keying only off the running set let the
    // fast path (which just refreshes steer-card text) run in that case,
    // leaving a stale "active" cube lit until the next manual refresh.
    const rosterKey = instances.map(i => `${i.runtime_id}:${i.status}`).sort().join(",");
    const previousKey = this.lastV2SteerRuntimeIds.get(taskId) ?? "";
    this.lastV2SteerRuntimeIds.set(taskId, rosterKey);

    if (rosterKey === previousKey && steerable.length > 0) {
      this.broadcastRaw(steerable.map(o => oob(steerCardInfoMarkup(o))).join("\n"), topics);
    } else {
      const tiles = buildTeamAgentTiles(this.db, taskId);
      this.broadcast(`<div id="mc-steer-${esc(taskId)}">${dashboardSteerListFragment(tiles, taskId)}</div>`, topics);
    }
  }

  private pushV2PhaseStrip(taskId: string): void {
    const vm = buildCommandCenterViewModel(this.db);
    const task = vm.allTasks.find((t: any) => t.id === taskId);
    if (!task) return;
    const mission = vm.missionsByTask?.[taskId];
    const phases = mission?.phases ?? [];
    const isRunning = task.status === "active" || task.status === "running";
    const fragment = renderPhaseStripFragment(phases, taskId, isRunning);
    this.broadcastRaw(
      fragment.replace(/^(<\w+)/, '$1 hx-swap-oob="outerHTML"'),
      [`dashboard`, `task:${taskId}`],
    );
  }

  /** v2: re-render the timeline (message/escalation events + instance liveness for the transient indicator). */
  private pushV2Timeline(taskId: string): void {
    const content = taskTimelineFragment(this.db, taskId);
    this.broadcastRaw(
      `<div hx-swap-oob="innerHTML:#mc-timeline-inner-${esc(taskId)}">${content}</div>`,
      [`dashboard`, `task:${taskId}`],
    );
  }

  /**
   * v2: an agent wrote output. Instead of re-rendering the whole activity feed
   * for every client (which meant re-reading up to 800 frame bodies and
   * shipping the rendered page to EVERY dashboard socket per tick — 20 MB a
   * pop on a task with big tool results), push a tiny poke element. Only the
   * client that has this task's feed on screen owns the matching id; its
   * skipper.js handler fetches `/activity?after=<its newest row id>` and
   * prepends just the new rows.
   */
  private pushV2ActivityPoke(taskId: string): void {
    const eid = esc(taskId);
    this.broadcastRaw(
      `<div id="mc-activity-poke-${eid}" data-sk-activity-poke="${eid}" hidden hx-swap-oob="true"></div>`,
      [`dashboard`, `task:${taskId}`],
    );
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

  private pushV2Messages(taskId: string): void {
    const messages = this.messageManager.listMessages(taskId);
    this.broadcastRaw(
      `<div hx-swap-oob="innerHTML:#mc-messages-${esc(taskId)}">${taskMessagesFragment(messages)}</div>`,
      [`dashboard`, `task:${taskId}`],
    );
  }

  private pushV2Artifacts(taskId: string): void {
    const content = artifactListFragment(this.db, taskId, PRIMARY_ARTIFACT_LIST_VARIANT);
    this.broadcastRaw(`<div hx-swap-oob="innerHTML:#mc-artifacts-${esc(taskId)}">${content}</div>`, [`dashboard`, `task:${taskId}`]);
  }
}

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inject hx-swap-oob="true" into the root element of an HTML fragment. */
function oob(html: string): string {
  return html.replace(/^(<\w+\s+id="[^"]*")/, '$1 hx-swap-oob="true"');
}
