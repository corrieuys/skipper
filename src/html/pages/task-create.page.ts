import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { dictateButton } from "../fragments/dictate-button.fragment";
import { renderScheduleMatrixEditor } from "../atoms/schedule-matrix";
import { isExperimental } from "../../config/feature-flags";
import { iconIdentityPicker, iconIdentityPickerScript } from "../atoms/icon-identity-picker";
import type { TeamPhase } from "../../config/store";

export interface TaskCreateTeam {
  id: string;
  name: string;
}

export interface TaskCreateViewModel {
  teams: TaskCreateTeam[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
  /** When true the title may be left blank (the daemon generates one). */
  titleGeneratorConfigured: boolean;
}

export type TaskPhaseOverride = { prompt?: string; review?: boolean };

// Per-task phase-override form, shown on the task form once a team is selected.
// Emits suffixed field names (phasePromptMode_<safe>, phaseReviewOverride_<safe>, …)
// keyed by a sanitized phase name; the create/update routes (src/routes/tasks.ts) map
// the safe name back to the real phase name and write task_config.phase_overrides.
// Scope: per-phase prompt + review gate. The whole form is collapsed by default
// (most tasks won't override) to keep the create form short.
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

      <div>
        <p class="sk-text-xs" style="color:var(--sk-text-muted);margin:0 0 var(--sk-space-1);">Base team setting: Review gate <strong>${baseReviewText}</strong></p>
        <label class="sk-label sk-text-xs">Review gate override:</label>
        <select name="phaseReviewOverride_${safe}" class="sk-select">
          <option value=""${reviewValue === "" ? " selected" : ""}>Inherit from team</option>
          <option value="true"${reviewValue === "true" ? " selected" : ""}>Enable review</option>
          <option value="false"${reviewValue === "false" ? " selected" : ""}>Disable review</option>
        </select>
      </div>
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
    </script>
  </div>`;
}

export function taskCreatePage(vm: TaskCreateViewModel, selectedTeamId = ""): string {
  // The team field is rendered server-side via the slot endpoint, which reacts to
  // taskType changes. `vm.teams` is no longer used here directly.
  void vm.teams;

  // A sidebar "+" opens this page with ?team=<id>; forward it to the slot so the
  // picker pre-selects that team/agent. The fragment already honours selectedTeamId.
  const teamParam = selectedTeamId ? `&amp;selectedTeamId=${encodeURIComponent(selectedTeamId)}` : "";
  const titleRequired = vm.titleGeneratorConfigured ? "" : " required";
  const titlePlaceholder = vm.titleGeneratorConfigured
    ? "Optional, a title will be generated"
    : "What needs to be done?";

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
              <input type="text" name="title" class="sk-input" placeholder="${titlePlaceholder}"${titleRequired} autofocus>
            </div>
            <div class="sk-form-group">
              <details class="sk-collapse-field">
                <summary class="sk-label" style="cursor:pointer;list-style:none;">
                  <span class="sk-collapse-field__caret">&#x25B6;</span> Icon
                  <span style="font-weight:normal;font-size:0.72rem;color:var(--muted);">(optional — shown in the sidebar and lists)</span>
                </summary>
                <div style="margin-top:var(--sk-space-2);">${iconIdentityPicker({ nameIcon: "icon", nameColor: "iconColor" })}</div>
              </details>
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
            <div class="sk-form-grid">
              <div class="sk-form-group">
                <label class="sk-label">Schedule</label>
                <select id="task-create-schedule-kind" class="sk-select" onchange="toggleScheduleFields(this)">
                  <option value="once" selected>Run once</option>
                  <option value="recurring">Recurring</option>
                </select>
                <!-- The create route branches on taskType=recurring; the JS below
                     mirrors the Recurring pick into this hidden field. -->
                <input type="hidden" name="taskType" id="task-create-task-type" value="">
              </div>
              <div id="task-form-team-slot" style="display:contents;"
                hx-get="/fragments/task-form/team?context=full${teamParam}"
                hx-trigger="load"
                hx-target="this"
                hx-swap="outerHTML"></div>
            </div>
            <div class="sk-form-group">
              <label class="sk-checkbox sk-checkbox--field">
                <input type="checkbox" id="task-create-autopilot" checked onchange="syncTaskCreateMode(this)">
                <span class="sk-checkbox__toggle"></span>
                <span class="sk-checkbox__label">Autopilot
                  <span class="sk-form-help">On: the team drives the task to the end of its phases. Off: the task waits for your input between turns.</span>
                </span>
              </label>
              <!-- The team slot and create route read the mode field; the checkbox
                   mirrors into this hidden input (workflow = autopilot on). -->
              <input type="hidden" name="mode" id="task-create-mode" value="workflow">
            </div>
            ${isExperimental() ? `
            <div class="sk-form-group">
              <label class="sk-checkbox sk-checkbox--field">
                <input type="checkbox" name="memoryEnabled" value="1">
                <span class="sk-checkbox__toggle"></span>
                <span class="sk-checkbox__label">Memory
                  <span class="sk-form-help">Keep a searchable memory of your input, audio summaries, agent messages, and notes that every agent on the task can query.</span>
                </span>
              </label>
            </div>` : ""}
            <div class="sk-form-group">
              <details class="sk-collapse-field">
                <summary class="sk-label" style="cursor:pointer;list-style:none;">
                  <span class="sk-collapse-field__caret">&#x25B6;</span> Audio recording
                  <span style="font-weight:normal;font-size:0.72rem;color:var(--muted);">(optional)</span>
                </summary>
                <span class="sk-form-help" style="margin:var(--sk-space-1) 0 var(--sk-space-3);">Per-task recording settings. Blank fields use the Real-time transcription defaults on the config page.</span>
                <div class="sk-form-grid">
                  <div class="sk-form-group">
                    <label class="sk-label" for="task-create-summary">Transcript summary</label>
                    <select id="task-create-summary" name="summaryEnabled" class="sk-select">
                      <option value="" selected>Use global setting</option>
                      <option value="true">On: summarize each audio chunk</option>
                      <option value="false">Off: raw transcript to the timeline</option>
                    </select>
                  </div>
                  <div class="sk-form-group">
                    <label class="sk-label" for="task-create-window">Chunk seconds</label>
                    <input type="number" id="task-create-window" name="windowSeconds" class="sk-input" min="5" max="600" placeholder="global (5 to 600)">
                  </div>
                </div>
              </details>
            </div>
            <div id="phase-config-slot"
              hx-get="/fragments/task-form/phase-config"
              hx-trigger="change[target.name=='teamId'] from:document"
              hx-include="[name='teamId']"
              hx-target="this"
              hx-swap="innerHTML"></div>
            <div id="schedule-fields" style="display:none;">
              ${isExperimental() ? `
              <div class="sk-form-grid">
                <div class="sk-form-group">
                  <label class="sk-label">Memory across runs</label>
                  <select name="memoryMode" class="sk-select">
                    <option value="off" selected>Off</option>
                    <option value="run">Per run (each run its own memory)</option>
                    <option value="shared">Shared across runs</option>
                  </select>
                  <span class="sk-form-help">Shared: every run can query what earlier runs recorded. Replaces the Memory toggle for recurring tasks.</span>
                </div>
                <div class="sk-form-group">
                  <label class="sk-label">Keep entries for (days)</label>
                  <input type="number" name="memoryRetentionDays" class="sk-input" min="0" step="1" value="0" placeholder="0 = indefinitely">
                  <span class="sk-form-help">Shared memory only. Older entries are dropped when new ones are written. 0 keeps them indefinitely.</span>
                </div>
              </div>` : ""}
              <div class="sk-form-group">
                <label class="sk-label">Cadence</label>
                <select name="scheduleMode" class="sk-select" style="max-width:220px;">
                  <option value="" selected>None (manual only)</option>
                  <option value="interval">Fixed interval</option>
                  <option value="weekly">Weekly schedule</option>
                </select>
                <span class="sk-form-help">Optional. Leave it as None to run this recurring task only by hand with Run Now.</span>
              </div>
              <div id="schedule-interval-fields" style="display:none;">
                <div class="sk-form-grid">
                  <div class="sk-form-group">
                    <label class="sk-label">Run every</label>
                    <input type="number" name="scheduleAmount" class="sk-input" min="1" placeholder="e.g. 1" disabled>
                  </div>
                  <div class="sk-form-group">
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
              <div class="sk-form-group">
                <label class="sk-label">Global Store Instructions</label>
                <textarea name="globalStoreInstructions" class="sk-textarea" rows="3"
                  placeholder="Optional. Key names and payload structure for cross-run state, e.g.: store the last processed timestamp under key 'report-window' and resume from it next run."></textarea>
                <span class="sk-form-help">Injected into every run's prompt; authorizes Skipper to use the global store for state shared across runs.</span>
              </div>
              ${isExperimental() ? `
              <div class="sk-form-group">
                <label class="sk-label">Slack Slash Command</label>
                <input type="text" name="slashCommand" class="sk-input" placeholder="/nightly-report">
                <span class="sk-form-help">Optional. Bind a Slack slash command to run this recurring task now (arg text = run input). Requires Socket Mode under <a href="/config">Config</a>.</span>
              </div>
              ` : ""}
            </div>
            <script>
              function toggleScheduleFields(sel) {
                var f = document.getElementById('schedule-fields');
                if (f) f.style.display = sel.value === 'recurring' ? 'block' : 'none';
                var tt = document.getElementById('task-create-task-type');
                if (tt) tt.value = sel.value === 'recurring' ? 'recurring' : '';
              }
              // Mirror the Autopilot checkbox into the hidden mode field the
              // create route reads. The team slot is mode-agnostic (unified teams).
              function syncTaskCreateMode(cb) {
                var m = document.getElementById('task-create-mode');
                if (!m) return;
                m.value = cb.checked ? 'workflow' : 'conversational';
              }
            </script>
            <div style="display:flex; gap:var(--sk-space-3); margin-top:var(--sk-space-4);">
              <input type="hidden" name="autoApprove" value="0">
              <button type="submit" class="sk-btn sk-btn--primary" onclick="this.form.querySelector('[name=autoApprove]').value='1';">Create &amp; Approve</button>
              <button type="submit" class="sk-btn">Save as Draft</button>
              <a href="/" class="sk-btn sk-btn--link" style="margin-left:auto;">Cancel</a>
            </div>
          </form>
        </div>
      </div>
    </div>
    ${iconIdentityPickerScript()}
  `, "/tasks");
}
