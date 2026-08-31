import type { TaskScheduler } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { isValidScheduleMatrix, type ScheduleMatrix } from "../tasks/scheduled-scheduler";
import type { EscalationManager } from "../escalations/manager";
import type { ArtifactManager } from "../orchestrator/artifact-manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import type { RealtimeSessionManager } from "../orchestrator/realtime-session";
import { timingSafeEqual } from "crypto";
import { fetchTaskNotes, fetchTaskArtifacts, buildTeamAgentTiles } from "../data/queries";
import { fetchScheduledTaskRows, fetchRecentScheduledRuns } from "../data/command-center";
import { MessageManager } from "../messages/manager";
import { TeamManager } from "../teams/manager";
import { listTeamsForStandardTasks, listRealtimeTeams } from "../config/teams";
import { isTaskTitleGeneratorConfigured } from "../config/model-settings";
import { ensureTaskTitle } from "../tasks/title-generator";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { looksLikeHtml } from "../html/atoms/sniff-html";
import { CONNECT_PROTOCOL_VERSION, type StateSnapshot } from "./protocol";
import { getPublicArtifactUrl } from "./public-links";
import { snapshotOpenEscalations, snapshotTasks } from "./serializers";
import {
  listLocalTeams,
  getLocalTeam,
  createLocalTeam,
  updateLocalTeam,
  deleteLocalTeam,
  teamsReferencingAgentType,
  reflattenTeamsReferencingAgentType,
  type LocalTeam,
  type LocalTeamInput,
} from "../teams/local-teams";
import { toTeamInput } from "../teams/team-input";
import { isExperimental } from "../config/feature-flags";
import { listAgentTypes } from "../config/store";
import { isAllowedProvider } from "../config/model-settings";
import {
  listSingleAgents,
  getSingleAgent,
  createSingleAgent,
  updateSingleAgent,
  deleteSingleAgent,
  singleAgentRefType,
  type SingleAgent,
  type SingleAgentInput,
} from "../single-agents/store";
import {
  listCustomAgents,
  getCustomAgent,
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
  customAgentTypeName,
  type CustomAgent,
  type CustomAgentInput,
} from "../custom-agents/store";

// ---------------------------------------------------------------------------
// Projections for team + agent management over Connect. Wire keys match the
// shared Connect contract exactly (camelCase where shown, agent_type snake).
// Agent secrets are NEVER emitted: a custom agent's key/headers/queryParams
// collapse to a single hasKey flag.
// ---------------------------------------------------------------------------

/** Full team projection (list-all / create / update reply shape). */
function connectTeamRow(team: LocalTeam) {
  return {
    id: team.id,
    name: team.name,
    mode: team.config.mode ?? "regular",
    phaseCount: team.phases.length,
    agentCount: team.agents.length,
    phases: team.phases.map((p) => ({
      name: p.name,
      prompt: p.prompt ?? "",
      review: p.review ?? false,
    })),
    agents: team.agents.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      model: a.model,
      instruction: a.instruction ?? "",
      role: a.role ?? null,
    })),
    slackEnabled: team.config.slackEnabled === true,
    slashCommand: team.config.slashCommand ?? "",
  };
}

/** Headless CLI (single) agent projection. */
function connectSingleAgentRow(sa: SingleAgent) {
  return {
    id: sa.id,
    name: sa.name,
    agent_type: sa.agent_type,
    model: sa.model,
    instruction: sa.instruction,
    capabilities: sa.capabilities,
  };
}

/** Custom agent projection — secrets redacted to hasKey. */
function connectCustomAgentRow(a: CustomAgent) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    baseUrl: a.baseUrl,
    modelId: a.modelId,
    systemPrompt: a.systemPrompt,
    maxSteps: a.maxSteps,
    temperature: a.temperature,
    hasKey: (a.apiKey ?? "").trim() !== "",
  };
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface ResourceDeps {
  taskScheduler: TaskScheduler;
  scheduledTaskScheduler: ScheduledTaskScheduler;
  escalationManager: EscalationManager;
  artifactManager: ArtifactManager;
  phaseManager: PhaseManager;
  realtimeSessionManager: RealtimeSessionManager;
}

