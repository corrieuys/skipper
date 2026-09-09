import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { escapeHtml } from "../html/atoms/escape-html";
import { looksLikeHtml } from "../html/atoms/sniff-html";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { getConnectPublicBase, getPublicArtifactUrl, getWebhookTriggerUrl } from "../connect/public-links";
import { listAssignableTeams } from "../config/teams";
import { isTeamVisible, isExperimental } from "../config/feature-flags";
import type { TaskMemoryPanelData } from "../html/fragments/task-memory-config.fragment";

// Set by index.ts once the task-memory managers exist; the /config page reads
// the embeddings settings + local server status through it.
let taskMemoryPanelProvider: (() => TaskMemoryPanelData) | null = null;
export function setTaskMemoryPanelProvider(provider: () => TaskMemoryPanelData): void {
  taskMemoryPanelProvider = provider;
}
import { taskTimelineFragment } from "../html/fragments/task-timeline.fragment";
// Activity feed paging: rows per page, and the cap on one live "after" pull.
const ACTIVITY_PAGE_SIZE = 100;
const ACTIVITY_LIVE_LIMIT = 500;
import { artifactListFragment, fileArtifactIcon } from "../html/fragments/artifact-list.fragment";
import { formatBytes } from "../orchestrator/artifact-files";
import { scopeSummary, taskMemorySummary } from "../task-memory/summary";
import { readSeriesMemoryConfig, seriesScopeId } from "../task-memory/scope";
import { listPreferences, setPreference } from "../notifications/store";
import { NOTIFICATION_EVENTS, type NotificationEventKey } from "../notifications/types";
import { listKeys } from "./api-keys";
import {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchTaskForensics,
  fetchDashboardRealtimeTimeline,
  fetchDashboardPhaseIndicatorTask,
  buildTeamAgentTiles,
  getOpenEscalationCount,
  getPollIntervalSeconds,
  isDaemonPaused,
  fetchDashboardRunningInstances,
  fetchRecentActivity,
  fetchDashboardMetrics,
  fetchTaskOutputPage,
  fetchTaskOutputRow,
} from "../data/queries";
import {
  taskListPollingFragment,
  taskDetailSummaryFragment,
  taskPhaseStepperFragment,
  taskDelegationsFragment,
  taskForensicsFragment,
  terminalOutputFragment,
  logsTableFragment,
} from "../html/components";
import { formatTimestamp } from "../html/formatTimestamp";
import { metricsFragment } from "../html/metricsFragment";
import { escalationCardPanel, taskEscalationsSection, type EscalationCardData } from "../html/panels/escalation-card.panel";
import { logsPage } from "../html/pages/logs.page";
import { dashboardNotesFragment } from "../html/dashboardNotesFragment";
import { taskMessagesFragment } from "../html/fragments/task-message.fragment";
import { MessageManager } from "../messages/manager";
import { dashboardRealtimeTimelineFragment } from "../html/dashboardRealtimeTimelineFragment";
import { dashboardPhaseIndicatorFragment } from "../html/dashboardPhaseIndicatorFragment";
import { dashboardActiveAgentsCountFragment } from "../html/dashboardActiveAgentsCountFragment";
import { dashboardRunningInstancesFragment } from "../html/dashboardRunningInstancesFragment";
import { selectDashboardFocusTasks } from "../html/selectDashboardFocusTasks";
import { diagnosticCard } from "../html/diagnosticCard";
import { dashboardActiveTaskFragment } from "../html/dashboardActiveTaskFragment";
import { asteroidsPage } from "../html/pages/asteroids.page";
import { dashboardSteerListFragment, agentInstancesModalFragment, oneshotResumeCardMarkup, type SteeringOption } from "../html/dashboardLatestSteerFragment";
import {
  getNumberSetting, setNumberSetting, SETTING_LOG_RETENTION_HOURS,
  SETTING_TASK_RETENTION_DAYS, SETTING_RECURRING_TASK_RETENTION_DAYS,
  getStringSetting, setStringSetting, getSetting,
  getBoolSetting, SETTING_PARALLEL_TASKS,
  SETTING_SKIPPER_CONNECT_KEY, SETTING_SKIPPER_CONNECT_URL,
} from "../config/app-settings";
import { APP_VERSION, SERVER_ID } from "../version";
import {
  isAutoUpdateEnabled, setAutoUpdateEnabled, getUpdateNoticeView,
  dismissAvailableNotice, clearAppliedNotice, SETTING_UPDATE_AVAILABLE_VERSION,
} from "../config/auto-update-settings";
import { renderUpdateNotice } from "../html/fragments/update-toast";
import { recentActivityFragment } from "../html/recentActivityFragment";
import type {
  TaskNoteData,
  AuditEventData,
  AuditEventFilters,
  LogEntryData,
  LogFilters,
} from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { htmlResponse as html, parseRequestBody } from "./utils";
import { fetchLatestAssistantMessage } from "../ws/ui-push";
import { deriveDisplayStatus, displayStatusLabel, type TaskDisplayStatus } from "../tasks/status";
import { taskResultHasError, displayBadgeClass } from "../html/fragments/status-chip.fragment";

const LOGS_PAGE_LIMIT = 1000;
const DASHBOARD_ACTIVITY_LIMIT = 250;

function hasLiveTaskInstances(db: ReturnType<typeof getDb>, taskId: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending') LIMIT 1",
  ).get(taskId);
}

function getAgentRuntimeIds(db: ReturnType<typeof getDb>, templateAgentId: string): string[] {
  const runtimeRows = db.prepare(
    `SELECT id FROM agent_instances
     WHERE template_agent_id = ?
     ORDER BY created_at DESC`,
  ).all(templateAgentId) as { id: string }[];
  const runtimeIds = runtimeRows.map((r) => r.id);
  return [templateAgentId, ...runtimeIds];
}

