import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";

export interface TemplateListItem {
  id: string;
  template_name: string;
  team_id: string;
  team_name: string | null;
  created_at: string;
}

export interface TemplateListViewModel {
  templates: TemplateListItem[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

export function templateListPage(vm: TemplateListViewModel): string {
  const rows = vm.templates.length === 0
    ? `<tr><td colspan="4" class="sk-muted" style="text-align:center;padding:2rem;">No templates yet. <a href="/templates/new">Create one.</a></td></tr>`
    : vm.templates.map(t => `
      <tr>
        <td>${escapeHtml(t.template_name)}</td>
        <td>${escapeHtml(t.team_name ?? t.team_id)}</td>
        <td class="sk-muted sk-text-xs">${escapeHtml(t.created_at)}</td>
        <td>
          <a href="/templates/${escapeHtml(t.id)}/edit" class="sk-btn sk-btn--sm">Edit</a>
          <button class="sk-btn sk-btn--sm"
            hx-delete="/api/templates/${escapeHtml(t.id)}"
            hx-confirm="Delete template '${escapeHtml(t.template_name)}'?"
            hx-target="closest tr"
            hx-swap="outerHTML">Delete</button>
        </td>
      </tr>`).join("");

  return v2layout("Templates", `
    ${navbar({ currentPath: "/templates", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container">
      <div class="sk-page-header" style="align-items:center;">
        <div style="flex:1;">
          <h1 class="sk-page-header__title">Task Templates</h1>
          <p class="sk-muted" style="margin:0.25rem 0 0;">Reusable prompt configurations per team. Select a template when creating a task.</p>
        </div>
        <a href="/templates/new" class="sk-btn sk-btn--primary" style="align-self:center;margin-left:auto;">New Template</a>
      </div>
      <div class="sk-panel">
        <table class="sk-table" style="width:100%;">
          <thead>
            <tr>
              <th>Name</th>
              <th>Team</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `, "/templates");
}