export type ResourceResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function handleResourceRequest(
  resource: string,
  action: string,
  params: Record<string, unknown>,
  deps: ResourceDeps,
): Promise<ResourceResult> {
  try {
    const { taskScheduler, scheduledTaskScheduler, escalationManager, phaseManager } = deps;
    const db = getDb();

    switch (resource) {
      case "tasks": {
        switch (action) {
          case "list":
            return { ok: true, data: taskScheduler.listTasks() };
          case "read": {
            const id = String(params.id ?? "");
            const task = taskScheduler.getTask(id);
            if (!task) return { ok: true, data: null };
            // Attach the team roster with a live active flag so a remote client
            // can show which member is currently working (same source as the
            // dashboard's agent orbs). Empty for solo/teamless tasks.
            return { ok: true, data: { ...task, agent_tiles: buildTeamAgentTiles(db, id) } };
          }
          case "create": {
            const taskType = params.taskType != null ? String(params.taskType) : undefined;
            if (taskType && taskType !== "standard" && taskType !== "real_time" && taskType !== "recurring") {
              return { ok: false, error: `Invalid taskType: ${taskType}` };
            }
            const title = String(params.title ?? "").trim();
            const description = params.description != null ? String(params.description) : undefined;
            const teamId = params.teamId != null && String(params.teamId) !== "" ? String(params.teamId) : undefined;
            const workingDirectory = params.workingDirectory != null ? String(params.workingDirectory) : process.cwd();

            // Title is optional only when a title-generator provider is configured
            // (the daemon generates one); otherwise it stays required on every kind.
            if (!title && !isTaskTitleGeneratorConfigured(db)) {
              return { ok: false, error: "title is required" };
            }

            // Recurring tasks live in a separate table with their own scheduler.
            // Interval cadence only (unit + amount); weekly matrix and phase
            // overrides are intentionally not exposed here (keep the remote form
            // simple). Omitting both schedule fields = a manual-only series.
            if (taskType === "recurring") {
              const unit = params.scheduleUnit != null ? String(params.scheduleUnit) : undefined;
              if (unit && unit !== "minutes" && unit !== "hours" && unit !== "days") {
                return { ok: false, error: `Invalid scheduleUnit: ${unit}` };
              }
              const amount = params.scheduleAmount != null ? Number(params.scheduleAmount) : undefined;
              if (unit && (!Number.isFinite(amount) || (amount ?? 0) <= 0)) {
                return { ok: false, error: "scheduleAmount must be a positive number" };
              }
              // Optional weekly matrix: 7x24 of 0/1, index 0 = Monday, one run at
              // the top of each enabled local hour. Accepts an array or a JSON
              // string. Interval and matrix are mutually exclusive.
              let matrix: ScheduleMatrix | null = null;
              const rawMatrix = params.scheduleMatrix;
              if (rawMatrix != null && rawMatrix !== "") {
                let parsed: unknown;
                try {
                  parsed = typeof rawMatrix === "string" ? JSON.parse(rawMatrix) : rawMatrix;
                } catch {
                  return { ok: false, error: "scheduleMatrix must be valid JSON" };
                }
                if (!isValidScheduleMatrix(parsed)) {
                  return { ok: false, error: "scheduleMatrix must be a 7x24 array of 0/1 with at least one enabled hour" };
                }
                matrix = parsed;
              }
              if (unit && matrix) {
                return { ok: false, error: "Use either an interval or a weekly schedule, not both" };
              }
              const created = scheduledTaskScheduler.createScheduledTask({
                title,
                description,
                teamId,
                workingDirectory,
                scheduleUnit: (unit as "minutes" | "hours" | "days" | undefined) ?? null,
                scheduleAmount: unit ? (amount ?? null) : null,
                scheduleMatrix: matrix,
              });
              // createScheduledTask lands the series in `draft`; the tick loop and
              // run-recurring both require `approved`, so a remote-created series is
              // inert until approved. Mirror the web "Create & Approve": when the
              // caller opts in, approve now (computes next_run_at, or leaves it null
              // for a manual-only series so it stays "Run Now"-only). Best-effort.
              const autoApprove = params.autoApprove === true || String(params.autoApprove ?? "") === "1";
              if (autoApprove) {
                try {
                  return { ok: true, data: scheduledTaskScheduler.approveScheduledTask(created.id) };
                } catch {
                  return { ok: true, data: created };
                }
              }
              return { ok: true, data: created };
            }

            // Real-time may carry an optional numeric config; phase overrides are
            // deliberately not accepted over Connect.
            let taskConfig: Record<string, number> | undefined;
            if (taskType === "real_time" && params.taskConfig && typeof params.taskConfig === "object") {
              const cfg = params.taskConfig as Record<string, unknown>;
              const out: Record<string, number> = {};
              for (const key of ["window_seconds", "summary_cadence_seconds", "trigger_min_confidence", "max_pending_windows"]) {
                const v = Number(cfg[key]);
                if (Number.isFinite(v)) out[key] = v;
              }
              if (Object.keys(out).length) taskConfig = out;
            }
            const createdTask = taskScheduler.createTask({
              title,
              description,
              teamId,
              taskType: taskType as "standard" | "real_time" | undefined,
              taskConfig,
              workingDirectory,
            });
            // Blank title: generate asynchronously. The new title reaches this
            // integrator via the task:state_changed fat event updateTitle emits.
            if (!title) {
              void ensureTaskTitle(db, taskScheduler, createdTask.id);
            }
            return { ok: true, data: createdTask };
          }
          case "delete":
            return { ok: true, data: { deleted: taskScheduler.deleteTask(String(params.id ?? "")) } };
          case "approve":
            return { ok: true, data: taskScheduler.approveTask(String(params.id ?? "")) };
          case "unapprove":
            // Send an approved (not-yet-running) task back to draft.
            return { ok: true, data: taskScheduler.unapproveTask(String(params.id ?? "")) };
          case "update": {
            // Edit a task's title / description / assignee. Draft-only, via the
            // guarded domain method: an approved or running task is mid-flight
            // (a real-time draft has no session yet, but an approved one is live,
            // and re-approving a standard task re-queues it), so editing those is
            // deliberately not offered here — the remote form only edits drafts.
            const id = String(params.id ?? "");
            const existing = taskScheduler.getTask(id);
            if (!existing) return { ok: false, error: "Task not found" };
            if (existing.status !== "draft") {
              return { ok: false, error: `Can only edit a draft task (this one is ${existing.status})` };
            }
            const title = String(params.title ?? "").trim();
            if (!title) return { ok: false, error: "title is required" };
            // Keep the stored value when the client omits the field.
            const description = params.description != null ? String(params.description) : (existing.description ?? "");
            const teamId = params.teamId != null && String(params.teamId) !== ""
              ? String(params.teamId)
              : existing.team_id ?? undefined;
            try {
              return { ok: true, data: taskScheduler.updateTask(id, { title, description, teamId }) };
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          }
          case "run-recurring": {
            // Optional per-run input injected into this one spawned run's prompt
            // (mirrors the dashboard "Run now" input field). Blank = no input.
            const runInput = String(params.input ?? "").trim() || undefined;
            return { ok: true, data: scheduledTaskScheduler.runTaskNow(String(params.id ?? ""), taskScheduler, runInput) };
          }
          case "resume": {
            // Unlike the HTTP routes, paused->running via this path does NOT respawn agents (daemon not injected).
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            const task = taskScheduler.getTask(id);
            if (!task) return { ok: false, error: "Task not found" };
            if (task.status === "failed") return { ok: true, data: taskScheduler.resumeTask(id) };
            if (task.status === "paused") return { ok: true, data: taskScheduler.resumeFromPause(id) };
            return { ok: false, error: `Cannot resume task with status: ${task.status}` };
          }
          case "pause": {
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            return { ok: true, data: taskScheduler.pauseTask(id) };
          }
          case "retry": {
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            return { ok: true, data: taskScheduler.retryTask(id) };
          }
          case "complete": {
            // Unlike POST /api/tasks/:id/complete, this cannot kill live agent processes (daemon not injected).
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            return { ok: true, data: taskScheduler.completeTask(id) };
          }
          case "iterate": {
            const id = String(params.id ?? "");
            const additionalInput = String(params.additionalInput ?? "");
            if (!id) return { ok: false, error: "id is required" };
            if (!additionalInput.trim()) return { ok: false, error: "additionalInput is required" };
            return { ok: true, data: taskScheduler.iterateTask(id, additionalInput) };
          }
          case "reopen": {
            // Real_time tasks are reopened (unarchived), not iterated: move a
            // completed/failed task back to running and restart its session.
            // Mirrors POST /api/realtime-tasks/:id/unarchive.
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            const task = taskScheduler.getTask(id);
            if (!task) return { ok: false, error: "Task not found" };
            if (task.status !== "completed" && task.status !== "failed") {
              return { ok: false, error: "Only completed or failed tasks can be reopened" };
            }
            const previousStatus = task.status;
            db.prepare(
              "UPDATE tasks SET status = 'running', result = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?",
            ).run(id);
            eventBus.emit("task:state_changed", { taskId: id, previousStatus, newStatus: "running" });
            const rtMgr = deps.realtimeSessionManager;
            if (!rtMgr.isSessionActive(id)) rtMgr.resumeSession(id);
            return { ok: true, data: taskScheduler.getTask(id) };
          }
          default:
            return { ok: false, error: `Unknown tasks action: ${action}` };
        }
      }

      case "teams": {
        // Light projection for remote task creation: pick a team, never its full config.
        // taskType=real_time returns the real-time team picker; anything else uses
        // the standard picker (no realtime, no hidden teams), matching the web form.
        if (action === "list") {
          const forRealtime = String(params.taskType ?? "") === "real_time";
          const pickable = new Set(
            (forRealtime ? listRealtimeTeams() : listTeamsForStandardTasks()).map((t) => t.id),
          );
          const teams = new TeamManager(db).listTeams().filter((t) => pickable.has(t.id));
          return {
            ok: true,
            data: teams.map((t) => ({
              id: t.id,
              name: t.name,
              goal: t.goal ?? null,
              phase_count: t.phases.length,
            })),
          };
        }

        // Full team-management surface for a Connect client (iOS/web). Reuses the
        // local-teams store; no CRUD is reimplemented here.
        if (action === "list-all") {
          return { ok: true, data: listLocalTeams(db).map(connectTeamRow) };
        }
        if (action === "create") {
          const mode = params.mode === "realtime" ? "realtime" : "regular";
          const coerced = toTeamInput({ name: params.name, phases: params.phases, agents: params.agents });
          const input: LocalTeamInput = { ...coerced, config: { ...(coerced.config ?? {}), mode } };
          return { ok: true, data: connectTeamRow(createLocalTeam(db, input)) };
        }
        if (action === "update") {
          const id = String(params.id ?? "");
          if (!id) return { ok: false, error: "id is required" };
          const existing = getLocalTeam(db, id);
          if (!existing) return { ok: false, error: "Team not found" };
          const mode = params.mode === "realtime" ? "realtime" : "regular";
          // State-safety: coerce ONLY name/phases/agents from the wire; carry
          // hooks/skipper_prompt/config forward from the stored team and overlay
          // just the mode, so fields the client never sent are never wiped.
          const coerced = toTeamInput(
            { name: params.name, phases: params.phases, agents: params.agents },
            { existingConfig: existing.config },
          );
          const input: LocalTeamInput = {
            ...coerced,
            skipper_prompt: existing.skipper_prompt,
            hooks: existing.hooks,
            config: { ...existing.config, mode },
          };
          return { ok: true, data: connectTeamRow(updateLocalTeam(db, id, input)) };
        }
        if (action === "delete") {
          const id = String(params.id ?? "");
          if (!id) return { ok: false, error: "id is required" };
          return { ok: true, data: { deleted: deleteLocalTeam(db, id) } };
        }
        return { ok: false, error: `Unknown teams action: ${action}` };
      }

      case "agents": {
        // Team library management: headless CLI ("single") + in-process custom
        // agents. Entirely gated on the daemon --experimental flag, like the web
        // UI. Secrets never cross the wire (custom agents redact to hasKey).
        if (action === "list") {
          if (!isExperimental()) {
            return { ok: true, data: { experimental: false, providers: [], single: [], custom: [] } };
          }
          const providers = (listAgentTypes() as Array<{ name: string }>)
            .filter((t) => isAllowedProvider(t.name))
            .map((t) => t.name);
          return {
            ok: true,
            data: {
              experimental: true,
              providers,
              single: listSingleAgents(db).map(connectSingleAgentRow),
              custom: listCustomAgents(db).map(connectCustomAgentRow),
            },
          };
        }
        if (!isExperimental()) {
          return { ok: false, error: "Agents require the daemon --experimental flag" };
        }
        const kind = String(params.kind ?? "");
        switch (action) {
          case "create": {
            if (kind === "single") {
              const input: SingleAgentInput = {
                name: String(params.name ?? ""),
                agent_type: String(params.agent_type ?? ""),
                model: params.model != null ? String(params.model) : undefined,
                instruction: params.instruction != null ? String(params.instruction) : undefined,
                capabilities: stringArray(params.capabilities),
              };
              return { ok: true, data: connectSingleAgentRow(createSingleAgent(db, input)) };
            }
            if (kind === "custom") {
              const input: CustomAgentInput = {
                name: String(params.name ?? ""),
                description: params.description != null ? String(params.description) : "",
                baseUrl: String(params.baseUrl ?? ""),
                modelId: String(params.modelId ?? ""),
                apiKey: params.apiKey != null ? String(params.apiKey) : "",
                headers: {},
                queryParams: {},
                systemPrompt: params.systemPrompt != null ? String(params.systemPrompt) : "",
                enabledTools: [],
                enabledMcpTools: [],
                enabledServerTools: [],
                enabledCustomTools: [],
                enabledSkills: [],
                maxSteps: params.maxSteps != null ? Number(params.maxSteps) : 40,
                temperature: params.temperature != null && params.temperature !== ""
                  ? Number(params.temperature)
                  : null,
                color: params.color != null ? String(params.color) : null,
                character: params.character != null ? String(params.character) : null,
              };
              return { ok: true, data: connectCustomAgentRow(createCustomAgent(db, input)) };
            }
            return { ok: false, error: `Unknown agent kind: ${kind}` };
          }
          case "update": {
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            if (kind === "single") {
              const existing = getSingleAgent(db, id);
              if (!existing) return { ok: false, error: "Agent not found" };
              // State-safety: carry the stored config (slack / slash command /
              // custom tools) and any field the client did not send forward.
              const input: SingleAgentInput = {
                id: existing.id,
                name: params.name != null ? String(params.name) : existing.name,
                agent_type: params.agent_type != null ? String(params.agent_type) : existing.agent_type,
                model: params.model != null ? String(params.model) : existing.model,
                instruction: params.instruction != null ? String(params.instruction) : existing.instruction,
                capabilities: params.capabilities !== undefined ? stringArray(params.capabilities) : existing.capabilities,
                config: existing.config,
              };
              const updated = updateSingleAgent(db, id, input);
              // A headless CLI agent can be a live member of teams; re-project
              // them so the edit propagates without re-saving each team.
              reflattenTeamsReferencingAgentType(db, singleAgentRefType(id));
              return { ok: true, data: connectSingleAgentRow(updated) };
            }
            if (kind === "custom") {
              const existing = getCustomAgent(db, id);
              if (!existing) return { ok: false, error: "Agent not found" };
              // State-safety: preserve headers / queryParams / tool grants, and
              // (via a blank apiKey) the stored key; overlay only sent fields.
              const input: CustomAgentInput = {
                id: existing.id,
                name: params.name != null ? String(params.name) : existing.name,
                description: params.description != null ? String(params.description) : existing.description,
                baseUrl: params.baseUrl != null ? String(params.baseUrl) : existing.baseUrl,
                modelId: params.modelId != null ? String(params.modelId) : existing.modelId,
                apiKey: params.apiKey != null ? String(params.apiKey) : "",
                headers: existing.headers,
                queryParams: existing.queryParams,
                systemPrompt: params.systemPrompt != null ? String(params.systemPrompt) : existing.systemPrompt,
                enabledTools: existing.enabledTools,
                enabledMcpTools: existing.enabledMcpTools,
                enabledServerTools: existing.enabledServerTools,
                enabledCustomTools: existing.enabledCustomTools,
                enabledSkills: existing.enabledSkills,
                maxSteps: params.maxSteps != null ? Number(params.maxSteps) : existing.maxSteps,
                temperature: params.temperature !== undefined
                  ? (params.temperature === null || params.temperature === "" ? null : Number(params.temperature))
                  : existing.temperature,
                color: params.color !== undefined ? (params.color != null ? String(params.color) : null) : existing.color,
                character: params.character !== undefined ? (params.character != null ? String(params.character) : null) : existing.character,
              };
              return { ok: true, data: connectCustomAgentRow(updateCustomAgent(db, id, input)) };
            }
            return { ok: false, error: `Unknown agent kind: ${kind}` };
          }
          case "delete": {
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            if (kind === "single") {
              const referencing = teamsReferencingAgentType(db, singleAgentRefType(id));
              if (referencing.length > 0) {
                return { ok: false, error: `In use by ${referencing.length} team(s): ${referencing.join(", ")}. Remove it from them first.` };
              }
              return { ok: true, data: { deleted: deleteSingleAgent(db, id) } };
            }
            if (kind === "custom") {
              const referencing = teamsReferencingAgentType(db, customAgentTypeName(id));
              if (referencing.length > 0) {
                return { ok: false, error: `In use by ${referencing.length} team(s): ${referencing.join(", ")}. Remove it from them first.` };
              }
              return { ok: true, data: { deleted: deleteCustomAgent(db, id) } };
            }
            return { ok: false, error: `Unknown agent kind: ${kind}` };
          }
          default:
            return { ok: false, error: `Unknown agents action: ${action}` };
        }
      }

      case "recurring": {
        // Recurring task series + their recent runs, for a client-side
        // "Recurring" view. Mirrors the main UI's sidebar run strip.
        if (action === "list") {
          const runsBy = fetchRecentScheduledRuns(db);
          const series = fetchScheduledTaskRows(db).map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description ?? null,
            teamId: s.team_id ?? null,
            teamName: s.team_name ?? null,
            scheduleUnit: s.schedule_unit ?? null,
            scheduleAmount: s.schedule_amount ?? null,
            scheduleMatrix: s.schedule_matrix ?? null,
            status: s.status,
            nextRunAt: s.next_run_at ?? null,
            lastRunAt: s.last_run_at ?? null,
            runs: (runsBy[s.id] ?? []).map((r) => ({
              id: r.id,
              title: r.title,
              status: r.status,
              createdAt: r.created_at,
              completedAt: r.completed_at ?? null,
            })),
          }));
          return { ok: true, data: series };
        }
        if (action === "update") {
          // Edit a recurring series in place, mirroring the create form:
          // title, description, assignee, and exactly one schedule mode
          // (interval / weekly matrix / manual). Phase overrides, slash command
          // and global-store config are preserved untouched (not exposed here).
          const id = String(params.id ?? "");
          const existing = scheduledTaskScheduler.getScheduledTask(id);
          if (!existing) return { ok: false, error: "Recurring task not found" };
          if (existing.status !== "draft" && existing.status !== "approved") {
            return { ok: false, error: `Cannot edit a ${existing.status} recurring task` };
          }

          const title = String(params.title ?? "").trim();
          if (!title) return { ok: false, error: "title is required" };
          const description = params.description != null ? String(params.description) : (existing.description ?? "");

          // Keep the existing team when the client omits it — a recurring series
          // needs a team to stay approvable. An explicit non-empty id replaces it.
          const teamId = params.teamId != null && String(params.teamId) !== ""
            ? String(params.teamId)
            : existing.team_id ?? undefined;

          // Schedule mode is authoritative on edit: exactly one of interval,
          // weekly, or manual (both cleared). Same parsing as tasks/create.
          const unit = params.scheduleUnit != null && String(params.scheduleUnit) !== "" ? String(params.scheduleUnit) : undefined;
          if (unit && unit !== "minutes" && unit !== "hours" && unit !== "days") {
            return { ok: false, error: `Invalid scheduleUnit: ${unit}` };
          }
          const amount = unit ? Number(params.scheduleAmount) : undefined;
          if (unit && (!Number.isFinite(amount) || (amount ?? 0) <= 0)) {
            return { ok: false, error: "scheduleAmount must be a positive number" };
          }
          let matrix: ScheduleMatrix | null = null;
          const rawMatrix = params.scheduleMatrix;
          if (rawMatrix != null && rawMatrix !== "") {
            let parsed: unknown;
            try {
              parsed = typeof rawMatrix === "string" ? JSON.parse(rawMatrix) : rawMatrix;
            } catch {
              return { ok: false, error: "scheduleMatrix must be valid JSON" };
            }
            if (!isValidScheduleMatrix(parsed)) {
              return { ok: false, error: "scheduleMatrix must be a 7x24 array of 0/1 with at least one enabled hour" };
            }
            matrix = parsed;
          }
          if (unit && matrix) {
            return { ok: false, error: "Use either an interval or a weekly schedule, not both" };
          }

          // updateScheduledTask only edits drafts. An approved series is
          // transparently unapproved, edited, then re-approved (which recomputes
          // next_run_at from the new schedule), so the remote edit is one atomic
          // action. On failure the prior approval is restored, so a rejected edit
          // never leaves the series stuck in draft.
          const wasApproved = existing.status === "approved";
          if (wasApproved) scheduledTaskScheduler.unapproveScheduledTask(id);
          try {
            scheduledTaskScheduler.updateScheduledTask(id, {
              title,
              description,
              teamId,
              scheduleUnit: unit ? (unit as "minutes" | "hours" | "days") : null,
              scheduleAmount: unit ? (amount ?? null) : null,
              scheduleMatrix: matrix,
            });
          } catch (err) {
            if (wasApproved) { try { scheduledTaskScheduler.approveScheduledTask(id); } catch { /* leave as draft */ } }
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (wasApproved) {
            try {
              return { ok: true, data: scheduledTaskScheduler.approveScheduledTask(id) };
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          }
          return { ok: true, data: scheduledTaskScheduler.getScheduledTask(id) };
        }
        return { ok: false, error: `Unknown recurring action: ${action}` };
      }

      case "escalations": {
        const status = params.status;
        switch (action) {
          case "list":
            return {
              ok: true,
              data: escalationManager.listEscalations(
                status === "open" || status === "resolved" ? status : undefined,
              ),
            };
          case "read":
            return { ok: true, data: escalationManager.getEscalation(String(params.id ?? "")) };
          case "respond": {
            // Resolve/respond to an open escalation with an operator message.
            // params: { id: string, message: string }
            const id = String(params.id ?? "");
            const message = String(params.message ?? "");
            if (!id) return { ok: false, error: "id is required" };
            if (!message) return { ok: false, error: "message is required" };
            const resolved = await escalationManager.resolveEscalation(id, message);
            return { ok: true, data: resolved };
          }
          default:
            return { ok: false, error: `Unknown escalations action: ${action}` };
        }
      }

      case "reviews": {
        switch (action) {
          case "list":
            return { ok: true, data: taskScheduler.listTasks().filter((t) => t.needs_review) };
          case "read":
            return { ok: true, data: taskScheduler.getTask(String(params.id ?? "")) };
          case "approve": {
            // Approve a pending phase review and advance the phase.
            // params: { taskId: string, message?: string }
            const taskId = String(params.taskId ?? params.id ?? "");
            if (!taskId) return { ok: false, error: "taskId is required" };
            const note = params.message != null ? String(params.message) : undefined;
            await phaseManager.approveReview(taskId, note);
            return { ok: true, data: { taskId, approved: true } };
          }
          case "reject": {
            // Reject a pending phase review and regress the phase.
            // params: { taskId: string, message?: string }
            const taskId = String(params.taskId ?? params.id ?? "");
            if (!taskId) return { ok: false, error: "taskId is required" };
            const reason = params.message != null ? String(params.message) : undefined;
            await phaseManager.rejectReview(taskId, reason);
            return { ok: true, data: { taskId, rejected: true } };
          }
          default:
            return { ok: false, error: `Unknown reviews action: ${action}` };
        }
      }

      case "notes": {
        // Support both "taskId" and "id" param names for robustness.
        const taskId = String(params.taskId ?? params.id ?? "");
        if (action === "create") {
          const content = String(params.content ?? "").trim();
          if (!taskId) return { ok: false, error: "taskId is required" };
          if (!content) return { ok: false, error: "content is required" };
          const task = taskScheduler.getTask(taskId);
          if (!task) return { ok: false, error: "Task not found" };

          // Find a valid agent_id: use the team entrypoint to satisfy FK
          // constraints in monolith mode; 'user' is fine in split-mode runtime.
          let agentId = "user";
          try {
            if (task.team_id) {
              const teamRow = db
                .prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?")
                .get(task.team_id) as { entrypoint_agent_id: string | null } | null;
              if (teamRow?.entrypoint_agent_id) agentId = teamRow.entrypoint_agent_id;
            }
          } catch { /* ignore — fallback to 'user' */ }

          const noteId = crypto.randomUUID();
          try {
            db.prepare(
              "INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, 'user')",
            ).run(noteId, taskId, agentId, content);
          } catch (err: unknown) {
            return { ok: false, error: err instanceof Error ? err.message : "Internal error" };
          }

          eventBus.emit("task:note_added", { noteId, taskId, agentId, content });

          const created = fetchTaskNotes(db, taskId).find((n) => n.id === noteId);
          return {
            ok: true,
            data: created
              ? {
                  id: created.id,
                  taskId: created.task_id,
                  agentName: created.agent_name ?? null,
                  source: created.source ?? null,
                  content: created.content,
                  createdAt: created.created_at,
                }
              : { id: noteId, taskId, agentName: null, source: "user", content, createdAt: null },
          };
        }
        // Soft-delete / restore a note. Deleted notes stay visible (annotated)
        // but are excluded from agent context. Mirrors POST /api/tasks/:id/notes/:noteId/{delete,restore}.
        if (action === "delete" || action === "restore") {
          const noteId = String(params.noteId ?? "");
          if (!taskId) return { ok: false, error: "taskId is required" };
          if (!noteId) return { ok: false, error: "noteId is required" };
          const deletedAt = action === "delete" ? "strftime('%Y-%m-%d %H:%M:%f','now')" : "NULL";
          const result = db
            .prepare(`UPDATE task_notes SET deleted_at = ${deletedAt} WHERE id = ? AND task_id = ?`)
            .run(noteId, taskId);
          if (result.changes === 0) return { ok: false, error: "note not found" };
          const n = fetchTaskNotes(db, taskId).find((x) => x.id === noteId);
          return {
            ok: true,
            data: n
              ? {
                  id: n.id,
                  taskId: n.task_id,
                  agentName: n.agent_name ?? null,
                  source: n.source ?? null,
                  content: n.content,
                  createdAt: n.created_at,
                  deletedAt: n.deleted_at ?? null,
                }
              : null,
          };
        }
        if (action !== "list") return { ok: false, error: `Unknown notes action: ${action}` };
        const raw = fetchTaskNotes(db, taskId);
        return {
          ok: true,
          data: raw.map((n) => ({
            id: n.id,
            taskId: n.task_id,
            agentName: n.agent_name ?? null,
            source: n.source ?? null,
            content: n.content,
            createdAt: n.created_at,
            deletedAt: n.deleted_at ?? null,
          })),
        };
      }

      case "messages": {
        if (action !== "list") return { ok: false, error: `Unknown messages action: ${action}` };
        // Operator messages (agent → human progress updates), newest-first.
        // Support both "taskId" and "id" param names for robustness.
        const taskId = String(params.taskId ?? params.id ?? "");
        if (!taskId) return { ok: false, error: "taskId is required" };
        const rows = new MessageManager(db).listMessages(taskId);
        return {
          ok: true,
          data: rows.map((m) => ({
            id: m.id,
            taskId: m.task_id,
            agentName: m.agent_name ?? null,
            content: m.content,
            format: m.format ?? null,
            createdAt: m.created_at,
          })),
        };
      }

      case "artifacts": {
        if (action === "read") {
          // Fetch one artifact WITH body.
          // params: { taskId, name, version? } — version omitted → latest.
          // Also accepts { id } to fetch by primary key.
          const { artifactManager } = deps;
          if (params.id) {
            const artifact = artifactManager.getArtifactById(String(params.id));
            if (!artifact) return { ok: false, error: "Artifact not found" };
            return {
              ok: true,
              data: {
                id: artifact.id,
                taskId: artifact.task_id,
                name: artifact.name,
                kind: artifact.kind,
                version: artifact.version,
                description: artifact.description ?? null,
                format: artifact.format ?? null,
                body: artifact.body,
                createdAt: artifact.created_at,
                publishedAt: artifact.published_at,
                publicUrl: artifact.published_at ? getPublicArtifactUrl(db, artifact) : null,
              },
            };
          }
          const taskId = String(params.taskId ?? "");
          const name = String(params.name ?? "");
          if (!taskId || !name) return { ok: false, error: "taskId and name (or id) are required" };
          const version = params.version != null ? (Number(params.version) as "latest" | number) : "latest";
          const artifact = artifactManager.getArtifact(taskId, name, version);
          if (!artifact) return { ok: false, error: "Artifact not found" };
          return {
            ok: true,
            data: {
              id: artifact.id,
              taskId: artifact.task_id,
              name: artifact.name,
              kind: artifact.kind,
              version: artifact.version,
              description: artifact.description ?? null,
              format: artifact.format ?? null,
              body: artifact.body,
              createdAt: artifact.created_at,
              publishedAt: artifact.published_at,
              publicUrl: artifact.published_at ? getPublicArtifactUrl(db, artifact) : null,
            },
          };
        }
        if (action === "publish" || action === "unpublish") {
          // params: { id } or { taskId, name, version? } — version omitted → latest.
          const { artifactManager } = deps;
          let target = params.id ? artifactManager.getArtifactById(String(params.id)) : null;
          if (!target) {
            const taskId = String(params.taskId ?? "");
            const name = String(params.name ?? "");
            if (!taskId || !name) return { ok: false, error: "id, or taskId and name, are required" };
            const version = params.version != null ? (Number(params.version) as "latest" | number) : "latest";
            target = artifactManager.getArtifact(taskId, name, version);
          }
          if (!target) return { ok: false, error: "Artifact not found" };
          const updated = action === "publish"
            ? artifactManager.publishArtifact(target.id)
            : artifactManager.unpublishArtifact(target.id);
          if (!updated) return { ok: false, error: "Artifact not found" };
          return {
            ok: true,
            data: {
              id: updated.id,
              taskId: updated.task_id,
              name: updated.name,
              kind: updated.kind,
              version: updated.version,
              description: updated.description ?? null,
              format: updated.format ?? null,
              createdAt: updated.created_at,
              publishedAt: updated.published_at,
              publicUrl: updated.published_at ? getPublicArtifactUrl(db, updated) : null,
            },
          };
        }
        if (action === "read-published") {
          // Relay target for the integrator's unauthenticated public route
          // (GET /p/:guid/:artifactId?key=...). Authed by the per-version
          // publish key only; one opaque error for wrong id, wrong key, or
          // unpublished so the public route cannot enumerate artifacts.
          const { artifactManager } = deps;
          const artifact = artifactManager.getPublishedArtifact(String(params.id ?? ""), String(params.key ?? ""));
          if (!artifact) return { ok: false, error: "Not found or not published" };
          return {
            ok: true,
            data: {
              name: artifact.name,
              kind: artifact.kind,
              version: artifact.version,
              body: artifact.body,
              // Prefer the stored format; fall back to the heuristic for legacy
              // rows created before the format column existed.
              contentType: (artifact.format ? artifact.format === "html" : looksLikeHtml(artifact.body))
                ? "text/html; charset=utf-8"
                : "text/plain; charset=utf-8",
            },
          };
        }
        if (action !== "list") return { ok: false, error: `Unknown artifacts action: ${action}` };
        // Support both "taskId" and "id" param names for robustness.
        const taskId = String(params.taskId ?? params.id ?? "");
        const raw = fetchTaskArtifacts(db, taskId);
        return {
          ok: true,
          data: raw.map((a) => ({
            id: a.id,
            name: a.name,
            kind: a.kind,
            version: a.version,
            description: a.description ?? null,
            format: a.format ?? null,
            createdAt: a.created_at,
          })),
        };
      }

      case "outputs": {
        if (action !== "list") return { ok: false, error: `Unknown outputs action: ${action}` };
        // Last N agent output lines for a task, newest-first.
        // Source: terminal_outputs joined through agent_instances (task_id).
        // params: { taskId, limit? } — limit capped at 100, default 10.
        const taskId = String(params.taskId ?? params.id ?? "");
        if (!taskId) return { ok: false, error: "taskId is required" };
        const limit = Math.min(Number(params.limit) || 10, 100);
        type OutputRow = { id: number; agent_name: string | null; stream: string; data: string; created_at: string };
        const rows = db
          .prepare(
            `SELECT tout.id, a.name AS agent_name, tout.stream, tout.data, tout.created_at
             FROM terminal_outputs tout
             LEFT JOIN agent_instances ai ON ai.id = tout.agent_id
             LEFT JOIN agents a ON a.id = ai.template_agent_id
             WHERE ai.task_id = ?
             ORDER BY tout.created_at DESC, tout.id DESC
             LIMIT ?`,
          )
          .all(taskId, limit) as OutputRow[];
        return {
          ok: true,
          data: rows.map((r) => ({
            id: r.id,
            agentName: r.agent_name ?? null,
            stream: r.stream,
            content: r.data,
            createdAt: r.created_at,
          })),
        };
      }

      case "webhooks": {
        if (action !== "trigger") return { ok: false, error: `Unknown webhooks action: ${action}` };
        // Relay target for the integrator's public webhook route
        // (POST /wh/:gid/:scheduledTaskId?key=...). Auth is possession of the
        // per-task webhook_key, validated HERE - the integrator only relays.
        // One opaque error for unknown id / disabled / wrong key so the public
        // route cannot enumerate scheduled tasks.
        const id = String(params.id ?? "");
        const key = String(params.key ?? "");
        const scheduled = id ? scheduledTaskScheduler.getScheduledTask(id) : null;
        if (!scheduled?.webhook_key || !key) return { ok: false, error: "Not found" };
        const expected = Buffer.from(scheduled.webhook_key);
        const provided = Buffer.from(key);
        if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
          return { ok: false, error: "Not found" };
        }
        // Key holder is semi-trusted from here: real errors (e.g. not approved).
        const payload = params.payload;
        const runInput =
          payload == null
            ? undefined
            : typeof payload === "string"
              ? payload
              : JSON.stringify(payload);
        // Per-task leading-edge debounce: a webhook inside the window is
        // ignored and restamps the window, so only a burst's first webhook
        // runs. Cron and manual runs never consume the window.
        const fired = scheduledTaskScheduler.runWebhookTask(
          id,
          taskScheduler,
          runInput ? `Webhook payload:\n${runInput.slice(0, 16_384)}` : undefined,
        );
        if (fired.debounced) {
          return { ok: false, error: "Debounced: ignored, within the debounce window of the previous webhook" };
        }
        return { ok: true, data: { triggered: true, taskId: fired.task.id, title: fired.task.title } };
      }

      case "state": {
        if (action !== "snapshot") return { ok: false, error: `Unknown state action: ${action}` };
        // One-shot full state for the integrator web app: fetched on every WS
        // (re)connect, after which fat events keep its local store patched.
        // Projections only - no result/orchestration_state/artifact bodies.
        const tasks = snapshotTasks(db);
        const escalations = snapshotOpenEscalations(db);
        const reviews = tasks.filter((t) => t.needs_review);
        const snapshot: StateSnapshot = {
          protocolVersion: CONNECT_PROTOCOL_VERSION,
          ts: new Date().toISOString(),
          tasks,
          escalations,
          reviews,
          counts: { openEscalations: escalations.length, pendingReviews: reviews.length },
          titleGeneratorConfigured: isTaskTitleGeneratorConfigured(db),
        };
        return { ok: true, data: snapshot };
      }

      case "realtime": {
        // Relay target for a Skipper Connect consumer streaming mic audio into a
        // real_time task. Participates in the same single-writer recording lock as
        // the local web UI. params: { taskId, clientId, label?, data?, format?, ... }.
        const taskId = String(params.taskId ?? params.id ?? "");
        if (!taskId) return { ok: false, error: "taskId is required" };
        // Only real_time tasks accept audio; opaque "Not found" otherwise.
        const taskRow = db.prepare("SELECT task_type FROM tasks WHERE id = ?").get(taskId) as { task_type: string } | null;
        if (!taskRow || taskRow.task_type !== "real_time") return { ok: false, error: "Not found" };

        // Reopen a completed/failed real-time task: back to running + resume the
        // session, mirroring the web's POST /api/realtime-tasks/:id/unarchive.
        if (action === "reopen") {
          const statusRow = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
          if (!statusRow) return { ok: false, error: "Not found" };
          if (statusRow.status !== "completed" && statusRow.status !== "failed") {
            return { ok: false, error: "Only completed or failed real-time tasks can be reopened" };
          }
          db.prepare(
            "UPDATE tasks SET status = 'running', result = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?",
          ).run(taskId);
          eventBus.emit("task:state_changed", { taskId, previousStatus: statusRow.status, newStatus: "running" });
          if (!deps.realtimeSessionManager.isSessionActive(taskId)) {
            deps.realtimeSessionManager.resumeSession(taskId);
          }
          return { ok: true, data: { reopened: true } };
        }

        const clientId = String(params.clientId ?? "");
        if (!clientId) return { ok: false, error: "clientId is required" };
        const sourceId = `connect:${clientId}`;
        const label = String(params.label ?? "connect");
        const mgr = deps.realtimeSessionManager;

        switch (action) {
          case "acquire": {
            const result = await mgr.acquireRecording(taskId, { id: sourceId, label });
            if (!result.ok) {
              return {
                ok: false,
                error: result.error === "RECORDING_IN_USE"
                  ? `RECORDING_IN_USE: recording in use by ${result.ownerLabel}`
                  : result.error,
              };
            }
            return { ok: true, data: { state: result.state } };
          }
          case "ingest": {
            const data = String(params.data ?? "");
            if (!data) return { ok: false, error: "data is required" };
            const format = String(params.format ?? "webm");
            const ts = params.timestamp as string | undefined;
            // A text input lands in the timeline immediately (no recording lock,
            // no transcription) — the same path the web composer uses.
            if (format === "text") {
              await mgr.ingestInput(taskId, {
                sourceType: "text",
                contentBody: data,
                chunkStartAt: ts,
                chunkEndAt: ts,
              });
              return { ok: true, data: { accepted: true } };
            }
            await mgr.ingestInput(
              taskId,
              {
                sourceType: "audio",
                contentType: `audio/${format}`,
                contentBody: data,
                chunkStartAt: ts,
                chunkEndAt: ts,
                metadata: { format, overlap_seconds: params.overlap_seconds ?? 0 },
              },
              sourceId,
            );
            return { ok: true, data: { accepted: true } };
          }
          case "release": {
            // Fire-and-forget: release drains + transcribes and can exceed the
            // relay's 20s timeout. Ack immediately; completion arrives as a
            // realtime:audio_lock event.
            void mgr.releaseRecording(taskId, sourceId).catch(() => {});
            return { ok: true, data: { released: true } };
          }
          default:
            return { ok: false, error: `Unknown realtime action: ${action}` };
        }
      }

      default:
        return { ok: false, error: `Unknown resource: ${resource}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