export function registerPageRoutes(daemon: ManagerDaemon): void {
  const db = getDb();


  // Recent logs fragment (for SSE-triggered HTMX refresh fallback)
  addRoute("GET", "/api/logs/recent", () => {
    const recentLogs = fetchRecentActivity(db, DASHBOARD_ACTIVITY_LIMIT);
    return html(recentActivityFragment(recentLogs));
  });


  addRoute("GET", "/fragments/tasks/list", () => {
    const tasks = fetchTasksWithTeams(db);
    return html(taskListPollingFragment(tasks, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/tasks/:id/summary", (_req, params) => {
    const task = fetchTaskById(db, params.id);
    return html(taskDetailSummaryFragment(task, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/tasks/:id/phases", (_req, params) => {
    const task = fetchTaskById(db, params.id);
    return html(taskPhaseStepperFragment(task, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/tasks/:id/delegations", (_req, params) => {
    const task = fetchTaskById(db, params.id);
    const delegations = task ? fetchTaskDelegations(db, params.id) : [];
    if (!task) {
      return html(taskDelegationsFragment(params.id, delegations, 8, false));
    }
    return html(taskDelegationsFragment(params.id, delegations, getPollIntervalSeconds(db)));
  });

  // Delegation detail — modal body for the agent-tree delegation pill
  // (data-sk-delegation-open → #sk-delegation-modal-body, wired in skipper.js).
  // Shows the full prompt that was sent to the child plus the returned result.
  addRoute("GET", "/fragments/delegations/:id", (_req, params) => {
    const d = db.prepare(
      `SELECT d.id, d.status, d.prompt, d.result, d.created_at, d.completed_at,
              COALESCE(pa.name, d.parent_agent_id) AS parent_agent_name,
              COALESCE(ca.name, d.child_agent_id) AS child_agent_name
       FROM delegations d
       LEFT JOIN agents pa ON pa.id = d.parent_agent_id
       LEFT JOIN agents ca ON ca.id = d.child_agent_id
       WHERE d.id = ?`,
    ).get(params.id) as {
      id: string; status: string; prompt: string; result: string | null;
      created_at: string; completed_at: string | null;
      parent_agent_name: string; child_agent_name: string;
    } | null;

    if (!d) return html(`<p class="sk-muted">Delegation not found.</p>`);

    const meta = [
      `<span class="sk-badge sk-badge--${escapeHtml(d.status)}">${escapeHtml(d.status)}</span>`,
      `<span class="sk-text-sm">${escapeHtml(d.parent_agent_name)} &rarr; ${escapeHtml(d.child_agent_name)}</span>`,
      `<span class="sk-text-xs sk-muted">${formatTimestamp(d.created_at)}${d.completed_at ? ` &middot; done ${formatTimestamp(d.completed_at)}` : ""}</span>`,
    ].join(" ");

    return html(`<div class="sk-flex sk-items-center sk-gap-2 sk-mb-4" style="flex-wrap:wrap;">${meta}</div>
      <h4 class="sk-text-sm sk-mb-2">Prompt sent</h4>
      <pre style="white-space:pre-wrap;word-break:break-word;background:var(--sk-surface-0);padding:var(--sk-space-3);border-radius:var(--sk-radius-sm);margin:0;">${escapeHtml(d.prompt)}</pre>
      ${d.result ? `<h4 class="sk-text-sm sk-mb-2" style="margin-top:var(--sk-space-4);">Result returned</h4>
      <pre style="white-space:pre-wrap;word-break:break-word;background:var(--sk-surface-0);padding:var(--sk-space-3);border-radius:var(--sk-radius-sm);margin:0;">${escapeHtml(d.result)}</pre>` : ""}`);
  });

  addRoute("GET", "/fragments/tasks/:id/notes", (_req, params) => {
    const notes = db.prepare(
      `SELECT n.*, a.name AS agent_name
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ?
       ORDER BY n.created_at DESC
       LIMIT 30`,
    ).all(params.id) as TaskNoteData[];
    return html(dashboardNotesFragment(notes, params.id));
  });

  // Operator messages column (experimental) — 404s with the feature off, so the
  // panel never renders a body the daemon will not serve.
  const messageManager = new MessageManager(db);
  addRoute("GET", "/fragments/tasks/:id/messages", (_req, params) => {
    if (!isExperimental()) return new Response("Not found", { status: 404 });
    return html(taskMessagesFragment(messageManager.listMessages(params.id)));
  });

  // Artifact list fragment — shows only the latest version of each artifact name
  const artifactManager = new ArtifactManager(db);
  for (const variant of ARTIFACT_MODAL_VARIANTS) {
    addRoute("GET", `${variant.routePrefix}/:id/artifacts`, (_req, params) =>
      html(artifactListFragment(db, params.id, variant)));

    addRoute("GET", `${variant.routePrefix}/:id/artifacts/:name`, (req, params) =>
      html(renderArtifactDetailFragment(db, params.id, params.name, new URL(req.url).searchParams.get("version") ?? "latest", variant)));

    // Soft-delete / restore an artifact by NAME (all versions at once). Deleted
    // artifacts stay listed (annotated) but are excluded from agent context
    // injection (artifact-manager.listArtifacts filters deleted_at). Re-renders
    // the list in place.
    for (const deleteAction of ["delete", "restore"] as const) {
      addRoute("POST", `${variant.routePrefix}/:id/artifacts/:name/${deleteAction}`, (_req, params) => {
        const taskId = params.id ?? "";
        const artifactName = params.name ?? "";
        const deletedAt = deleteAction === "delete" ? "strftime('%Y-%m-%d %H:%M:%f','now')" : "NULL";
        db.prepare(`UPDATE task_artifacts SET deleted_at = ${deletedAt} WHERE task_id = ? AND name = ?`)
          .run(taskId, artifactName);
        return html(artifactListFragment(db, taskId, variant));
      });
    }

    for (const publishAction of ["publish", "unpublish"] as const) {
      addRoute("POST", `${variant.routePrefix}/:id/artifacts/:name/${publishAction}`, (req, params) => {
        const taskId = params.id ?? "";
        const artifactName = params.name ?? "";
        const versionParam = new URL(req.url).searchParams.get("version") ?? "latest";
        const version = versionParam === "latest" ? "latest" : Number(versionParam);
        const artifact = artifactManager.getArtifact(taskId, artifactName, version as "latest" | number);
        // Publishing is experimental-only; ignore the action when the flag is off
        // (the UI is hidden, this guards direct POSTs).
        if (artifact && isExperimental()) {
          if (publishAction === "publish") artifactManager.publishArtifact(artifact.id);
          else artifactManager.unpublishArtifact(artifact.id);
        }
        // Swap the modal detail (primary target) AND re-render the artifacts list
        // out-of-band, so its "published" badge stays in sync without a reload.
        const detail = renderArtifactDetailFragment(db, taskId, artifactName, versionParam, variant);
        const listHtml = artifactListFragment(db, taskId, variant);
        const listOob = `<div id="${escapeHtml(variant.listId(taskId))}" hx-swap-oob="innerHTML">${listHtml}</div>`;
        return html(detail + listOob);
      });
    }
  }

  addRoute("GET", "/fragments/tasks/:id/forensics", (_req, params) => {
    const forensics = fetchTaskForensics(db, params.id);
    return html(taskForensicsFragment(params.id, forensics, getPollIntervalSeconds(db)));
  });


  // Legacy redirects → unified config page
  addRoute("GET", "/skipper", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  addRoute("GET", "/agents", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // Agent detail → runtime terminal output (agent definition management removed)
  addRoute("GET", "/agents/:id", (_req, params) => {
    return new Response(null, { status: 302, headers: { Location: `/agents/${params.id}/output` } });
  });

  addRoute("GET", "/agents/:id/output", (req, params) => {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session");
    const runtimeIds = getAgentRuntimeIds(db, params.id);
    const runtimePlaceholders = runtimeIds.map(() => "?").join(",");

    let rows: { stream: string; data: string; sequence: number }[];
    if (sessionId) {
      const sessionOwner = db.prepare(
        "SELECT agent_id FROM agent_sessions WHERE id = ?",
      ).get(sessionId) as { agent_id: string } | null;
      if (!sessionOwner || !runtimeIds.includes(sessionOwner.agent_id)) {
        return html(terminalOutputFragment([]));
      }
      rows = db.prepare(
        "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
      ).all(sessionOwner.agent_id, sessionId) as { stream: string; data: string; sequence: number }[];
    } else {
      const latestSession = db.prepare(
        `SELECT id, agent_id
         FROM agent_sessions
         WHERE agent_id IN (${runtimePlaceholders})
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(...runtimeIds) as { id: string; agent_id: string } | null;

      if (latestSession) {
        rows = db.prepare(
          "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
        ).all(latestSession.agent_id, latestSession.id) as { stream: string; data: string; sequence: number }[];
      } else {
        // Fallback for outputs without session_id (pre-migration data)
        rows = db.prepare(
          `SELECT stream, data, sequence
           FROM terminal_outputs
           WHERE agent_id IN (${runtimePlaceholders})
           ORDER BY id DESC
           LIMIT 400`,
        ).all(...runtimeIds) as { stream: string; data: string; sequence: number }[];
        rows = rows.reverse();
      }
    }
    return html(terminalOutputFragment(rows));
  });

  // Teams — the primary team interface: an index grid at /teams and an
  // interactive team map (phase flow + crew line) at /teams/:id. Config no
  // longer carries a team panel.
  {
    const { teamsPage } = require("../html/pages/teams.page");
    const { teamMapPage } = require("../html/pages/team-map.page");
    const { listLocalTeams, getLocalTeam } = require("../teams/local-teams");
    const { listAgentTypes } = require("../config/store");
    const { isAllowedProvider } = require("../config/model-settings");
    const { listCustomAgents, customAgentTypeName } = require("../custom-agents/store");

    const teamPageMeta = () => {
      return {
        escalationCount: getOpenEscalationCount(db),
        daemonState: isDaemonPaused(db) ? "paused" : "running",
        daemonUptime: process.uptime(),
      };
    };

    // Providers a NEW inline team agent may be set to: the allowlisted CLIs only.
    // Saved agents (custom + headless CLI) are no longer providers here - they are
    // added as live references via "From library" (teamAgentLibrary), so a custom
    // agent's model/prompt/tools never show up as noise on a provider dropdown.
    //
    // `isAllowedProvider` is deliberately not widened - it also gates the config
    // page's Skipper/Greg/Dictation model pickers.
    const teamAgentTypeChoices = () =>
      (listAgentTypes() as Array<{ name: string }>)
        .filter((t) => isAllowedProvider(t.name))
        .map((t) => ({ name: t.name }));

    // Providers selectable for a real-time team's transcription-summary model
    // (the model-settings allowlist - claude-code, plus experimental providers).
    const teamModelProviders = () => (listAgentTypes() as Array<{ name: string }>)
      .filter((t) => isAllowedProvider(t.name))
      .map((t) => t.name);

    // Agent library for the crew's "add from library" control. Both kinds are
    // offered and each pick adds a LIVE REFERENCE member (type = the ref token),
    // not a copy: a headless CLI agent as `single:<id>`, a custom agent as
    // `custom:<id>`. Experimental only.
    const teamAgentLibrary = () => {
      if (!isExperimental()) return [];
      const { listSingleAgents, singleAgentRefType } = require("../single-agents/store");
      const single = (listSingleAgents(db) as Array<{ id: string; name: string; agent_type: string; model: string }>)
        .map((a) => ({ id: a.id, name: a.name, refType: singleAgentRefType(a.id), kind: "single" as const, provider: a.agent_type, model: a.model }));
      const custom = (listCustomAgents(db) as Array<{ id: string; name: string; modelId: string }>)
        .map((a) => ({ id: a.id, name: a.name, refType: customAgentTypeName(a.id), kind: "custom" as const, provider: "", model: a.modelId }));
      return [...single, ...custom];
    };

    addRoute("GET", "/teams", () => {
      return html(teamsPage({ teams: listLocalTeams(db), ...teamPageMeta() }));
    });

    // Tools a team may grant to any of its agents. Empty (and the section is not
    // rendered) when none are defined or the flag is off.
    const teamCustomToolChoices = () => (isExperimental()
      ? (require("../custom-tools/store").listCustomTools(db) as Array<{ name: string; description: string }>)
        .map((t) => ({ name: t.name, description: t.description }))
      : []);

    addRoute("GET", "/teams/new", () => {
      return html(teamMapPage({ team: null, agentTypes: teamAgentTypeChoices(), customTools: teamCustomToolChoices(), modelProviders: teamModelProviders(), agentLibrary: teamAgentLibrary(), ...teamPageMeta() }));
    });

    addRoute("GET", "/teams/:id", (_req, params) => {
      const team = getLocalTeam(db, params.id!);
      if (!team) return new Response(null, { status: 302, headers: { Location: "/teams" } });
      return html(teamMapPage({ team, agentTypes: teamAgentTypeChoices(), customTools: teamCustomToolChoices(), modelProviders: teamModelProviders(), agentLibrary: teamAgentLibrary(), ...teamPageMeta() }));
    });

    // Custom agents — agents Skipper runs in-process. Experimental only, so the
    // pages 404 rather than render an empty feature.
    if (isExperimental()) {
      const { customAgentsPage } = require("../html/pages/custom-agents.page");
      const { customAgentFormPage } = require("../html/pages/custom-agent-form.page");
      const { getCustomAgent } = require("../custom-agents/store");
      const { listSingleAgents: listSingleAgentsForLibrary } = require("../single-agents/store");
      const { listAvailableSkills } = require("../custom-agents/skills");
      const { listMcpServers, listImportableServers } = require("../custom-agents/servers");
      const { listCustomTools } = require("../custom-tools/store");

      const skillChoices = () =>
        listAvailableSkills().map((s: { name: string; description: string }) => ({
          name: s.name,
          description: s.description,
        }));

      // Combined agent library: single agents + custom agents in one place, plus
      // the custom-agent tool sources. Servers render from the cached catalogue
      // only - no server is contacted on a page load.
      addRoute("GET", "/agent-library", () => {
        return html(customAgentsPage({
          agents: listCustomAgents(db),
          singleAgents: listSingleAgentsForLibrary(db),
          mcpServers: listMcpServers(db),
          importableServers: listImportableServers(db),
          customTools: listCustomTools(db),
          ...teamPageMeta(),
        }));
      });

      // The old split index paths now fold into the combined library.
      addRoute("GET", "/custom-agents", () => new Response(null, { status: 302, headers: { Location: "/agent-library" } }));

      addRoute("GET", "/custom-agents/new", () => {
        return html(customAgentFormPage({ agent: null, skills: skillChoices(), mcpServers: listMcpServers(db), customTools: listCustomTools(db), ...teamPageMeta() }));
      });

      addRoute("GET", "/custom-agents/:id", (_req, params) => {
        const agent = getCustomAgent(db, params.id!);
        if (!agent) return new Response(null, { status: 302, headers: { Location: "/agent-library" } });
        // The editor must never receive a stored secret. Blank fields plus the
        // "leave blank to keep" contract in `updateCustomAgent` cover the round trip.
        const safe = {
          ...agent,
          apiKey: agent.apiKey ? "__stored__" : "",
          headers: Object.fromEntries(
            Object.entries(agent.headers as Record<string, string>).map(([k, v]) => [k, v ? "__stored__" : ""]),
          ),
        };
        return html(customAgentFormPage({ agent: safe, skills: skillChoices(), mcpServers: listMcpServers(db), customTools: listCustomTools(db), ...teamPageMeta() }));
      });
    }

    // Single-agent editors (experimental). The index folds into /agent-library.
    if (isExperimental()) {
      const { singleAgentFormPage } = require("../html/pages/single-agent-form.page");
      const { getSingleAgent } = require("../single-agents/store");

      addRoute("GET", "/single-agents", () => new Response(null, { status: 302, headers: { Location: "/agent-library" } }));

      addRoute("GET", "/single-agents/new", () => {
        return html(singleAgentFormPage({ agent: null, modelProviders: teamModelProviders(), customTools: teamCustomToolChoices(), ...teamPageMeta() }));
      });

      addRoute("GET", "/single-agents/:id", (_req, params) => {
        const agent = getSingleAgent(db, params.id!);
        if (!agent) return new Response(null, { status: 302, headers: { Location: "/agent-library" } });
        return html(singleAgentFormPage({ agent, modelProviders: teamModelProviders(), customTools: teamCustomToolChoices(), ...teamPageMeta() }));
      });
    }
  }


  // Escalation resolve/dismiss. Each action is registered twice: /api routes
  // redirect home (full-page forms), /fragments routes return the single
  // re-rendered card so htmx can swap #escalation-<id> in place. The navbar
  // badge + dashboard panels are refreshed over WS by ui-push.ts.
  const resolveEscalationAction = async (req: Request, id: string): Promise<string | null> => {
    const body = await parseRequestBody<Record<string, string>>(req);
    if (!body.response) return "response is required";
    try {
      await daemon.resolveEscalation(id, body.response);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Internal error";
    }
  };

  const dismissEscalationAction = (id: string): string | null => {
    try {
      daemon.getEscalationManager().dismissEscalation(id);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Internal error";
    }
  };

  const escalationRedirectResponse = (error: string | null): Response => {
    if (error) return Response.json({ error }, { status: 400 });
    daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
    return new Response(null, { status: 302, headers: { Location: "/" } });
  };

  const escalationCardResponse = (error: string | null, id: string): Response => {
    if (error) return new Response(error, { status: 400 });
    const card = db.prepare(
      `SELECT e.id, e.agent_id, e.task_id, t.title AS task_title,
              e.type, e.question, e.status, e.response, e.created_at, e.resolved_at
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.id = ?`,
    ).get(id) as EscalationCardData | null;
    if (!card) return new Response("", { status: 200 });
    return html(escalationCardPanel(card));
  };

  addRoute("POST", "/api/escalations/:id/resolve", async (req, params) =>
    escalationRedirectResponse(await resolveEscalationAction(req, params.id)));

  addRoute("POST", "/api/escalations/:id/dismiss", (_req, params) =>
    escalationRedirectResponse(dismissEscalationAction(params.id)));

  addRoute("POST", "/fragments/escalations/:id/resolve", async (req, params) =>
    escalationCardResponse(await resolveEscalationAction(req, params.id), params.id));

  addRoute("POST", "/fragments/escalations/:id/dismiss", (_req, params) =>
    escalationCardResponse(dismissEscalationAction(params.id), params.id));

  addRoute("GET", "/logs", (req) => {
    const url = new URL(req.url);
    const filters: LogFilters = {};
    const conditions: string[] = [];
    const values: unknown[] = [];

    const agentId = url.searchParams.get("agent_id");
    if (agentId) { filters.agent_id = agentId; conditions.push("t.agent_id = ?"); values.push(agentId); }

    const stream = url.searchParams.get("stream");
    if (stream) { filters.stream = stream; conditions.push("t.stream = ?"); values.push(stream); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const entries = db.prepare(
      `SELECT t.id, t.agent_id,
              COALESCE(a.name, ta.name, ai.template_agent_id, t.agent_id) as agent_name,
              t.session_id, t.stream, t.data, t.sequence, t.created_at
       FROM terminal_outputs t
       LEFT JOIN agents a ON t.agent_id = a.id
       LEFT JOIN agent_instances ai ON t.agent_id = ai.id
       LEFT JOIN agents ta ON ta.id = ai.template_agent_id
       ${where}
       ORDER BY t.id DESC LIMIT ${LOGS_PAGE_LIMIT}`,
    ).all(...values) as LogEntryData[];

    const agents = db.prepare("SELECT id, name FROM agents ORDER BY name").all() as { id: string; name: string }[];
    const status = daemon.getStatus();
    const escalationCount = getOpenEscalationCount(db);

    return html(logsPage({
      entries,
      filters,
      agents,
      daemonState: status.state,
      daemonUptime: status.uptime,
      escalationCount,
    }));
  });

  addRoute("GET", "/games/asteroids", () => {
    const status = daemon.getStatus();
    const escalationCount = getOpenEscalationCount(db);
    return html(asteroidsPage({ daemonState: status.state, daemonUptime: status.uptime, escalationCount }));
  });

  addRoute("GET", "/audit-events", (req) => {
    const url = new URL(req.url);
    const filters: AuditEventFilters = {};
    const conditions: string[] = [];
    const values: string[] = [];

    const type = url.searchParams.get("type");
    if (type) { filters.type = type; conditions.push("type = ?"); values.push(type); }

    const taskId = url.searchParams.get("task_id");
    if (taskId) { filters.task_id = taskId; conditions.push("task_id = ?"); values.push(taskId); }

    const agentId = url.searchParams.get("agent_id");
    if (agentId) { filters.agent_id = agentId; conditions.push("source_agent_id = ?"); values.push(agentId); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const events = db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT 100`).all(...values) as AuditEventData[];

    // TODO: rebuild auditEventsPage — lost in accidental git checkout revert
    return html(`<html><body><h1>Audit Events</h1><p>Page stub — needs rebuild</p><pre>${JSON.stringify(events.slice(0, 20), null, 2)}</pre></body></html>`);
  });

  // Dashboard fragment routes (initial load; live updates via WebSocket push)
  addRoute("GET", "/fragments/dashboard/active-tasks", () => {
    const rows = db.prepare(
      `SELECT id, title, status, mode, paused, needs_review, wake_requested_at, started_at, result, created_at
       FROM tasks
       WHERE status IN ('active', 'settled')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`,
    ).all() as { id: string; title: string; status: string; mode?: string; paused?: number; needs_review?: number; wake_requested_at?: string | null; started_at?: string | null; created_at?: string }[];
    const tasks = rows.map((r) => ({ ...r, display_status: deriveDisplayStatus(db, r) as string }));
    return html(dashboardActiveTaskFragment(selectDashboardFocusTasks(tasks)));
  });

  addRoute("GET", "/fragments/dashboard/running-instances", () => {
    const runningInstances = fetchDashboardRunningInstances(db);
    return html(dashboardRunningInstancesFragment(runningInstances));
  });

  addRoute("GET", "/fragments/dashboard/running-instances-count", () => {
    const runningInstances = fetchDashboardRunningInstances(db);
    return html(dashboardActiveAgentsCountFragment(runningInstances.length));
  });

  addRoute("GET", "/fragments/dashboard/realtime-timeline", (req) => {
    const url = new URL(req.url);
    const taskId = url.searchParams.get("task_id");
    if (taskId) {
      const entries = db.prepare(
        `SELECT id, entry_type, content, priority, created_at
         FROM realtime_timeline WHERE task_id = ?
         ORDER BY created_at DESC LIMIT 250`,
      ).all(taskId) as { id: string; entry_type: string; content: string; priority: string; created_at: string }[];
      const task = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(taskId) as { id: string; title: string } | null;
      return html(dashboardRealtimeTimelineFragment(task ? { taskId, taskTitle: task.title, entries } : null));
    }
    return html(dashboardRealtimeTimelineFragment(fetchDashboardRealtimeTimeline(db)));
  });

  addRoute("GET", "/fragments/dashboard/phase-indicator", () => {
    return html(dashboardPhaseIndicatorFragment(fetchDashboardPhaseIndicatorTask(db)));
  });

  addRoute("GET", "/fragments/logs/table", (req) => {
    const url = new URL(req.url);
    const conditions: string[] = [];
    const values: unknown[] = [];

    const agentId = url.searchParams.get("agent_id");
    if (agentId) { conditions.push("t.agent_id = ?"); values.push(agentId); }

    const stream = url.searchParams.get("stream");
    if (stream) { conditions.push("t.stream = ?"); values.push(stream); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const entries = db.prepare(
      `SELECT t.id, t.agent_id,
              COALESCE(a.name, ta.name, ai.template_agent_id, t.agent_id) as agent_name,
              t.session_id, t.stream, t.data, t.sequence, t.created_at
       FROM terminal_outputs t
       LEFT JOIN agents a ON t.agent_id = a.id
       LEFT JOIN agent_instances ai ON t.agent_id = ai.id
       LEFT JOIN agents ta ON ta.id = ai.template_agent_id
       ${where}
       ORDER BY t.id DESC LIMIT ${LOGS_PAGE_LIMIT}`,
    ).all(...values) as LogEntryData[];

    return html(logsTableFragment(entries));
  });

  addRoute("GET", "/fragments/dashboard/recent-activity", () => {
    // "Working" gate: any live agent instance means a task run is in flight
    // (idle active tasks are the normal resting state and produce no activity).
    const hasRunningTask = (db.prepare(
      "SELECT EXISTS(SELECT 1 FROM agent_instances WHERE status IN ('running', 'waiting_delegation', 'pending')) AS has_running_task",
    ).get() as { has_running_task: number }).has_running_task === 1;
    if (!hasRunningTask) {
      return html(recentActivityFragment([]));
    }
    const recentLogs = fetchRecentActivity(db, DASHBOARD_ACTIVITY_LIMIT);
    return html(recentActivityFragment(recentLogs));
  });

  addRoute("GET", "/fragments/metrics", () => {
    const m = fetchDashboardMetrics(db);
    return html(metricsFragment({
      mttrMinutes: m.mttr_minutes,
      stuckTaskCount: m.stuck_task_count,
      totalRunningTasks: m.total_running_tasks,
      delegationSuccessRate: m.delegation_success_rate,
      remediationEventCount: m.remediation_event_count,
    }));
  });

  // Team roster fragment — the dashboard "Active Agent" panel. Task context
  // shows the whole team (like zen mode); the aggregate dashboard shows the
  // running agent types across all tasks.
  addRoute("GET", "/fragments/dashboard/latest-steer", (req) => {
    const url = new URL(req.url);
    const taskId = url.searchParams.get("task");

    if (taskId) {
      // On a settled task (idle active or settled), idle orbs stay clickable so
      // the operator can resume an agent for a one-off run outside the workflow.
      const taskRow = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
      const allowIdleSpawn = taskRow?.status === "settled" ||
        (taskRow?.status === "active" && !hasLiveTaskInstances(db, taskId));
      return html(dashboardSteerListFragment(buildTeamAgentTiles(db, taskId), taskId, { allowIdleSpawn }));
    }

    const rows = db.prepare(
      `SELECT ai.template_agent_id,
              COALESCE(a.name, ai.template_agent_id) AS agent_name,
              COUNT(*) AS instance_count
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.status IN ('running', 'waiting_delegation')
       GROUP BY ai.template_agent_id
       ORDER BY MAX(ai.updated_at) DESC`,
    ).all() as Array<{ template_agent_id: string; agent_name: string; instance_count: number }>;

    const tiles = rows.map((r) => ({
      template_agent_id: r.template_agent_id,
      agent_name: r.agent_name,
      instance_count: r.instance_count,
      is_active: true,
    }));

    return html(dashboardSteerListFragment(tiles));
  });

  // Agent instance list for the agent modal — all running instances of one
  // agent type (optionally scoped to a task), each with output + steer input.
  addRoute("GET", "/fragments/dashboard/agent-instances", (req) => {
    const url = new URL(req.url);
    const templateAgentId = url.searchParams.get("template_agent_id");
    const taskId = url.searchParams.get("task");
    if (!templateAgentId) return html(agentInstancesModalFragment([]));

    const conds = ["ai.status IN ('running', 'waiting_delegation')", "ai.template_agent_id = ?"];
    const queryArgs: string[] = [templateAgentId];
    if (taskId) {
      conds.push("ai.task_id = ?");
      queryArgs.push(taskId);
    }

    const instances = db.prepare(
      `SELECT ai.id AS runtime_id, ai.template_agent_id,
              COALESCE(a.name, ai.template_agent_id) AS agent_name,
              ai.task_id, t.title AS task_title, ai.status, ai.process_pid,
              ai.session_id
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ${conds.join(" AND ")}
       ORDER BY ai.updated_at DESC`,
    ).all(...queryArgs) as Array<{
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
      latest_message: fetchLatestAssistantMessage(db, inst.runtime_id),
    }));

    // Settled task (idle active or settled): if no live instance, show the
    // one-off resume card instead of the empty sentinel (which would close the
    // modal). If a one-off is already running, the steer cards above render so
    // it can be steered.
    if (taskId && options.length === 0) {
      const taskRow = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
      if (taskRow?.status === "settled" || taskRow?.status === "active") {
        const latest = db.prepare(
          `SELECT ai.id, ai.session_id, ai.status,
                  COALESCE(a.name, ai.template_agent_id) AS agent_name,
                  at.supports_resume AS supports_resume
           FROM agent_instances ai
           LEFT JOIN agents a ON a.id = ai.template_agent_id
           LEFT JOIN agent_types at ON at.name = a.type
           WHERE ai.task_id = ? AND ai.template_agent_id = ?
           ORDER BY ai.created_at DESC LIMIT 1`,
        ).get(taskId, templateAgentId) as {
          id: string; session_id: string | null; status: string;
          agent_name: string; supports_resume: number | null;
        } | null;

        const activeOneshot = db.prepare(
          `SELECT id FROM agent_instances
           WHERE task_id = ? AND json_extract(state_metadata, '$.oneshot') = 1
             AND status IN ('running', 'waiting_delegation', 'pending') LIMIT 1`,
        ).get(taskId) as { id: string } | null;

        let resumable = true;
        let disabledReason: string | null = null;
        if (!latest) {
          resumable = false; disabledReason = "This agent never ran on this task.";
        } else if (latest.supports_resume !== 1) {
          resumable = false; disabledReason = "This agent's type does not support resume.";
        } else if (!latest.session_id) {
          resumable = false; disabledReason = "This agent has no resumable session on this task.";
        } else if (activeOneshot) {
          resumable = false; disabledReason = "A one-off run is already active on this task.";
        }

        return html(oneshotResumeCardMarkup({
          template_agent_id: templateAgentId,
          task_id: taskId,
          agent_name: latest?.agent_name ?? templateAgentId,
          resumable,
          disabledReason,
        }));
      }
    }

    return html(agentInstancesModalFragment(options));
  });

  // Task escalation cards — polled every 5s by command-center task view
  addRoute("GET", "/fragments/tasks/:id/escalations", (_req, params) => {
    const escalations = db.prepare(
      `SELECT e.id, e.agent_id, e.task_id, t.title AS task_title,
              e.type, e.question, e.status, e.response, e.created_at, e.resolved_at,
              COALESCE(a.name, e.agent_id) AS agent_name
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       LEFT JOIN agents a ON a.id = e.agent_id
       WHERE e.task_id = ?
       ORDER BY CASE WHEN e.status = 'open' THEN 0 ELSE 1 END, e.created_at DESC`,
    ).all(params.id) as EscalationCardData[];

    return html(taskEscalationsSection(escalations));
  });

  addRoute("GET", "/api/tasks/:id/diagnostic", (_req, params) => {
    const diagnostic = daemon.getHealthMonitor().generateWhyStuckDiagnostic(params.id);
    if (!diagnostic) {
      return html(`<div class="card"><p>Task not found</p></div>`);
    }
    return html(diagnosticCard(diagnostic));
  });

  // ── Page routes (v2 frontend, now the default) ──────────────────────────
  registerV2PageRoutes();
}

function registerV2PageRoutes(): void {
  const db = getDb();

  const { commandCenterPage, renderScheduledTaskDetail, renderScheduledRuns } = require("../html/pages/command-center.page");
  const { buildCommandCenterViewModel } = require("../html/view-models/command-center.vm");
  const { taskListPage } = require("../html/pages/task-list.page");
  const { agentTerminalPage } = require("../html/pages/agent-terminal.page");
  const { configPage } = require("../html/pages/config.page");
  const { taskCreatePage } = require("../html/pages/task-create.page");

  const fetchScheduledOverride = (scheduledId: string) => {
    const st = db.prepare(
      `SELECT st.*, tm.name AS team_name FROM scheduled_tasks st LEFT JOIN teams tm ON tm.id = st.team_id WHERE st.id = ?`
    ).get(scheduledId) as any;
    if (!st) return null;
    // task_config comes back as a raw JSON string; parse it so the edit form can
    // read per-task settings (e.g. the Slack slash-command binding).
    try {
      st.task_config = st.task_config ? JSON.parse(st.task_config) : {};
    } catch {
      st.task_config = {};
    }
    // Public trigger URL for the webhook panel; null until connect is configured.
    st.webhook_url = getWebhookTriggerUrl(db, { id: st.id, webhook_key: st.webhook_key ?? null });
    // Series memory summary for the Memory panel (experimental).
    if (isExperimental()) {
      const cfg = readSeriesMemoryConfig(st.task_config);
      st.memory_summary = scopeSummary(db, seriesScopeId(st.id), { enabled: cfg.mode === "shared", mode: cfg.mode, retentionDays: cfg.retentionDays });
    }
    // Unified picker: any visible team can run a recurring task.
    const teams = listAssignableTeams();
    const runs = db.prepare(
      `SELECT id, title, status, started_at, completed_at, result, created_at FROM tasks WHERE source_scheduled_task_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(scheduledId) as Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>;
    return { scheduledTask: st, teams, runs };
  };

  addRoute("GET", "/", (req) => {
    const url = new URL(req.url);
    let selectedTask = url.searchParams.get("task") ?? undefined;
    const scheduledId = url.searchParams.get("scheduled");
    const teamId = url.searchParams.get("team");
    const vm = buildCommandCenterViewModel(db);

    if (scheduledId) {
      const override = fetchScheduledOverride(scheduledId);
      if (override) return html(commandCenterPage(vm, undefined, override));
    }

    // /?team=<id> opens the team's most relevant task (working > queued >
    // paused > latest).
    if (teamId && !selectedTask) {
      const { pickTeamLandingTask } = require("../html/pages/command-center.page");
      const landing = pickTeamLandingTask(vm.allTasks.filter((t: any) => t.team_id === teamId));
      if (landing) selectedTask = landing.id;
    }

    return html(commandCenterPage(vm, selectedTask));
  });

  // Team options fragment for create form dropdown (unified: every visible team).
  addRoute("GET", "/fragments/teams/options", (req) => {
    const url = new URL(req.url, "http://localhost");
    const selected = url.searchParams.get("selected") ?? "";
    const teams = listAssignableTeams();
    const options = teams.map(t => `<option value="${t.id}"${t.id === selected ? " selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
    return html(`<option value="">Select team...</option>${options}`);
  });

  // Workspace fragment — sidebar clicks load this into #mc-main. Every
  // non-draft task renders the same view regardless of mode, so flipping
  // autopilot never swaps the chrome.
  addRoute("GET", "/workspace/task/:id", (_req, params) => {
    const vm = buildCommandCenterViewModel(db, { includeTaskId: params.id });
    const task = vm.allTasks.find((t: any) => t.id === params.id);
    if (!task) return Response.json({ error: "Not found" }, { status: 404 });
    const { taskMainContent, renderDraftEdit } = require("../html/pages/command-center.page");
    if (task.status === "draft") return html(renderDraftEdit(task, vm.teams));
    return html(taskMainContent(vm, task));
  });

  // Inline task name + icon editor for the task-view header (any status). The
  // pencil swaps this into the identity slot; Save posts to /api/tasks/:id/identity,
  // Cancel re-fetches the display fragment below. Both swap ONLY the identity slot.
  addRoute("GET", "/fragments/tasks/:id/identity-edit", (_req, params) => {
    const { TaskScheduler } = require("../tasks/scheduler");
    const task = new TaskScheduler(db).getTask(params.id);
    if (!task) return html("");
    const { renderTaskIdentityEdit } = require("../html/pages/command-center.page");
    return html(renderTaskIdentityEdit(task));
  });

  // Display (non-edit) identity cluster — used to restore the slot on Cancel.
  addRoute("GET", "/fragments/tasks/:id/identity", (_req, params) => {
    const vm = buildCommandCenterViewModel(db, { includeTaskId: params.id });
    const task = vm.allTasks.find((t: any) => t.id === params.id);
    if (!task) return html("");
    const { taskHeaderIdentity } = require("../html/pages/command-center.page");
    return html(taskHeaderIdentity(task));
  });

  // Save the task's name + icon regardless of status, then swap back ONLY the
  // header identity slot (htmx outerHTML). Deliberately NO event / no #mc-main
  // re-render: renaming must not refresh the view (same rule as starring). The
  // sidebar picks up the new name/icon on its next natural render.
  addRoute("POST", "/api/tasks/:id/identity", async (req, params) => {
    const { TaskScheduler } = require("../tasks/scheduler");
    const scheduler = new TaskScheduler(db);
    if (!scheduler.getTask(params.id)) return Response.json({ error: "Task not found" }, { status: 404 });
    const formData = await req.formData();
    const titleRaw = formData.get("title");
    const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    const { sanitizeIcon } = require("../html/atoms/lucide");
    const { sanitizeColor } = require("../html/atoms/creature");
    const rawIcon = formData.get("icon");
    const icon = sanitizeIcon(typeof rawIcon === "string" ? rawIcon : null);
    const rawColor = formData.get("iconColor");
    const iconColor = icon ? sanitizeColor(typeof rawColor === "string" ? rawColor : null) : null;
    scheduler.setIdentity(params.id, title, icon, iconColor);
    const updated = scheduler.getTask(params.id)!;
    const { taskHeaderIdentity, renderSidebarOob } = require("../html/pages/command-center.page");
    // Swap the header identity slot + refresh only the sidebar (OOB) so the new
    // name/icon show in the row without re-rendering the task view.
    return html(taskHeaderIdentity(updated as any) + renderSidebarOob(db));
  });

  // Phase strip fragment — polled by dashboard so phase status updates without a page reload
  addRoute("GET", "/workspace/task/:id/phase-strip", (_req, params) => {
    const vm = buildCommandCenterViewModel(db);
    const task = vm.allTasks.find((t: any) => t.id === params.id);
    if (!task) return html("");
    const mission = params.id ? vm.missionsByTask?.[params.id] : undefined;
    const phases = mission?.phases ?? [];
    const isWorking = (task as any).display_status === "working";
    const { renderPhaseStripFragment } = require("../html/pages/command-center.page");
    return html(renderPhaseStripFragment(phases, params.id, isWorking));
  });

  // Agent list fragment — polled by dashboard for running tasks
  addRoute("GET", "/workspace/task/:id/agents", (_req, params) => {
    const instances = db.prepare(
      `SELECT ai.id, ai.template_agent_id,
              COALESCE(a.name, ai.template_agent_id) AS agent_name,
              ai.parent_instance_id, ai.status, ai.process_pid, ai.task_id
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ? AND ai.status NOT IN ('stopped')
       ORDER BY ai.created_at`
    ).all(params.id) as Array<{
      id: string; agent_name: string; parent_instance_id: string | null;
      status: string; process_pid: number | null; task_id: string;
    }>;

    // Delegation pills: map each delegated instance to its delegation so the
    // polled tree keeps the clickable prompt pill in sync (matches command-center.vm).
    const { fetchDelegationsByChildInstance } = require("../data/command-center");
    const delegationsByChild = fetchDelegationsByChildInstance(db, instances.map((i) => i.id));

    const { buildAgentTree } = require("../html/view-models/command-center.vm");
    const tree = buildAgentTree(instances, delegationsByChild);
    const { renderAgentList } = require("../html/pages/command-center.page");
    return html(renderAgentList(tree));
  });

  // v2 unified timeline: agent prose + operator messages as cards, tool frames
  // grouped, escalations inline. Serves the tc-timeline container.
  addRoute("GET", "/workspace/task/:id/timeline", (_req, params) =>
    html(taskTimelineFragment(db, params.id)));

  // Activity feed — parsed terminal output for the activity tab, paged.
  //   (no cursor)   newest page + a load-more sentinel when the page is full
  //   ?before=<id>  the page of rows older than <id> (sentinel swaps itself for it)
  //   ?after=<id>   every row newer than <id>, no sentinel — the WS "poke"
  //                 (ui-push.ts:pushV2ActivityPoke) makes the client fetch this
  //                 and prepend, so a live task never re-renders the whole feed.
  // Cursors are terminal_outputs.id (globally monotonic) — never `sequence`,
  // which is per instance and collides across agents.
  addRoute("GET", "/workspace/task/:id/activity", (req, params) => {
    const url = new URL(req.url, "http://localhost");
    const num = (v: string | null): number | null => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const beforeId = num(url.searchParams.get("before"));
    const afterId = num(url.searchParams.get("after"));
    const { parseTerminalActivity, activityLoadMoreSentinel } = require("../html/pages/command-center.page");

    // A batch can be non-empty yet render to NO items: frames the summariser
    // drops (keepalives, binary fragments, unhandled provider shapes). In that
    // case parseTerminalActivity returns its "No activity yet" placeholder — fine
    // for a cold render, but the incremental paths PREPEND/APPEND into a feed that
    // already has rows, so injecting that placeholder stacks a spurious empty
    // state on every poke. Gate on RENDERED items (data-sk-activity-row), not the
    // raw row count.
    const hasRenderedItems = (markup: string): boolean => markup.includes("data-sk-activity-row");

    if (afterId != null) {
      const rows = fetchTaskOutputPage(db, params.id, { afterId, limit: ACTIVITY_LIVE_LIMIT });
      // Nothing new (or nothing that renders) → nothing to prepend.
      if (rows.length === 0) return html("");
      const body = parseTerminalActivity(rows);
      return html(hasRenderedItems(body) ? body : "");
    }

    const rows = fetchTaskOutputPage(db, params.id, { beforeId, limit: ACTIVITY_PAGE_SIZE });
    if (rows.length === 0) {
      return html(beforeId == null ? `<div class="mc-activity__empty">No activity recorded</div>` : "");
    }
    const body = parseTerminalActivity(rows);
    const oldest = rows[rows.length - 1]!.id;
    const more = rows.length >= ACTIVITY_PAGE_SIZE ? activityLoadMoreSentinel(params.id, oldest) : "";
    // Cold render with rows that all dropped → show the empty state once; an older
    // page (beforeId set) that all dropped → show nothing but keep the sentinel so
    // scrolling reaches older, renderable rows.
    const rendered = hasRenderedItems(body)
      ? body
      : (beforeId == null ? `<div class="mc-activity__empty">No activity recorded</div>` : "");
    return html(rendered + more);
  });

  // One raw output frame for the activity detail modal (rows no longer embed it).
  addRoute("GET", "/workspace/activity/:outputId", (_req, params) => {
    const id = Number(params.outputId);
    const row = Number.isFinite(id) ? fetchTaskOutputRow(db, id) : null;
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(row.data, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  });

  // Terminal output by task ID (finds the root agent instance)
  addRoute("GET", "/workspace/task/:id/terminal", (_req, params) => {
    // Find agent instances for this task, prefer root/entrypoint
    const instances = db.prepare(
      `SELECT ai.id FROM agent_instances ai
       WHERE ai.task_id = ?
       ORDER BY ai.parent_instance_id IS NULL DESC, ai.created_at ASC
       LIMIT 1`
    ).all(params.id) as Array<{ id: string }>;

    if (instances.length === 0) {
      // Try the template agent (entrypoint uses its own ID as instance ID)
      const task = db.prepare("SELECT team_id FROM tasks WHERE id = ?").get(params.id) as { team_id: string | null } | null;
      if (task?.team_id) {
        const team = db.prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?").get(task.team_id) as { entrypoint_agent_id: string } | null;
        if (team?.entrypoint_agent_id) {
          instances.push({ id: team.entrypoint_agent_id });
        }
      }
    }

    if (instances.length === 0) {
      return html(`<div style="padding: var(--sk-space-4); color: var(--sk-text-subtle); text-align: center;">No terminal output recorded for this task.</div>`);
    }

    // Get output from the root instance
    const agentId = instances[0].id;
    const session = db.prepare(
      "SELECT id FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(agentId) as { id: string } | null;

    if (!session) {
      return html(`<div style="padding: var(--sk-space-4); color: var(--sk-text-subtle); text-align: center;">No terminal session found.</div>`);
    }

    const rows = db.prepare(
      "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence LIMIT 500"
    ).all(agentId, session.id) as Array<{ stream: string; data: string; sequence: number }>;

    if (rows.length === 0) {
      return html(`<div style="padding: var(--sk-space-4); color: var(--sk-text-subtle); text-align: center;">No output recorded.</div>`);
    }

    const { terminalOutputFragment } = require("../html/components");
    return html(terminalOutputFragment(rows));
  });

  // Task details fragment (loaded by Details tab)
  addRoute("GET", "/workspace/task/:id/details", (_req, params) => {
    const task = db.prepare(
      `SELECT t.*, tm.name AS team_name FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id WHERE t.id = ?`
    ).get(params.id) as any;
    if (!task) return html(`<div style="padding:1rem; color:var(--sk-text-subtle);">Task not found</div>`);
    const taskDetailDisplay = deriveDisplayStatus(db, task) as TaskDisplayStatus;
    const taskDetailHasError = taskResultHasError(task.result);

    // Unified agents + delegations list. Each agent instance is LEFT JOINed to the
    // delegation that spawned it (delegations.child_instance_id = ai.id), so a single
    // row shows the agent, who delegated to it, and a clickable prompt (opens the
    // full prompt in #sk-delegation-modal via /fragments/delegations/:id).
    const rows = db.prepare(
      `SELECT ai.id, COALESCE(a.name, ai.template_agent_id) AS agent_name, ai.status,
              ai.created_at,
              d.id AS delegation_id, d.prompt AS delegation_prompt,
              COALESCE(pa.name, d.parent_agent_id) AS parent_name
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN delegations d ON d.child_instance_id = ai.id
       LEFT JOIN agents pa ON pa.id = d.parent_agent_id
       WHERE ai.task_id = ? ORDER BY ai.created_at`
    ).all(params.id) as Array<{
      id: string; agent_name: string; status: string; created_at: string;
      delegation_id: string | null; delegation_prompt: string | null; parent_name: string | null;
    }>;

    // Internal sub-agents each instance spawned via its own Agent/Task tool
    // (recorded in subagent_usage by the stdout parser). Not part of Skipper's
    // delegation graph, so surface the count + accurate token total per instance.
    const subByInstance = new Map<string, { n: number; tok: number }>();
    for (const s of db.prepare(
      `SELECT agent_instance_id, COUNT(*) n, COALESCE(SUM(total_tokens),0) tok
       FROM subagent_usage WHERE task_id = ? GROUP BY agent_instance_id`,
    ).all(params.id) as Array<{ agent_instance_id: string; n: number; tok: number }>) {
      subByInstance.set(s.agent_instance_id, { n: s.n, tok: s.tok });
    }
    const subTotal = db.prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(total_tokens),0) tok FROM subagent_usage WHERE task_id = ?`,
    ).get(params.id) as { n: number; tok: number };
    const fmtTok = (t: number) => t >= 1000 ? (t / 1000).toFixed(t >= 100000 ? 0 : 1) + "k" : String(t);

    const esc = escapeHtml;

    // Per-task memory (experimental): what is stored and how big it is.
    let memoryRow = "";
    if (isExperimental()) {
      const mem = taskMemorySummary(db, task.id);
      const kinds = Object.entries(mem.by_kind).map(([k, n]) => `${n} ${k}`).join(", ");
      const authors = Object.entries(mem.by_author).map(([a, n]) => `${n} ${a}`).join(", ");
      const model = mem.models.length > 0 ? mem.models.map((m) => m.replace(/^local:|^custom:/, "")).join(", ") : null;
      const detail = mem.entries === 0
        ? (mem.enabled ? "no entries yet" : "")
        : `${mem.entries} entries, ${mem.vectors} vectors${mem.pending > 0 ? ` (${mem.pending} pending)` : ""}${mem.dims ? `, ${mem.dims} dims` : ""}${model ? ` &middot; ${esc(model)}` : ""}`
          + ` &middot; ${formatBytes(mem.total_bytes)} <span class="sk-muted">(text ${formatBytes(mem.content_bytes)}, vectors ${formatBytes(mem.vector_bytes)})</span>`;
      const breakdown = mem.entries > 0 ? `<div class="sk-muted sk-text-xs" style="margin-top:2px;">${esc(kinds)}${authors ? ` &middot; ${esc(authors)}` : ""}</div>` : "";
      const state = !mem.enabled ? "Off"
        : mem.mode === "shared" ? `Shared across ${mem.runs} run${mem.runs === 1 ? "" : "s"}${task.source_scheduled_task_id ? ` (<a href="/?scheduled=${esc(task.source_scheduled_task_id)}">recurring task</a>)` : ""}`
        : "On";
      const deletedNote = mem.deleted > 0 ? ` <span class="sk-muted sk-text-xs">&middot; ${mem.deleted} deleted by agents</span>` : "";
      const clearBtn = mem.entries > 0 && !task.source_scheduled_task_id
        ? ` <button type="button" class="sk-btn sk-btn--sm sk-btn--danger" style="margin-left:var(--sk-space-2);" hx-post="/api/tasks/${esc(task.id)}/memory/clear" hx-swap="none" hx-confirm="Delete this task's memory entries? Notes and messages stay; only the memory copy is removed.">Clear</button>`
        : "";
      memoryRow = `<tr><td class="sk-muted">Memory</td><td>${state}${detail ? ` <span class="sk-text-xs">&middot; ${detail}</span>` : ""}${deletedNote}${clearBtn}${breakdown}</td></tr>`;
    }
    const agentRows = rows.map(r => {
      const fromCell = r.parent_name
        ? `<span class="sk-muted sk-text-xs">&larr; ${esc(r.parent_name)}</span>`
        : `<span class="sk-muted sk-text-xs">root</span>`;
      const preview = r.delegation_prompt
        ? (r.delegation_prompt.length > 90 ? r.delegation_prompt.slice(0, 90) + "…" : r.delegation_prompt)
        : "";
      const promptCell = r.delegation_id
        ? `<button type="button" class="sk-btn--link sk-text-xs" style="text-align:left;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;background:none;border:none;padding:0;color:var(--sk-accent-secondary);"
                 title="Click to read the full prompt"
                 data-sk-delegation-open="${esc(r.delegation_id)}">${esc(preview)}</button>`
        : `<span class="sk-muted sk-text-xs">—</span>`;
      const sub = subByInstance.get(r.id);
      const subCell = sub
        ? `<span class="sk-text-xs" title="Internal sub-agents spawned by this agent (Explore, general-purpose, …)">${sub.n} &middot; ${fmtTok(sub.tok)} tok</span>`
        : `<span class="sk-muted sk-text-xs">—</span>`;
      return `<tr>
        <td>${esc(r.agent_name)}</td>
        <td>${fromCell}</td>
        <td><span class="sk-badge sk-badge--${r.status}">${r.status}</span></td>
        <td>${promptCell}</td>
        <td>${subCell}</td>
        <td class="sk-muted sk-text-xs">${formatTimestamp(r.created_at)}</td>
      </tr>`;
    }).join("");

    // Everything sits inside sk-panel containers: the tab panel itself is
    // transparent, so bare tables are unreadable over wallpaper themes.
    // The root is the scroll container (flex:1 + min-height:0 inside the flex
    // tab panel) and the panels are flex-shrink:0 so they never get squashed;
    // the agents table additionally caps its own body at ~10 rows and scrolls
    // internally.
    const { iconIdentityPicker, iconIdentityPickerScript } = require("../html/atoms/icon-identity-picker");
    return html(`<div style="flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:var(--sk-space-3);">
      <div class="sk-panel" style="flex-shrink:0;">
        <div class="sk-panel__header"><span class="sk-panel__title">Name &amp; Icon</span></div>
        <div class="sk-panel__body">
          <form hx-post="/api/tasks/${esc(task.id)}/identity" hx-target="#mc-task-identity-${esc(task.id)}" hx-swap="outerHTML"
                hx-on::after-request="if(event.detail.successful){Skipper.modal.close('tc-details-modal');}">
            <div class="sk-form-group">
              <label class="sk-label">Name</label>
              <input type="text" name="title" class="sk-input" value="${esc(task.title)}" required>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Icon</label>
              ${iconIdentityPicker({ icon: task.icon, color: task.icon_color, nameIcon: "icon", nameColor: "iconColor" })}
            </div>
            <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Save</button>
          </form>
          ${iconIdentityPickerScript()}
        </div>
      </div>
      <div class="sk-panel" style="flex-shrink:0;">
        <div class="sk-panel__header"><span class="sk-panel__title">Task Info</span></div>
        <div class="sk-panel__body--flush">
          <table class="sk-table">
            <tr><td class="sk-muted">ID</td><td class="sk-mono sk-text-xs">${esc(task.id)}</td></tr>
            <tr><td class="sk-muted">Status</td><td><span class="sk-badge ${displayBadgeClass(taskDetailDisplay, taskDetailHasError)}">${displayStatusLabel(taskDetailDisplay)}</span></td></tr>
            <tr><td class="sk-muted">Team</td><td>${esc(task.team_name ?? "Unassigned")}</td></tr>
            <tr><td class="sk-muted">Mode</td><td>${esc(task.mode ?? "workflow")}</td></tr>
            <tr><td class="sk-muted">Phase</td><td>${task.current_phase + 1}</td></tr>
            ${memoryRow}
            <tr><td class="sk-muted">Created</td><td>${formatTimestamp(task.created_at)}</td></tr>
            ${task.completed_at ? `<tr><td class="sk-muted">Completed</td><td>${formatTimestamp(task.completed_at)}</td></tr>` : ""}
            ${subTotal.n > 0 ? `<tr><td class="sk-muted">Internal sub-agents</td><td>${subTotal.n} <span class="sk-muted">(${fmtTok(subTotal.tok)} tokens, not shown in the agent tree)</span></td></tr>` : ""}
            ${task.description ? `<tr><td class="sk-muted">Description</td><td style="white-space:pre-wrap;max-width:500px;">${esc(task.description)}</td></tr>` : ""}
          </table>
        </div>
      </div>

      ${rows.length > 0 ? `
        <div class="sk-panel" style="flex-shrink:0;">
          <div class="sk-panel__header">
            <span class="sk-panel__title">Agents &amp; Delegations</span>
            <span class="sk-muted sk-text-xs">${rows.length}</span>
          </div>
          <div class="sk-panel__body--flush" style="max-height:25.75rem; overflow-y:auto;">
            <table class="sk-table"><thead style="position:sticky; top:0; background:var(--sk-surface-2); z-index:1;"><tr><th>Agent</th><th>From</th><th>Status</th><th>Prompt</th><th>Sub-agents</th><th>Created</th></tr></thead><tbody>${agentRows}</tbody></table>
          </div>
        </div>
      ` : ""}
    </div>`);
  });

  // Scheduled task workspace fragment (sidebar click loads into #mc-main)
  addRoute("GET", "/workspace/scheduled/:id", (_req, params) => {
    const override = fetchScheduledOverride(params.id);
    if (!override) return html(`<div style="padding:1rem; color:var(--sk-text-subtle);">Scheduled task not found</div>`);
    return html(renderScheduledTaskDetail(override.scheduledTask, override.teams, override.runs));
  });

  // Scheduled task runs fragment (lazy-loaded inside the detail panel)
  addRoute("GET", "/workspace/scheduled/:id/runs", (_req, params) => {
    const runs = db.prepare(
      `SELECT id, title, status, started_at, completed_at, result, created_at FROM tasks WHERE source_scheduled_task_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(params.id) as Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>;
    return html(renderScheduledRuns(runs));
  });

  // Task Creation — must be before /tasks/:id to avoid matching "new" as an ID.
  // Recurring task creation is now merged into /tasks/new (Schedule = Recurring);
  // keep the old path as a redirect for any lingering links/bookmarks.
  addRoute("GET", "/tasks/scheduled/new", () => {
    return new Response(null, { status: 302, headers: { Location: "/tasks/new" } });
  });

  addRoute("GET", "/tasks/new", (req) => {
    const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
      .filter(t => isTeamVisible(t.id));
    const escalationCount = getOpenEscalationCount(db);
    const { isTaskTitleGeneratorConfigured } = require("../config/model-settings");
    // A sidebar "+" opens /tasks/new?team=<id> to pre-select that team/agent.
    const selectedTeamId = new URL(req.url).searchParams.get("team") ?? "";
    return html(taskCreatePage({
      teams,
      daemonState: isDaemonPaused(db) ? "paused" : "running",
      daemonUptime: process.uptime(),
      escalationCount,
      titleGeneratorConfigured: isTaskTitleGeneratorConfigured(db),
    }, selectedTeamId));
  });

  // Task List. Split into two sections: regular task instances (created directly)
  // and recurring task instances (each run spawned by a scheduled/recurring task,
  // carrying `source_scheduled_task_id`). Keeping the recurring runs out of the
  // main list stops the one-off tasks from being buried under a firehose of
  // scheduled runs.
  addRoute("GET", "/tasks", () => {
    type TaskListRow = {
      id: string; title: string; status: string; current_phase: number; mode: string;
      paused?: number; needs_review?: number; wake_requested_at?: string | null;
      started_at?: string | null; result?: string | null; created_at: string;
      team_name: string | null; team_phases?: string | null;
    };
    const decorate = <T extends TaskListRow>(r: T) => {
      let hasPhases = false;
      try { hasPhases = (JSON.parse(r.team_phases ?? "[]") as unknown[]).length > 0; } catch { /* ignore */ }
      return {
        ...r,
        display_status: deriveDisplayStatus(db, r) as string,
        result_has_error: taskResultHasError(r.result),
        has_phases: hasPhases,
      };
    };
    const tasks = (db.prepare(
      `SELECT t.id, t.title, t.status, t.current_phase, t.mode, t.paused, t.needs_review,
              t.wake_requested_at, t.started_at, t.result, t.created_at,
              tm.name AS team_name, tm.phases AS team_phases
       FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id
       WHERE t.source_scheduled_task_id IS NULL
       ORDER BY t.created_at DESC`
    ).all() as TaskListRow[]).map(decorate);
    const scheduledRuns = (db.prepare(
      `SELECT t.id, t.title, t.status, t.current_phase, t.mode, t.paused, t.needs_review,
              t.wake_requested_at, t.started_at, t.result, t.created_at,
              tm.name AS team_name, tm.phases AS team_phases, st.title AS source_scheduled_title
       FROM tasks t
       LEFT JOIN teams tm ON tm.id = t.team_id
       LEFT JOIN scheduled_tasks st ON st.id = t.source_scheduled_task_id
       WHERE t.source_scheduled_task_id IS NOT NULL
       ORDER BY t.created_at DESC`
    ).all() as Array<TaskListRow & { source_scheduled_title: string | null }>).map(decorate);
    const escalationCount = getOpenEscalationCount(db);
    return html(taskListPage({ tasks, scheduledRuns, escalationCount, daemonState: isDaemonPaused(db) ? "paused" : "running", daemonUptime: process.uptime() }));
  });

  // Task Execution
  addRoute("GET", "/tasks/:id", (_req, params) => {
    return new Response(null, { status: 302, headers: { Location: `/?task=${params.id}` } });
  });

  // Agent Terminal
  addRoute("GET", "/tasks/:taskId/terminal/:instanceId", (_req, params) => {
    const inst = db.prepare(
      `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS agent_name,
              ai.status, ai.process_pid, ai.task_id
       FROM agent_instances ai LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.id = ?`
    ).get(params.instanceId) as { id: string; template_agent_id: string; agent_name: string; status: string; process_pid: number | null; task_id: string } | null;

    if (!inst) return Response.json({ error: "Instance not found" }, { status: 404 });

    const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(inst.task_id) as { title: string } | null;
    const lineCount = (db.prepare("SELECT COUNT(*) as c FROM terminal_outputs WHERE agent_id = ?").get(inst.id) as { c: number }).c;
    const escalationCount = getOpenEscalationCount(db);

    return html(agentTerminalPage({
      instanceId: inst.id,
      agentName: inst.agent_name,
      status: inst.status,
      pid: inst.process_pid,
      taskId: inst.task_id,
      taskTitle: task?.title ?? "Unknown Task",
      lineCount,
      escalationCount,
      daemonState: isDaemonPaused(db) ? "paused" : "running",
      daemonUptime: process.uptime(),
    }));
  });

  // Configuration Overview
  addRoute("GET", "/config", () => {
    const escalationCount = getOpenEscalationCount(db);
    const { getModelSettingsView } = require("../config/model-settings");
    const { isExperimental } = require("../config/feature-flags");
    const { getSlackConfigView } = require("../config/slack-settings");
    const { getSkipperIdentity } = require("../agents/skipper");
    return html(configPage({
      notificationPreferences: listPreferences(db),
      logRetentionHours: getNumberSetting(db, SETTING_LOG_RETENTION_HOURS, 24),
      taskRetentionDays: getNumberSetting(db, SETTING_TASK_RETENTION_DAYS, 0),
      recurringTaskRetentionDays: getNumberSetting(db, SETTING_RECURRING_TASK_RETENTION_DAYS, 0),
      parallelExecution: getBoolSetting(db, SETTING_PARALLEL_TASKS, true),
      daemonState: isDaemonPaused(db) ? "paused" : "running",
      daemonUptime: process.uptime(),
      escalationCount,
      skipperConnectHasKey: !!getSetting(db, SETTING_SKIPPER_CONNECT_KEY),
      skipperConnectUrl: getStringSetting(db, SETTING_SKIPPER_CONNECT_URL, ""),
      apiKeys: listKeys(),
      modelSettings: getModelSettingsView(db),
      slack: isExperimental() ? getSlackConfigView(db) : undefined,
      taskMemory: isExperimental() ? taskMemoryPanelProvider?.() : undefined,
      autoUpdate: {
        enabled: isAutoUpdateEnabled(db),
        currentVersion: APP_VERSION,
        availableVersion: getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "") || null,
      },
      skipperIdentity: getSkipperIdentity(db),
    }));
  });

  // Persist the Skipper's own orb identity (color + creature). Experimental.
  addRoute("POST", "/api/config/skipper-identity", async (req) => {
    const { isExperimental } = require("../config/feature-flags");
    if (!isExperimental()) return new Response("not found", { status: 404 });
    const { saveSkipperIdentity } = require("../agents/skipper");
    const body = await req.json() as { color?: string; character?: string };
    const saved = saveSkipperIdentity(String(body.color ?? ""), String(body.character ?? ""), db);
    return Response.json({ ok: true, ...saved });
  });

  // Persist a subsystem's provider + model (machine-scoped app_settings).
  addRoute("POST", "/api/config/model-settings", async (req) => {
    const { saveModelSetting } = require("../config/model-settings");
    const contentType = req.headers.get("content-type") ?? "";
    let target = "", agentType = "", model = "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      target = String(fd.get("target") ?? "");
      agentType = String(fd.get("agent_type") ?? "");
      model = String(fd.get("model") ?? "");
    } else {
      const body = await req.json() as { target?: string; agent_type?: string; model?: string };
      target = body.target ?? ""; agentType = body.agent_type ?? ""; model = body.model ?? "";
    }
    const validTargets = ["skipper", "greg", "task_title"];
    // Dictation is experimental-only; its config row is hidden without the flag,
    // so reject writes too.
    const { isExperimental } = require("../config/feature-flags");
    if (isExperimental()) validTargets.push("dictation");
    if (!validTargets.includes(target)) {
      return new Response(`target must be ${validTargets.join("|")}`, { status: 400 });
    }
    const err = saveModelSetting(db, target, agentType, model);
    if (err) return new Response(err, { status: 400 });
    return new Response(null, { status: 204 });
  });

  // Log retention setting + purge
  addRoute("POST", "/api/config/log-retention", async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    let hours: number;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      hours = Number(formData.get("hours"));
    } else {
      const body = await req.json() as { hours?: number };
      hours = Number(body.hours);
    }
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      return new Response("hours must be 1-720", { status: 400 });
    }
    setNumberSetting(db, SETTING_LOG_RETENTION_HOURS, hours);
    return new Response(null, { status: 204 });
  });

  // Task auto-delete windows (days). Experimental. Each input posts only its own
  // field, so update whichever is present. 0 disables that category.
  addRoute("POST", "/api/config/task-retention", async (req) => {
    const { isExperimental } = require("../config/feature-flags");
    if (!isExperimental()) return new Response("Not found", { status: 404 });
    const contentType = req.headers.get("content-type") ?? "";
    let regular: unknown, recurring: unknown;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      regular = fd.get("regular_days");
      recurring = fd.get("recurring_days");
    } else {
      const body = await req.json() as { regular_days?: number; recurring_days?: number };
      regular = body.regular_days;
      recurring = body.recurring_days;
    }
    const clamp = (v: unknown): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > 3650) return NaN;
      return n;
    };
    const r = clamp(regular);
    const rr = clamp(recurring);
    if (Number.isNaN(r) || Number.isNaN(rr)) {
      return new Response("days must be 0-3650", { status: 400 });
    }
    if (r !== null) setNumberSetting(db, SETTING_TASK_RETENTION_DAYS, r);
    if (rr !== null) setNumberSetting(db, SETTING_RECURRING_TASK_RETENTION_DAYS, rr);
    return new Response(null, { status: 204 });
  });

  // The running server's identity ("<version> <boot-id>") — the open tab polls
  // this on WS reconnect and hard-reloads itself when it changes: a self-update
  // (version differs) or any restart (boot id differs). Plain text, no gate.
  addRoute("GET", "/api/version", () => new Response(SERVER_ID, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  }));

  // Toggle auto-updates (patch releases apply automatically when on).
  addRoute("POST", "/api/config/auto-update", async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    let enabled: boolean;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      enabled = fd.get("enabled") != null; // unchecked checkbox omits the field
    } else {
      const body = await req.json() as { enabled?: boolean };
      enabled = !!body.enabled;
    }
    setAutoUpdateEnabled(db, enabled);
    return new Response(null, { status: 204 });
  });

  // Bottom-right update snackbar(s). Polled on load + every 120s by the toast host
  // in the navbar; returns "" when nothing is pending.
  addRoute("GET", "/api/updates/notice", () => html(renderUpdateNotice(getUpdateNoticeView(db))));

  // Dismiss a toast so it doesn't return: "available" records the version dismissed;
  // "applied" clears the one-time "updated" notice.
  addRoute("POST", "/api/updates/dismiss", async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    let kind = "", version = "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      kind = String(fd.get("kind") ?? "");
      version = String(fd.get("version") ?? "");
    } else {
      const body = await req.json() as { kind?: string; version?: string };
      kind = body.kind ?? ""; version = body.version ?? "";
    }
    if (kind === "available") dismissAvailableNotice(db, version);
    else if (kind === "applied") clearAppliedNotice(db);
    return new Response(null, { status: 204 });
  });

  addRoute("POST", "/api/config/log-purge", () => {
    const retentionHours = getNumberSetting(db, SETTING_LOG_RETENTION_HOURS, 24);
    db.prepare("DELETE FROM terminal_outputs WHERE created_at < datetime('now', ? || ' hours')").run(-retentionHours);
    db.prepare("DELETE FROM agent_sessions WHERE created_at < datetime('now', ? || ' hours')").run(-retentionHours);
    db.prepare("DELETE FROM events WHERE created_at < datetime('now', ? || ' hours')").run(-retentionHours);
    return new Response(null, { status: 204 });
  });

  addRoute("POST", "/api/config/skipper-connect", async (req) => {
    const formData = await req.formData();
    const url = (formData.get("url") ?? "").toString().trim();
    const key = (formData.get("key") ?? "").toString().trim();

    if (url) setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, url);
    if (key) setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, key);

    return new Response(null, { status: 204 });
  });

  // Slack integration credential + Socket Mode config (experimental). Per-team
  // opt-in and per-command bindings live on each team / scheduled task.
  addRoute("POST", "/api/config/slack", async (req) => {
    const { isExperimental } = require("../config/feature-flags");
    if (!isExperimental()) return new Response("Not found", { status: 404 });
    const {
      saveSlackConfig,
      parseAllowedUsersInput,
      isSocketModeConfigured,
      isSlackSocketEnabled,
    } = require("../config/slack-settings");
    const formData = await req.formData();
    const botToken = (formData.get("bot_token") ?? "").toString();
    const defaultChannel = (formData.get("default_channel") ?? "").toString();
    const appToken = (formData.get("app_token") ?? "").toString();
    const socketEnabled = formData.get("socket_enabled") != null;
    const allowedUsers = parseAllowedUsersInput((formData.get("allowed_users") ?? "").toString());
    const err = saveSlackConfig(db, { botToken, defaultChannel, appToken, socketEnabled, allowedUsers });
    if (err) return new Response(err, { status: 400 });
    // Apply socket changes without a daemon restart: stop, then re-start if still
    // configured + enabled.
    const { getSlackSocket } = require("../slack/socket");
    const socket = getSlackSocket();
    if (socket) {
      socket.stop();
      if (isSocketModeConfigured(db) && isSlackSocketEnabled(db)) socket.start();
    }
    // Push (outbound) follows the bot token, not Socket Mode: subscribe when a
    // token is set, unsubscribe when it is cleared — no restart. start()/stop()
    // are idempotent, so re-applying the current state is safe.
    const { getSlackPush } = require("../slack/push");
    const { isSlackConfigured } = require("../config/slack-settings");
    const push = getSlackPush();
    if (push) {
      // Route is already experimental-gated above.
      if (isSlackConfigured(db)) push.start();
      else push.stop();
    }
    return new Response(null, { status: 204 });
  });

  // Verify the saved Slack token via auth.test; returns a small HTML fragment.
  addRoute("POST", "/api/config/slack/test", async () => {
    const { isExperimental } = require("../config/feature-flags");
    if (!isExperimental()) return new Response("Not found", { status: 404 });
    const { isSlackConfigured } = require("../config/slack-settings");
    if (!isSlackConfigured(db)) {
      return html(`<span style="color:var(--sk-danger);">No bot token saved yet.</span>`);
    }
    const { SlackClient } = require("../slack/client");
    try {
      const { team, userId } = await new SlackClient(db).authTest();
      return html(`<span style="color:var(--sk-success,#3fb950);">Connected as ${escapeHtml(userId)} in ${escapeHtml(team)}.</span>`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return html(`<span style="color:var(--sk-danger);">${escapeHtml(msg)}</span>`);
    }
  });

  // Notification preference toggle
  addRoute("PUT", "/api/notifications/preferences/:key", async (req, params) => {
    const validKeys = NOTIFICATION_EVENTS.map((e) => e.key);
    if (!validKeys.includes(params.key as NotificationEventKey)) {
      return new Response("Unknown event key", { status: 400 });
    }
    const body = await req.json() as { enabled?: boolean };
    setPreference(db, params.key as NotificationEventKey, !!body.enabled);
    return new Response(null, { status: 204 });
  });

  // Old agent detail path → Config page.
  addRoute("GET", "/config/agents/:id", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // ── Global store routes ──────────────────────────────────────────────────
  {
    const { globalStorePage } = require("../html/pages/global-store.page");
    const { globalStoreEditFragment, globalStoreRowFragment } = require("../html/fragments/global-store-edit.fragment");
    const { GlobalStoreManager } = require("../global-store/manager");
    const globalStore = new GlobalStoreManager(db);

    addRoute("GET", "/global-store", () => {
      const escalationCount = getOpenEscalationCount(db);
      return html(globalStorePage({
        rows: globalStore.query({}),
        daemonState: isDaemonPaused(db) ? "paused" : "running",
        daemonUptime: process.uptime(),
        escalationCount,
      }));
    });

    addRoute("GET", "/fragments/global-store/new", () => {
      return html(globalStoreEditFragment());
    });

    addRoute("GET", "/fragments/global-store/edit", (req) => {
      const name = new URL(req.url).searchParams.get("name");
      if (!name) return new Response("Missing name", { status: 400 });
      const row = globalStore.get(name);
      if (!row) return new Response("Value not found", { status: 404 });
      return html(globalStoreEditFragment(row));
    });

    addRoute("POST", "/api/global-store", async (req) => {
      const formData = await req.formData();
      const name = formData.get("name")?.toString().trim();
      if (!name) return new Response("Missing name", { status: 400 });
      const row = globalStore.set({
        name,
        type: formData.get("type")?.toString() || null,
        data: formData.get("data")?.toString() ?? null,
        status: formData.get("status")?.toString() || null,
      });
      return html(globalStoreRowFragment(row));
    });

    addRoute("DELETE", "/api/global-store", (req) => {
      const name = new URL(req.url).searchParams.get("name");
      if (!name) return new Response("Missing name", { status: 400 });
      globalStore.delete(name);
      return new Response("", { status: 200 });
    });
  }

  // ── Retired team editor ─────────────────────────────────────────────────
  // The config-page team form is gone; /teams is the team interface now. These
  // paths stay as redirects so old bookmarks and links still land somewhere.
  addRoute("GET", "/local-teams", () => {
    return new Response(null, { status: 302, headers: { Location: "/teams" } });
  });

  addRoute("GET", "/config/teams/new", () => {
    return new Response(null, { status: 302, headers: { Location: "/teams/new" } });
  });

  addRoute("GET", "/config/teams/:id/edit", (_req, params) => {
    return new Response(null, { status: 302, headers: { Location: `/teams/${encodeURIComponent(params.id!)}` } });
  });

  // ── Task-form fragments ──────────────────────────────────────────────────

  // Fragment: per-task phase overrides for a selected team (used by the task form
  // #phase-config-slot). Renders review-gate + prompt override controls per phase;
  // submitted fields are parsed in src/routes/tasks.ts into
  // task_config.phase_overrides.
  const { taskPhaseConfigFragment } = require("../html/pages/task-create.page");
  addRoute("GET", "/fragments/task-form/phase-config", (req) => {
    const url = new URL(req.url, "http://localhost");
    // The command-center slot bakes teamId into the URL (for taskId) AND sends the
    // live select value via hx-include on change — prefer the last non-empty value.
    const teamIds = url.searchParams.getAll("teamId");
    const teamId = [...teamIds].reverse().find((v) => v !== "") ?? "";
    const taskId = url.searchParams.get("taskId") ?? "";

    if (!teamId) return html(`<div></div>`);
    const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(teamId) as { phases: string } | null;
    if (!teamRow) return html(`<div></div>`);

    let teamPhases: Array<{ name: string; prompt?: string; review?: boolean }> = [];
    try { teamPhases = JSON.parse(teamRow.phases ?? "[]"); } catch { /* ignore */ }

    let existingOverrides: Record<string, { prompt?: string; review?: boolean }> = {};
    if (taskId) {
      const taskRow = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(taskId) as { task_config: string } | null;
      if (taskRow?.task_config) {
        try {
          const cfg = JSON.parse(taskRow.task_config) as Record<string, unknown>;
          const po = cfg.phase_overrides;
          if (po && typeof po === "object") existingOverrides = po as Record<string, { prompt?: string; review?: boolean }>;
        } catch { /* ignore */ }
      }
    }

    return html(taskPhaseConfigFragment(teamPhases, existingOverrides));
  });

  // Fragment: team selector. Owned by all task creation forms via
  // <div id="task-form-team-slot" hx-get="...">. Unified: every visible team is
  // assignable regardless of the autopilot toggle (a team's mode is only the
  // autopilot default), so this slot never re-fetches on mode change. `context`
  // controls markup style so the slot fits the host form:
  //   - "full"    -> sk-* form-group classes (task-create.page, command-center)
  //   - "inline"  -> compact ids/classes matching dashboard inline form
  //   - "compact" -> bare <label> blocks for task-form-grid (taskFormFields)
  addRoute("GET", "/fragments/task-form/team", (req) => {
    const url = new URL(req.url, "http://localhost");
    const context = (url.searchParams.get("context") ?? "full") as "full" | "inline" | "compact";
    const selectedTeamId = url.searchParams.get("selectedTeamId") ?? "";

    const slotAttrs = `id="task-form-team-slot" style="display:contents;"`;

    // Teams plus (experimental) single agents. A single agent is assigned by
    // setting team_id to its projected `sa:<id>` team id, so the whole
    // team-keyed pipeline runs it unchanged.
    const teams = listAssignableTeams();
    const teamOptions = teams.map(t =>
      `<option value="${escapeHtml(t.id)}"${t.id === selectedTeamId ? " selected" : ""}>${escapeHtml(t.name)}</option>`
    ).join("");
    // Solo agents: a single (headless CLI) agent OR a custom agent can run a task
    // alone. Assigned by setting team_id to its projected `sa:<id>` / `ca:<id>`
    // solo-team id, so the whole team-keyed pipeline runs it unchanged. Both
    // libraries share one "Agents" optgroup. Not gated: the sidebar lists solo
    // runs ungated, and a sidebar "+" on an agent row must pre-select it here; the
    // list is empty anyway unless the operator created agents (an experimental UI).
    let agentGroups = "";
    {
      const { listSingleAgents, singleAgentTeamId } = require("../single-agents/store");
      const { listCustomAgents, customAgentSoloTeamId } = require("../custom-agents/store");
      const entries = [
        ...(listSingleAgents(db) as Array<{ id: string; name: string }>).map((a) => ({ value: singleAgentTeamId(a.id), name: a.name })),
        ...(listCustomAgents(db) as Array<{ id: string; name: string }>).map((a) => ({ value: customAgentSoloTeamId(a.id), name: a.name })),
      ];
      const opts = entries
        .map((e) => `<option value="${escapeHtml(e.value)}"${e.value === selectedTeamId ? " selected" : ""}>${escapeHtml(e.name)}</option>`)
        .join("");
      if (opts) agentGroups = `<optgroup label="Agents">${opts}</optgroup>`;
    }

    if (context === "inline") {
      return html(`<div ${slotAttrs}>
        <select name="teamId" id="dashboard-inline-team">
          <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}${agentGroups}
        </select>
      </div>`);
    }
    if (context === "compact") {
      return html(`<div ${slotAttrs}>
        <label id="team-field-wrapper"><span>Team</span>
          <select name="teamId" id="team-field">
            <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}${agentGroups}
          </select>
        </label>
      </div>`);
    }
    // full
    return html(`<div ${slotAttrs}>
      <div class="sk-form-group" style="flex:1;">
        <label class="sk-label">Team or agent</label>
        <select name="teamId" class="sk-select">
          <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}${agentGroups}
        </select>
      </div>
    </div>`);
  });

}

// The task page and dashboard render the same artifact modal; only the route
// prefix, the JS opener, and the swap target differ.
interface ArtifactModalVariant {
  routePrefix: string;
  openFn: string;
  target: string;
  /** DOM id of the artifacts list container for this surface, so publish /
   *  unpublish can re-render it out-of-band (the badge lives in the list). */
  listId: (taskId: string) => string;
}

const ARTIFACT_MODAL_VARIANTS: ArtifactModalVariant[] = [
  // Primary surface (dashboard task view + realtime page): the artifact opens
  // INSIDE its own dock panel (#sk-artifact-detail), not a full-screen modal.
  { routePrefix: "/fragments/tasks", openFn: "skOpenArtifactPanel", target: "#sk-artifact-detail", listId: (id) => `mc-artifacts-${id}` },
  { routePrefix: "/fragments/dashboard/tasks", openFn: "openDashboardArtifactModal", target: "#dashboard-artifact-modal-body", listId: () => "dashboard-artifact-list" },
];

interface ArtifactRow {
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  created_at: string;
}

function artifactModalLink(variant: ArtifactModalVariant, taskId: string, name: string, version?: number): string {
  const versionQuery = version === undefined ? "" : `?version=${version}`;
  return `onclick="${variant.openFn}(); return false;" hx-get="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(name)}${versionQuery}" hx-target="${variant.target}" hx-swap="innerHTML"`;
}

function renderArtifactDetailFragment(
  db: ReturnType<typeof getDb>,
  taskId: string,
  artifactName: string,
  versionParam: string,
  variant: ArtifactModalVariant,
): string {
  let artifact: (ArtifactRow & { body: string | null; publish_key: string | null; published_at: string | null }) | null;
  if (versionParam === "latest") {
    artifact = db.prepare(
      `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC LIMIT 1`,
    ).get(taskId, artifactName) as typeof artifact;
  } else {
    artifact = db.prepare(
      `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? AND version = ?`,
    ).get(taskId, artifactName, Number(versionParam)) as typeof artifact;
  }

  if (!artifact) {
    return `<p class="muted">Artifact not found.</p>`;
  }

  const versions = db.prepare(
    `SELECT version, created_at, published_at FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC`,
  ).all(taskId, artifactName) as { version: number; created_at: string; published_at: string | null }[];

  const versionsShowPublished = isExperimental();
  const versionLinks = versions.map((v) => {
    const publishedMark = versionsShowPublished && v.published_at ? `<span title="Published">&#128279;</span>` : "";
    if (v.version === artifact!.version) {
      return `<span class="badge badge-info">v${v.version}${publishedMark}</span>`;
    }
    return `<a href="#" ${artifactModalLink(variant, taskId, artifactName, v.version)} class="badge">v${v.version}${publishedMark}</a>`;
  }).join(" ");

  const publish = {
    isPublished: artifact.published_at != null,
    publicUrl: artifact.published_at != null ? getPublicArtifactUrl(db, artifact) : null,
    connectConfigured: getConnectPublicBase(db) != null,
  };

  return renderArtifactDetail(artifact, taskId, versionLinks, variant, publish);
}

function renderArtifactDetail(
  artifact: { id: string; name: string; version: number; kind: string; description: string | null; body: string | null; format?: string | null; created_at: string; storage?: string | null; mime?: string | null; bytes?: number | null; width?: number | null; height?: number | null },
  taskId: string,
  versionLinks: string,
  variant: ArtifactModalVariant,
  publish: { isPublished: boolean; publicUrl: string | null; connectConfigured: boolean },
): string {
  if (artifact.storage === "file") {
    // Operator upload: no text body to render or edit. Images show full size,
    // everything else is a download link. Bytes come from the immutable file route.
    const fileUrl = `/api/artifacts/${escapeHtml(artifact.id)}/file`;
    const isImage = !!artifact.mime && artifact.mime.startsWith("image/");
    const dims = isImage && artifact.width && artifact.height ? ` &middot; ${artifact.width}&times;${artifact.height}` : "";
    const caption = artifact.body?.trim() ? `<p class="artifact-file__caption">${escapeHtml(artifact.body.trim())}</p>` : "";
    const media = isImage
      ? `<a href="${fileUrl}" target="_blank" rel="noopener" title="Open in a new tab"><img class="artifact-file__img" src="${fileUrl}" alt="${escapeHtml(artifact.name)}"></a>`
      : `<div class="artifact-file__dl"><span aria-hidden="true">${fileArtifactIcon(artifact.mime ?? null)}</span> <a href="${fileUrl}" download="${escapeHtml(artifact.name)}">Download ${escapeHtml(artifact.name)}</a></div>`;
    return `<div class="artifact-detail artifact-detail--file">
    <div class="artifact-detail-header">
      <h3>${escapeHtml(artifact.name)} <span class="badge badge-info">v${artifact.version}</span></h3>
    </div>
    <p class="muted">${escapeHtml(artifact.mime ?? "file")} &middot; ${escapeHtml(formatBytes(artifact.bytes))}${dims} &middot; ${formatTimestamp(artifact.created_at)}</p>
    <div class="artifact-versions">Versions: ${versionLinks}</div>
    ${caption}
    <div class="artifact-body artifact-file">${media}</div>
  </div>`;
  }

  const bodyContent = artifact.body ? escapeHtml(artifact.body) : "(empty)";
  const rawBody = artifact.body ?? "";
  // Prefer the stored format; fall back to the heuristic for legacy rows that
  // predate the format column (format IS NULL).
  const isHtml = artifact.format ? artifact.format === "html" : looksLikeHtml(rawBody);
  const renderedBody = isHtml
    ? rawBody.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    : `<div class="artifact-body-markdown" data-artifact-md>${escapeHtml(rawBody)}</div>`;

  // Artifact publishing (public Skipper Connect links) is experimental-only; the
  // whole surface (button, badge, public URL) is hidden unless the flag is on.
  const publishEnabled = isExperimental();
  const publishRoute = (action: "publish" | "unpublish") =>
    `hx-post="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(artifact.name)}/${action}?version=${artifact.version}" hx-target="${variant.target}" hx-swap="innerHTML"`;
  const publishButton = !publishEnabled
    ? ""
    : publish.isPublished
      ? `<button type="button" class="btn-sm" ${publishRoute("unpublish")}>Unpublish</button>`
      : publish.connectConfigured
        ? `<button type="button" class="btn-sm" ${publishRoute("publish")}>Publish</button>`
        : `<button type="button" class="btn-sm" disabled title="Configure Skipper Connect first">Publish</button>`;
  const publishedBadge = publishEnabled && publish.isPublished ? ` <span class="badge badge-published">Published</span>` : "";
  const publicUrlRow = publishEnabled && publish.isPublished && publish.publicUrl
    ? `<div class="artifact-public-url" style="display:flex;gap:var(--sk-space-2);align-items:center;margin:var(--sk-space-2) 0;">
        <input type="text" readonly class="sk-input" style="flex:1;font-size:0.75rem;" value="${escapeHtml(publish.publicUrl)}" onclick="this.select();">
        <button type="button" class="btn-sm" onclick="navigator.clipboard.writeText(this.previousElementSibling.value); this.textContent='Copied';">Copy link</button>
      </div>`
    : "";

  return `<div class="artifact-detail">
    <div class="artifact-detail-header">
      <h3>${escapeHtml(artifact.name)} <span class="badge badge-info">v${artifact.version}</span>${publishedBadge}</h3>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        ${publishButton}
        <button type="button" class="btn-sm" data-sk-artifact-toggle data-mode="rendered">Raw</button>
        <button type="button" class="btn-sm" data-sk-artifact-edit>Edit</button>
      </div>
    </div>
    <p class="muted">${escapeHtml(artifact.kind)} &middot; ${formatTimestamp(artifact.created_at)}${artifact.description ? ` &middot; ${escapeHtml(artifact.description)}` : ""}</p>
    <div class="artifact-versions">Versions: ${versionLinks}</div>
    ${publicUrlRow}
    <div class="artifact-body artifact-rendered">${renderedBody}</div>
    <pre class="artifact-body artifact-raw" style="display:none;"><code>${bodyContent}</code></pre>
    <div class="artifact-edit" style="display:none;">
      <textarea class="sk-textarea" rows="20" style="width:100%;font-family:monospace;font-size:0.8rem;">${escapeHtml(rawBody)}</textarea>
      <div style="margin-top:var(--sk-space-2);display:flex;gap:var(--sk-space-2);">
        <button type="button" class="sk-btn sk-btn--primary sk-btn--sm" data-sk-artifact-save
          data-task-id="${escapeHtml(taskId)}" data-artifact-name="${escapeHtml(artifact.name)}"
          data-artifact-kind="${escapeHtml(artifact.kind)}">Save as v${artifact.version + 1}</button>
        <button type="button" class="sk-btn sk-btn--sm" data-sk-artifact-edit-cancel>Cancel</button>
      </div>
    </div>
  </div>`;
}
