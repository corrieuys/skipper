import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import type { ConsensusConfig } from "../../teams/manager";
import { isExperimental } from "../../config/feature-flags";
import type { HookDefinition, HookEventName } from "../../hooks/types";

export interface TeamOption {
  id: string;
  name: string;
}

export interface ExistingTemplate {
  id: string;
  template_name: string;
  team_id: string;
  skipper_prompt: string;
  hooks: HookDefinition[];
}

export interface RecentHookFire {
  taskId: string;
  type: "hook:executed" | "hook:failed" | "hook:error";
  event: string;
  name: string | null;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  createdAt: string;
}

const HOOK_EVENT_OPTIONS: HookEventName[] = [
  "task.started",
  "task.completed",
  "task.failed",
  "escalation.created",
  "escalation.resolved",
  "phase.review_pending",
];

const HOOK_TYPE_OPTIONS = ["curl"] as const;

export interface ExistingPhase {
  phase_name: string;
  prompt: string;
  override_prompt: boolean;
  review_override: boolean | null;
  consensus_override: ConsensusConfig | null | undefined;
}

export interface TeamPhase {
  name: string;
  prompt: string;
  review?: boolean;
  consensus?: ConsensusConfig;
}

export interface TemplateFormViewModel {
  teams: TeamOption[];
  template: ExistingTemplate | null;
  teamPhases: TeamPhase[];
  existingPhases: ExistingPhase[];
  recentHookFires: RecentHookFire[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

export function hookRowFragment(h: Partial<HookDefinition>): string {
  const eventOpts = HOOK_EVENT_OPTIONS.map(
    (e) => `<option value="${e}"${h.event === e ? " selected" : ""}>${e}</option>`,
  ).join("");
  const typeOpts = HOOK_TYPE_OPTIONS.map(
    (t) => `<option value="${t}"${h.type === t ? " selected" : ""}>${t}</option>`,
  ).join("");
  return `<fieldset class="sk-hook-row" data-sk-hook-row style="border:1px solid var(--sk-border);border-radius:var(--sk-radius-md);padding:var(--sk-space-3);margin-bottom:var(--sk-space-2);display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:var(--sk-space-2);">
    <label class="sk-label" style="grid-column:1;font-size:11px;">Event
      <select data-sk-field="event" class="sk-select">${eventOpts}</select>
    </label>
    <label class="sk-label" style="grid-column:2;font-size:11px;">Type
      <select data-sk-field="type" class="sk-select">${typeOpts}</select>
    </label>
    <label class="sk-label" style="grid-column:3;font-size:11px;">Name (optional)
      <input data-sk-field="name" class="sk-input" type="text" value="${escapeHtml(h.name ?? "")}" placeholder="e.g. notify-slack">
    </label>
    <div style="grid-column:4;display:flex;flex-direction:column;align-items:flex-end;gap:var(--sk-space-2);">
      <label class="sk-label" style="font-size:11px;display:flex;align-items:center;gap:4px;">
        <input data-sk-field="disabled" type="checkbox"${h.disabled ? " checked" : ""}> disabled
      </label>
      <button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-sk-hooks-remove>Remove</button>
    </div>
    <label class="sk-label" style="grid-column:1 / -1;font-size:11px;">Command template
      <textarea data-sk-field="template" class="sk-textarea" rows="2" placeholder="curl -X POST https://example.com -d 'task={{event.taskId}}'">${escapeHtml(h.template ?? "")}</textarea>
    </label>
  </fieldset>`;
}

function recentHookFiresTable(fires: RecentHookFire[]): string {
  return `<table class="sk-table" style="font-size:11px;margin-top:var(--sk-space-2);">
    <thead><tr><th>Time</th><th>Event</th><th>Hook</th><th>Exit</th><th>Output</th></tr></thead>
    <tbody>${fires.map((f) => {
      const exitCell = f.type === "hook:executed"
        ? `<span class="sk-badge sk-badge--completed">0</span>`
        : f.type === "hook:failed"
          ? `<span class="sk-badge sk-badge--failed">${f.exitCode ?? "?"}</span>`
          : `<span class="sk-badge sk-badge--failed">err</span>`;
      const tail = f.stderrTail || f.stdoutTail;
      return `<tr>
        <td>${escapeHtml(f.createdAt)}</td>
        <td>${escapeHtml(f.event)}</td>
        <td>${escapeHtml(f.name ?? "—")}</td>
        <td>${exitCell}</td>
        <td style="font-family:var(--sk-font-mono);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(tail)}">${escapeHtml(tail.slice(0, 80))}</td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
}

export function phaseInputsFragment(teamPhases: TeamPhase[], existingPhases: ExistingPhase[]): string {
  if (teamPhases.length === 0) return `<div id="template-phases"></div>`;
  const phaseMap = new Map(existingPhases.map(p => [p.phase_name, p]));

  const inputs = teamPhases.map(phase => {
    const existing = phaseMap.get(phase.name);
    const overridePrompt = existing?.override_prompt ?? false;
    const reviewOverride = existing?.review_override ?? null;
    const consensusOverride = existing?.consensus_override;

    const appendPromptValue = overridePrompt ? "" : (existing?.prompt ?? "");
    const overridePromptValue = overridePrompt ? (existing?.prompt ?? "") : "";

    const baseReviewText = (phase.review ?? false) ? "enabled" : "disabled";

    let reviewSelectValue = "inherit";
    if (reviewOverride === true) reviewSelectValue = "enabled";
    else if (reviewOverride === false) reviewSelectValue = "disabled";

    let baseConsensusText = "No parallel execution";
    if (phase.consensus) {
      const c = phase.consensus;
      baseConsensusText = `Parallel: ${c.agent_count} agents, ${c.strategy}, worktree:${c.worktree ? "yes" : "no"}`;
    }

    let consensusModeValue = "inherit";
    if (consensusOverride !== undefined && consensusOverride !== null) {
      consensusModeValue = "override";
    } else if (consensusOverride === null) {
      consensusModeValue = "disabled";
    }

    const showConsensusConfig = consensusModeValue === "override";
    const consensusConfig = (consensusOverride !== undefined && consensusOverride !== null) ? consensusOverride : null;

    const safeName = escapeHtml(phase.name);

    return `
    <div class="sk-form-group" style="border:1px solid var(--sk-border);border-radius:6px;padding:var(--sk-space-3);margin-bottom:var(--sk-space-3);">
      <h4 style="margin:0 0 var(--sk-space-3);">${safeName}</h4>
      <input type="hidden" name="phaseName" value="${safeName}">

      <div style="margin-bottom:var(--sk-space-3);">
        <label style="display:flex;align-items:center;gap:var(--sk-space-2);cursor:pointer;font-weight:500;">
          <input type="checkbox" name="phaseOverridePrompt" value="${safeName}"
                 ${overridePrompt ? "checked" : ""}
                 onchange="togglePromptOverride(this, '${safeName}')">
          Override entire prompt for this phase
        </label>

        <div id="prompt-append-${safeName}" style="margin-top:var(--sk-space-2);display:${overridePrompt ? "none" : "block"}">
          <label class="sk-label sk-text-xs" style="color:var(--sk-text-muted);">Additional prompt (appended to base):</label>
          <textarea name="phasePrompt" class="sk-textarea" rows="4" data-phase="${safeName}"
            placeholder="Appended to the ${safeName} phase prompt when this template is used..."
          >${escapeHtml(appendPromptValue)}</textarea>
        </div>

        <div id="prompt-override-${safeName}" style="margin-top:var(--sk-space-2);display:${overridePrompt ? "block" : "none"}">
          <label class="sk-label sk-text-xs" style="color:var(--sk-text-muted);">Full prompt (replaces base team prompt):</label>
          <textarea name="phasePromptOverride" class="sk-textarea" rows="6" data-phase="${safeName}"
                    data-base-prompt="${escapeHtml(phase.prompt)}">${escapeHtml(overridePromptValue)}</textarea>
        </div>
      </div>

      <div style="margin-bottom:var(--sk-space-3);">
        <p class="sk-text-xs" style="color:var(--sk-text-muted);margin:0 0 var(--sk-space-1);">Base team setting: Review gate <strong>${baseReviewText}</strong></p>
        <label class="sk-label sk-text-xs">Review gate override:</label>
        <select name="phaseReviewOverride" class="sk-select" data-phase="${safeName}">
          <option value="inherit"${reviewSelectValue === "inherit" ? " selected" : ""}>Inherit from team</option>
          <option value="enabled"${reviewSelectValue === "enabled" ? " selected" : ""}>Enable review</option>
          <option value="disabled"${reviewSelectValue === "disabled" ? " selected" : ""}>Disable review</option>
        </select>
      </div>

      ${isExperimental() ? `<div>
        <p class="sk-text-xs" style="color:var(--sk-text-muted);margin:0 0 var(--sk-space-1);">Base team setting: ${escapeHtml(baseConsensusText)}</p>
        <label class="sk-label sk-text-xs">Parallel/consolidation override:</label>
        <select name="phaseConsensusMode" class="sk-select" data-phase="${safeName}"
                onchange="toggleConsensusOverride(this, '${safeName}')">
          <option value="inherit"${consensusModeValue === "inherit" ? " selected" : ""}>Inherit from team</option>
          <option value="override"${consensusModeValue === "override" ? " selected" : ""}>Override</option>
          <option value="disabled"${consensusModeValue === "disabled" ? " selected" : ""}>Disable parallel execution</option>
        </select>

        <div id="consensus-config-${safeName}" style="margin-top:var(--sk-space-2);display:${showConsensusConfig ? "block" : "none"};">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sk-space-2);margin-bottom:var(--sk-space-2);">
            <label class="sk-label sk-text-xs">Agent count:
              <input type="number" name="phaseConsensusAgentCount" class="sk-input"
                     data-phase="${safeName}" value="${consensusConfig?.agent_count ?? 2}" min="1">
            </label>
            <label class="sk-label sk-text-xs">Strategy:
              <select name="phaseConsensusStrategy" class="sk-select" data-phase="${safeName}">
                <option value="best_of"${(!consensusConfig || consensusConfig.strategy === "best_of") ? " selected" : ""}>Best of N</option>
                <option value="merge"${consensusConfig?.strategy === "merge" ? " selected" : ""}>Merge</option>
              </select>
            </label>
          </div>
          <label style="display:flex;align-items:center;gap:var(--sk-space-2);margin-bottom:var(--sk-space-2);cursor:pointer;">
            <input type="checkbox" name="phaseConsensusWorktree" data-phase="${safeName}"
                   ${consensusConfig?.worktree ? "checked" : ""}>
            Use worktree
          </label>
          <label class="sk-label sk-text-xs">Reviewer agent ID (optional):
            <input type="text" name="phaseConsensusReviewerAgentId" class="sk-input"
                   data-phase="${safeName}" value="${escapeHtml(consensusConfig?.reviewer_agent_id ?? "")}">
          </label>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");

  return `<div id="template-phases">
    ${inputs}
    <script>
      function togglePromptOverride(checkbox, phaseName) {
        var appendDiv = document.getElementById('prompt-append-' + phaseName);
        var overrideDiv = document.getElementById('prompt-override-' + phaseName);
        if (checkbox.checked) {
          appendDiv.style.display = 'none';
          overrideDiv.style.display = 'block';
          var ta = overrideDiv.querySelector('textarea');
          if (ta && !ta.value.trim()) {
            ta.value = ta.dataset.basePrompt || '';
          }
        } else {
          appendDiv.style.display = 'block';
          overrideDiv.style.display = 'none';
        }
      }
      function toggleConsensusOverride(select, phaseName) {
        var configDiv = document.getElementById('consensus-config-' + phaseName);
        if (configDiv) configDiv.style.display = select.value === 'override' ? 'block' : 'none';
      }
    </script>
  </div>`;
}

export function templateFormPage(vm: TemplateFormViewModel): string {
  const isEdit = !!vm.template;
  const title = isEdit ? "Edit Template" : "New Template";
  const action = isEdit
    ? `/api/templates/${escapeHtml(vm.template!.id)}/update`
    : "/api/templates/create";

  const teamOptions = vm.teams
    .map(t => `<option value="${escapeHtml(t.id)}"${vm.template?.team_id === t.id ? " selected" : ""}>${escapeHtml(t.name)}</option>`)
    .join("");

  const phasesHtml = phaseInputsFragment(vm.teamPhases, vm.existingPhases);

  const teamSelectAttrs = isEdit
    ? `disabled`
    : `hx-get="/fragments/templates/phases-form"
       hx-trigger="change"
       hx-target="#template-phases"
       hx-swap="outerHTML"
       hx-include="this"`;

  return v2layout(title, `
    ${navbar({ currentPath: "/templates", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container" style="max-width:700px;">
      <div class="sk-page-header">
        <a href="/templates" class="sk-page-header__back">&larr; Templates</a>
        <h1 class="sk-page-header__title">${escapeHtml(title)}</h1>
      </div>
      <div class="sk-panel">
        <div class="sk-panel__body">
          <form hx-post="${action}" hx-target="body" hx-swap="innerHTML">
            <div class="sk-form-group">
              <label class="sk-label">Template Name</label>
              <input type="text" name="templateName" class="sk-input"
                value="${escapeHtml(vm.template?.template_name ?? "")}"
                placeholder="e.g. Standard Feature Work" required autofocus>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Team</label>
              <select name="teamId" class="sk-select" ${teamSelectAttrs}>
                <option value="">Select a team...</option>
                ${teamOptions}
              </select>
              ${isEdit ? `<p class="sk-muted sk-text-xs">Team is fixed after creation.</p>` : ""}
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Skipper Prompt</label>
              <textarea name="skipperPrompt" class="sk-textarea" rows="5"
                placeholder="Appended to the task description — provides Skipper with extra context across all phases..."
              >${escapeHtml(vm.template?.skipper_prompt ?? "")}</textarea>
            </div>
            ${isExperimental() ? `
            <hr style="margin:var(--sk-space-4) 0;">
            <h3 style="margin-bottom:var(--sk-space-3);">Hooks</h3>
            <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
              Shell commands fired on task / escalation / phase events. Use
              <code>{{event.FIELD}}</code> placeholders — <code>taskId</code>, <code>taskTitle</code>,
              <code>status</code>, <code>escalationId</code>, <code>question</code>, etc. (shell-escaped automatically).
              30 s timeout per hook. Disabled hooks are persisted but skipped.
            </p>
            <div id="sk-hooks-editor" data-sk-hooks-editor>
              ${(vm.template?.hooks ?? []).map((h) => hookRowFragment(h)).join("")}
            </div>
            <input type="hidden" name="hooks" id="sk-hooks-json" value="${escapeHtml(JSON.stringify(vm.template?.hooks ?? []))}">
            <button type="button" class="sk-btn sk-btn--sm" data-sk-hooks-add style="margin-top:var(--sk-space-2);">+ Add Hook</button>

            ${vm.recentHookFires.length > 0 ? `
              <details style="margin-top:var(--sk-space-4);">
                <summary class="sk-muted sk-text-xs" style="cursor:pointer;">Recent executions (${vm.recentHookFires.length})</summary>
                ${recentHookFiresTable(vm.recentHookFires)}
              </details>
            ` : ""}
            ` : `<input type="hidden" name="hooks" id="sk-hooks-json" value="${escapeHtml(JSON.stringify(vm.template?.hooks ?? []))}">`}

            <hr style="margin:var(--sk-space-4) 0;">
            <h3 style="margin-bottom:var(--sk-space-3);">Phase Configuration</h3>
            <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
              Override phase prompts, review gates, and parallel execution settings for this template.
              ${isEdit ? "" : "Select a team above to load phase fields."}
            </p>
            ${phasesHtml}
            <div style="display:flex; gap:var(--sk-space-3); margin-top:var(--sk-space-4);">
              <button type="submit" class="sk-btn sk-btn--primary">${isEdit ? "Save Changes" : "Create Template"}</button>
              <a href="/templates" class="sk-btn sk-btn--link">Cancel</a>
            </div>
          </form>
        </div>
      </div>
    </div>
  `, "/templates");
}
