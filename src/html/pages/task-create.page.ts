import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { isExperimental } from "../../config/feature-flags";

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

export function taskCreatePage(vm: TaskCreateViewModel): string {
  // Team + template fields are rendered server-side via the slot endpoint, which
  // reacts to taskType changes. `vm.teams` is no longer used here directly.
  void vm.teams;

  return v2layout("New Task", `
    ${navbar({ currentPath: "/tasks", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container" style="max-width: 700px;">
      <div class="sk-page-header">
        <a href="/" class="sk-page-header__back">&larr; Dashboard</a>
        <h1 class="sk-page-header__title">Create Task</h1>
        <a href="/tasks/scheduled/new" class="sk-btn sk-btn--sm" style="margin-left:auto;">Create Scheduled Task &rarr;</a>
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
              <label class="sk-label">Description</label>
              <textarea name="description" class="sk-textarea" rows="6" placeholder="Context, constraints, acceptance criteria..."></textarea>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Working Directory <span style="font-weight:normal;font-size:0.72rem;color:var(--muted);">(optional — Skipper will discover from the task description if blank)</span></label>
              <input type="text" name="workingDirectory" class="sk-input" placeholder="/path/to/repo (optional)">
            </div>
            <div class="sk-form-row">
              <div id="task-form-team-template-slot" style="display:contents;"
                hx-get="/fragments/task-form/team-template?taskType=standard&amp;context=full"
                hx-trigger="load, change from:[name=taskType]"
                hx-include="[name=taskType]"
                hx-target="this"
                hx-swap="outerHTML"></div>
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Task Type</label>
                <select name="taskType" class="sk-select">
                  <option value="standard" selected>Standard</option>
                  ${isExperimental() ? `<option value="real_time">Real-Time</option>` : ""}
                </select>
              </div>
            </div>
            <div id="phase-config-slot"></div>
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
