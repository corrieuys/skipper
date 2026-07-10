import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { dictateButton } from "../fragments/dictate-button.fragment";
import { renderScheduleMatrixEditor } from "../atoms/schedule-matrix";
import { isExperimental } from "../../config/feature-flags";
import type { TeamPhase } from "../../config/store";
import type { ConsensusConfig } from "../../teams/manager";

export interface TaskCreateTeam {
  id: string;
  name: string;
}

export interface TaskCreateViewModel {
  teams: TaskCreateTeam[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

export type TaskPhaseOverride = { prompt?: string; review?: boolean; consensus?: ConsensusConfig | null };

// Per-task phase-override form, shown on the task form once a team is selected.
// Emits suffixed field names (phasePromptMode_<safe>, phaseReviewOverride_<safe>, …)
// keyed by a sanitized phase name; the create/update routes (src/routes/tasks.ts) map
// the safe name back to the real phase name and write task_config.phase_overrides.
// Scope: per-phase prompt + review gate + (experimental) consensus. The whole form
// is collapsed by default (most tasks won't override) to keep the create form short.
export function taskPhaseConfigFragment(
  teamPhases: TeamPhase[],
  existingOverrides: Record<string, TaskPhaseOverride>,
): string {
  if (teamPhases.length === 0) return `<div></div>`;

  let anyOverride = false;

  const blocks = teamPhases.map((phase) => {
    const safe = phase.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const existing = existingOverrides[phase.name];

    const hasPromptOverride = typeof existing?.prompt === "string" && existing.prompt.trim().length > 0;
    const promptValue = hasPromptOverride ? existing!.prompt! : (phase.prompt ?? "");
    if (hasPromptOverride) anyOverride = true;

    let reviewValue = "";
    if (existing?.review === true) reviewValue = "true";
    else if (existing?.review === false) reviewValue = "false";
    if (reviewValue !== "") anyOverride = true;

    const baseReviewText = (phase.review ?? false) ? "enabled" : "disabled";

    let consensusMode = "";
    let consensusConfig: ConsensusConfig | null = null;
    if (existing && "consensus" in existing) {
      if (existing.consensus === null) { consensusMode = "disabled"; anyOverride = true; }
      else if (existing.consensus) { consensusMode = "override"; consensusConfig = existing.consensus; anyOverride = true; }
    }
    const showConsensusConfig = consensusMode === "override";

    let baseConsensusText = "No parallel execution";
    if (phase.consensus) {
      const c = phase.consensus;
      baseConsensusText = `Parallel: ${c.agent_count} agents, ${c.strategy}, worktree:${c.worktree ? "yes" : "no"}`;
    }

    return `
    <div class="sk-form-group" style="border:1px solid var(--sk-border);border-radius:6px;padding:var(--sk-space-3);margin-bottom:var(--sk-space-3);">
      <h4 style="margin:0 0 var(--sk-space-3);">${escapeHtml(phase.name)}</h4>

      <div style="margin-bottom:var(--sk-space-3);">
        <label class="sk-label sk-text-xs">Phase prompt override:</label>
        <select name="phasePromptMode_${safe}" class="sk-select"
                onchange="toggleTaskPromptOverride(this, '${safe}')">
          <option value=""${hasPromptOverride ? "" : " selected"}>Inherit from team</option>
          <option value="override"${hasPromptOverride ? " selected" : ""}>Override for this task</option>
        </select>
        <div id="task-prompt-config-${safe}" style="margin-top:var(--sk-space-2);display:${hasPromptOverride ? "block" : "none"};">
          <textarea name="phasePromptOverride_${safe}" class="sk-textarea" rows="6"
                    placeholder="Full prompt for this phase (this task only)">${escapeHtml(promptValue)}</textarea>
        </div>
      </div>

      <div style="margin-bottom:${isExperimental() ? "var(--sk-space-3)" : "0"};">
        <p class="sk-text-xs" style="color:var(--sk-text-muted);margin:0 0 var(--sk-space-1);">Base team setting: Review gate <strong>${baseReviewText}</strong></p>
        <label class="sk-label sk-text-xs">Review gate override:</label>
        <select name="phaseReviewOverride_${safe}" class="sk-select">
          <option value=""${reviewValue === "" ? " selected" : ""}>Inherit from team</option>
          <option value="true"${reviewValue === "true" ? " selected" : ""}>Enable review</option>
          <option value="false"${reviewValue === "false" ? " selected" : ""}>Disable review</option>
        </select>
      </div>

      ${isExperimental() ? `<div>
        <p class="sk-text-xs" style="color:var(--sk-text-muted);margin:0 0 var(--sk-space-1);">Base team setting: ${escapeHtml(baseConsensusText)}</p>
        <label class="sk-label sk-text-xs">Parallel/consolidation override:</label>
        <select name="phaseConsensusMode_${safe}" class="sk-select"
                onchange="toggleTaskConsensusOverride(this, '${safe}')">
          <option value=""${consensusMode === "" ? " selected" : ""}>Inherit from team</option>
          <option value="override"${consensusMode === "override" ? " selected" : ""}>Override</option>
          <option value="disabled"${consensusMode === "disabled" ? " selected" : ""}>Disable parallel execution</option>
        </select>

        <div id="task-consensus-config-${safe}" style="margin-top:var(--sk-space-2);display:${showConsensusConfig ? "block" : "none"};">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sk-space-2);margin-bottom:var(--sk-space-2);">
            <label class="sk-label sk-text-xs">Agent count:
              <input type="number" name="phaseConsensusAgentCount_${safe}" class="sk-input"
                     value="${consensusConfig?.agent_count ?? 2}" min="1">
            </label>
            <label class="sk-label sk-text-xs">Strategy:
              <select name="phaseConsensusStrategy_${safe}" class="sk-select">
                <option value="best_of"${(!consensusConfig || consensusConfig.strategy === "best_of") ? " selected" : ""}>Best of N</option>
                <option value="merge"${consensusConfig?.strategy === "merge" ? " selected" : ""}>Merge</option>
              </select>
            </label>
          </div>
          <label style="display:flex;align-items:center;gap:var(--sk-space-2);margin-bottom:var(--sk-space-2);cursor:pointer;">
            <input type="checkbox" name="phaseConsensusWorktree_${safe}" value="on"${consensusConfig?.worktree ? " checked" : ""}>
            Use worktree
          </label>
          <label class="sk-label sk-text-xs">Reviewer agent ID (optional):
            <input type="text" name="phaseConsensusReviewerAgentId_${safe}" class="sk-input"
                   value="${escapeHtml(consensusConfig?.reviewer_agent_id ?? "")}">
          </label>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");

  return `<div class="sk-form-group">
    <details${anyOverride ? " open" : ""} style="border:1px solid var(--sk-border);border-radius:6px;padding:var(--sk-space-2) var(--sk-space-3);">
      <summary style="cursor:pointer;font-weight:600;">Phase overrides <span style="font-weight:normal;font-size:0.72rem;color:var(--muted);">(optional — override team phase settings for this task only)</span></summary>
      <div style="margin-top:var(--sk-space-3);">
        ${blocks}
      </div>
    </details>
    <script>
      function toggleTaskPromptOverride(select, safe) {
        var cfg = document.getElementById('task-prompt-config-' + safe);
        if (cfg) cfg.style.display = select.value === 'override' ? 'block' : 'none';
      }
      function toggleTaskConsensusOverride(select, safe) {
        var cfg = document.getElementById('task-consensus-config-' + safe);
        if (cfg) cfg.style.display = select.value === 'override' ? 'block' : 'none';
      }
    </script>
  </div>`;
}

export function taskCreatePage(vm: TaskCreateViewModel): string {
  // The team field is rendered server-side via the slot endpoint, which reacts to
  // taskType changes. `vm.teams` is no longer used here directly.
  void vm.teams;

  return v2layout("New Task", `
    ${navbar({ currentPath: "/tasks", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container" style="max-width: 700px;">
      <div class="sk-page-header">
        <a href="/" class="sk-page-header__back">&larr; Dashboard</a>
        <h1 class="sk-page-header__title">Create Task</h1>
      </div>

      <div class="sk-panel">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Task Details</span>
        </div>
        <div class="sk-panel__body">
          <form hx-post="/api/tasks" hx-target="body" hx-swap="innerHTML">
            <div class="sk-form-group">
              <label class="sk-label">Title</label>
              <input type="text" name="title" class="sk-input" placeholder="What needs to be done?" required autofocus>
            </div>
            <div class="sk-form-group">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--sk-space-2);">
                <label class="sk-label" style="margin-bottom:0;">Description</label>
                ${dictateButton("textarea[name=description]")}
              </div>
              <textarea name="description" class="sk-textarea" rows="6" placeholder="Context, constraints, acceptance criteria..."></textarea>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Working Directory <span style="font-weight:normal;font-size:0.72rem;color:var(--muted);">(optional — Skipper will discover from the task description if blank)</span></label>
              <input type="text" name="workingDirectory" class="sk-input" placeholder="/path/to/repo (optional)">
            </div>
            <div class="sk-form-row">
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Task Type</label>
                <select name="taskType" class="sk-select" onchange="toggleScheduleFields(this)">
                  <option value="standard" selected>Standard</option>
                  ${isExperimental() ? `<option value="real_time">Real-Time</option>` : ""}
                  ${isExperimental() ? `<option value="recurring">Recurring</option>` : ""}
                </select>
              </div>
              <div id="task-form-team-slot" style="display:contents;"
                hx-get="/fragments/task-form/team?taskType=standard&amp;context=full"
                hx-trigger="load, change from:[name=taskType]"
                hx-include="[name=taskType]"
                hx-target="this"
                hx-swap="outerHTML"></div>
            </div>
            <div id="phase-config-slot"
              hx-get="/fragments/task-form/phase-config"
              hx-trigger="change[target.name=='teamId'] from:document"
              hx-include="[name='teamId']"
              hx-target="this"
              hx-swap="innerHTML"></div>
            ${isExperimental() ? `<div id="schedule-fields" style="display:none;">
              <div class="sk-form-group">
                <label class="sk-label">Schedule</label>
                <select name="scheduleMode" class="sk-select" style="max-width:220px;">
                  <option value="" selected>None (manual only)</option>
                  <option value="interval">Fixed interval</option>
                  <option value="weekly">Weekly schedule</option>
                </select>
              </div>
              <div id="schedule-interval-fields" style="display:none;">
                <div class="sk-form-row" style="gap:var(--sk-space-3);">
                  <div class="sk-form-group" style="flex:1;">
                    <label class="sk-label">Run every</label>
                    <input type="number" name="scheduleAmount" class="sk-input" min="1" placeholder="e.g. 1" style="max-width:100px;" disabled>
                  </div>
                  <div class="sk-form-group" style="flex:1;">
                    <label class="sk-label">Unit</label>
                    <select name="scheduleUnit" class="sk-select" disabled>
                      <option value="minutes">Minutes</option>
                      <option value="hours" selected>Hours</option>
                      <option value="days">Days</option>
                    </select>
                  </div>
                </div>
              </div>
              <div id="schedule-matrix-fields" style="display:none;">
                <div class="sk-form-group">
                  <label class="sk-label">Weekly schedule</label>
                  ${renderScheduleMatrixEditor(null, { inputDisabled: true })}
                </div>
              </div>
              <div class="sk-muted sk-text-xs" style="margin-top:calc(-1 * var(--sk-space-2)); margin-bottom:var(--sk-space-1);">
                Optional. Leave the schedule as "None" to run this recurring task only manually via Run Now.
              </div>
              <div class="sk-form-group">
                <label class="sk-label">Global Store Instructions</label>
                <textarea name="globalStoreInstructions" class="sk-textarea" rows="3"
                  placeholder="Optional. Key names and payload structure for cross-run state, e.g.: store the last processed timestamp under key 'report-window' and resume from it next run."></textarea>
                <div class="sk-muted sk-text-xs" style="margin-top:var(--sk-space-1);">
                  Injected into every run's prompt; authorizes Skipper to use the global store for state shared across runs.
                </div>
              </div>
            </div>
            <script>
              function toggleScheduleFields(sel) {
                var f = document.getElementById('schedule-fields');
                if (f) f.style.display = sel.value === 'recurring' ? 'block' : 'none';
              }
            </script>` : ""}
            <div style="display:flex; gap:var(--sk-space-3); margin-top:var(--sk-space-4);">
              <input type="hidden" name="autoApprove" value="0">
              <button type="submit" class="sk-btn sk-btn--primary" onclick="this.form.querySelector('[name=autoApprove]').value='1';">Create &amp; Approve</button>
              <button type="submit" class="sk-btn sk-btn--sm">Save as Draft</button>
              <a href="/" class="sk-btn sk-btn--link" style="margin-left:auto;">Cancel</a>
            </div>
          </form>
        </div>
      </div>
    </div>
  `, "/tasks");
}
