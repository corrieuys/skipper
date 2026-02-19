import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { taskRowFragment, taskDeleteButton, type TaskRowData } from "../fragments/task-row.fragment";
import { escalationBarPanel } from "../panels/escalation-bar.panel";

export interface ScheduledTaskListItem {
  id: string;
  title: string;
  schedule_unit: string;
  schedule_amount: number;
  status: string;
  team_name: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface ScheduledRunListItem extends TaskRowData {
  source_scheduled_title: string | null;
}

export interface TaskListViewModel {
  tasks: TaskRowData[];
  scheduledRuns?: ScheduledRunListItem[];
  scheduledTasks?: ScheduledTaskListItem[];
  escalationCount: number;
  daemonState: string;
  daemonUptime: number;
}

function formatScheduleBadge(unit: string, amount: number): string {
  if (unit === "minutes") return amount === 1 ? "1m" : `${amount}m`;
  if (unit === "hours") return amount === 1 ? "1h" : `${amount}h`;
  if (unit === "days") return amount === 1 ? "daily" : `${amount}d`;
  return `${amount}${unit[0]}`;
}

export function taskListPage(vm: TaskListViewModel): string {
  const rows = vm.tasks.map((t) => taskRowFragment(t)).join("");
  const scheduled = vm.scheduledTasks ?? [];
  const scheduledRuns = vm.scheduledRuns ?? [];

  return v2layout("Tasks", `
    ${navbar({ currentPath: "/tasks", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    ${vm.escalationCount > 0 ? `<div style="padding: var(--sk-space-2) var(--sk-space-4);">${escalationBarPanel(vm.escalationCount)}</div>` : ""}
    <div class="sk-container">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Tasks</h1>
        <div style="margin-left:auto"><a href="/tasks/new" class="sk-btn sk-btn--primary sk-btn--sm">+ New Task</a></div>
      </div>
      <div id="sk-task-list" class="sk-panel">
        <div class="sk-panel__body--flush">
          <table class="sk-table">
            <thead><tr><th>Title</th><th>Status</th><th>Team</th><th>Phase</th><th>Created</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="sk-text-center sk-muted">No tasks</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      ${scheduled.length > 0 ? `
      <div class="sk-page-header" style="margin-top:var(--sk-space-6);">
        <h2 class="sk-page-header__title" style="font-size:1.1rem;">Scheduled Tasks</h2>
      </div>
      <div class="sk-panel">
        <div class="sk-panel__body--flush">
          <table class="sk-table">
            <thead><tr><th>Title</th><th>Schedule</th><th>Status</th><th>Team</th><th>Next Run</th><th>Last Run</th></tr></thead>
            <tbody>
              ${scheduled.map(st => `
                <tr style="cursor:pointer;" onclick="window.location='/?scheduled=${escapeHtml(st.id)}';">
                  <td>${escapeHtml(st.title)}</td>
                  <td><span class="sk-badge sk-badge--waiting" style="font-size:10px;padding:1px 5px;">${formatScheduleBadge(st.schedule_unit, st.schedule_amount)}</span></td>
                  <td><span class="sk-badge sk-badge--${st.status === "approved" ? "running" : "draft"}" style="font-size:10px;padding:1px 5px;">${escapeHtml(st.status)}</span></td>
                  <td class="sk-muted">${st.team_name ? escapeHtml(st.team_name) : "—"}</td>
                  <td>${st.next_run_at ? formatTimestamp(st.next_run_at) : "<span class='sk-muted'>—</span>"}</td>
                  <td>${st.last_run_at ? formatTimestamp(st.last_run_at) : "<span class='sk-muted'>—</span>"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
      ` : ""}

      ${scheduledRuns.length > 0 ? `
      <div class="sk-page-header" style="margin-top:var(--sk-space-6);">
        <h2 class="sk-page-header__title" style="font-size:1.1rem;">Scheduled Task Runs</h2>
      </div>
      <div class="sk-panel">
        <div class="sk-panel__body--flush">
          <table class="sk-table">
            <thead><tr><th>Title</th><th>Status</th><th>Team</th><th>Phase</th><th>Scheduled Task</th><th>Created</th><th></th></tr></thead>
            <tbody>${scheduledRuns.map((r) => `<tr>
              <td><a href="/?task=${escapeHtml(r.id)}">${escapeHtml(r.title)}</a></td>
              <td><span class="sk-badge sk-badge--${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
              <td>${escapeHtml(r.team_name ?? "—")}</td>
              <td>${r.task_type === "real_time" ? '<span class="sk-badge sk-badge--waiting">RT</span>' : `Phase ${r.current_phase + 1}`}</td>
              <td class="sk-muted">${r.source_scheduled_title ? escapeHtml(r.source_scheduled_title) : "—"}</td>
              <td class="sk-muted">${formatTimestamp(r.created_at)}</td>
              <td style="text-align:right;">${taskDeleteButton(r.id, r.status)}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
      </div>
      ` : ""}
    </div>
  `, "/tasks", ["tasks"]);
}
