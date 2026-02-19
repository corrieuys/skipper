import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";

export interface ScheduledTaskCreateViewModel {
  teams: Array<{ id: string; name: string }>;
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

export function scheduledTaskCreatePage(vm: ScheduledTaskCreateViewModel): string {
  return v2layout("New Scheduled Task", `
    ${navbar({ currentPath: "/tasks", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container" style="max-width: 700px;">
      <div class="sk-page-header">
        <a href="/" class="sk-page-header__back">&larr; Dashboard</a>
        <h1 class="sk-page-header__title">Create Scheduled Task</h1>
        <a href="/tasks/new" class="sk-btn sk-btn--sm" style="margin-left:auto;">&larr; Create Regular Task</a>
      </div>

      <div class="sk-panel">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Task Details</span>
        </div>
        <div class="sk-panel__body">
          <form hx-post="/api/scheduled-tasks" hx-target="body" hx-swap="innerHTML">
            <div class="sk-form-group">
              <label class="sk-label">Title</label>
              <input type="text" name="title" class="sk-input" placeholder="What should run on a schedule?" required autofocus>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Description</label>
              <textarea name="description" class="sk-textarea" rows="6" placeholder="Context, constraints, acceptance criteria..."></textarea>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Working Directory</label>
              <input type="text" name="workingDirectory" class="sk-input" placeholder="/path/to/repo (optional)">
            </div>
            <div class="sk-form-row" style="gap:var(--sk-space-3);">
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Team</label>
                <select name="teamId" class="sk-select" required
                  hx-get="/fragments/templates/by-team"
                  hx-trigger="change"
                  hx-target="#template-field-wrapper"
                  hx-swap="outerHTML"
                  hx-include="[name='teamId']">
                  <option value="">Select team...</option>
                  ${vm.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
                </select>
              </div>
              <div id="template-field-wrapper"></div>
            </div>
            <div class="sk-form-row" style="gap:var(--sk-space-3);">
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Run every</label>
                <input type="number" name="scheduleAmount" class="sk-input" min="1" value="1" required style="max-width:100px;">
              </div>
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Unit</label>
                <select name="scheduleUnit" class="sk-select" required>
                  <option value="minutes">Minutes</option>
                  <option value="hours" selected>Hours</option>
                  <option value="days">Days</option>
                </select>
              </div>
            </div>
            <div class="sk-form-group">
              <label style="display:flex; align-items:flex-start; gap:0.5rem; cursor:pointer;">
                <input type="checkbox" name="singleInstance" value="1" style="margin-top:0.25rem;">
                <span>
                  <strong>Single instance</strong>
                  <div class="sk-muted sk-text-xs" style="margin-top:0.15rem;">
                    Re-use one persistent Skipper session across every fire instead of spawning a fresh task per run. The conversation continues from the last fire; the context gets compacted between fires so it doesn't grow forever. Use for recurring background jobs that benefit from memory of prior runs (log monitors, drift checkers, summarisers).
                  </div>
                </span>
              </label>
            </div>
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
