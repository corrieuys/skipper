import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { NOTIFICATION_EVENTS } from "../../notifications/types";
import type { NotificationPreference } from "../../notifications/store";

export interface ConfigPageAgent {
  id: string;
  name: string;
  type: string;
  model: string;
  status: string;
}

export interface ConfigPageTeam {
  id: string;
  name: string;
  entrypoint_agent_name?: string;
  phases: { name: string }[];
}

export interface ConfigPageViewModel {
  agents: ConfigPageAgent[];
  teams: ConfigPageTeam[];
  notificationPreferences: NotificationPreference[];
  logRetentionHours: number;
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

function notificationRows(prefs: NotificationPreference[]): string {
  return prefs.map((pref) => {
    const meta = NOTIFICATION_EVENTS.find((e) => e.key === pref.event_key);
    if (!meta) return "";
    const checked = pref.audio_enabled ? " checked" : "";
    return `<tr id="notif-row-${escapeHtml(pref.event_key)}">
      <td>${escapeHtml(meta.label)}</td>
      <td class="sk-muted sk-text-xs">${escapeHtml(meta.description)}</td>
      <td class="sk-mono sk-text-xs">${escapeHtml(meta.soundFile)}</td>
      <td style="text-align:center">
        <input type="checkbox"${checked}
          hx-put="/api/notifications/preferences/${escapeHtml(pref.event_key)}"
          hx-vals='js:{"enabled": event.target.checked}'
          hx-swap="none">
      </td>
    </tr>`;
  }).join("");
}

export function configPage(vm: ConfigPageViewModel): string {
  const agentRows = vm.agents.map((agent) => {
    const eid = escapeHtml(agent.id);
    return `<tbody id="agent-row-${eid}">
      <tr>
        <td>${escapeHtml(agent.name)}</td>
        <td class="sk-mono">${escapeHtml(agent.type)}</td>
        <td class="sk-mono">${escapeHtml(agent.model)}</td>
        <td><span class="sk-badge sk-badge--${agent.status}">${agent.status}</span></td>
        <td style="text-align:right;">
          <button class="sk-btn sk-btn--sm"
            hx-get="/fragments/config/agents/${eid}/edit"
            hx-target="#agent-row-${eid}"
            hx-swap="beforeend">Edit</button>
        </td>
      </tr>
    </tbody>`;
  }).join("");

  const teamRows = vm.teams.map((team) => {
    const eid = escapeHtml(team.id);
    const phaseCount = Array.isArray(team.phases) ? team.phases.length : 0;
    return `<tbody id="team-row-${eid}">
      <tr>
        <td>${escapeHtml(team.name)}</td>
        <td>${team.entrypoint_agent_name ? escapeHtml(team.entrypoint_agent_name) : '<span class="sk-muted">-</span>'}</td>
        <td>${phaseCount} phase${phaseCount === 1 ? "" : "s"}</td>
        <td style="text-align:right;">
          <button class="sk-btn sk-btn--sm"
            hx-get="/fragments/config/teams/${eid}/edit"
            hx-target="#team-row-${eid}"
            hx-swap="beforeend">Edit</button>
        </td>
      </tr>
    </tbody>`;
  }).join("");

  return v2layout("Configuration", `
    ${navbar({ currentPath: "/config", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Configuration</h1>
      </div>

      <!-- Agents Section -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Agents</span>
          <span class="sk-panel__count">${vm.agents.length}</span>
          <button class="sk-btn sk-btn--sm" style="margin-left:auto;"
            hx-post="/api/config/export/agents" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.textContent='Exported!';setTimeout(()=>this.textContent='Export to base config',1500);}">Export to base config</button>
        </div>
        <div class="sk-panel__body--flush">
          ${vm.agents.length > 0
            ? `<table class="sk-table">
                <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Status</th><th></th></tr></thead>
                ${agentRows}
              </table>`
            : `<div class="sk-panel__empty">No agents configured</div>`
          }
        </div>
      </div>

      <!-- Teams Section -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Teams</span>
          <span class="sk-panel__count">${vm.teams.length}</span>
          <button class="sk-btn sk-btn--sm" style="margin-left:auto;"
            hx-post="/api/config/export/teams" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.textContent='Exported!';setTimeout(()=>this.textContent='Export to base config',1500);}">Export to base config</button>
        </div>
        <div class="sk-panel__body--flush">
          ${vm.teams.length > 0
            ? `<table class="sk-table">
                <thead><tr><th>Name</th><th>Entrypoint</th><th>Phases</th><th></th></tr></thead>
                ${teamRows}
              </table>`
            : `<div class="sk-panel__empty">No teams configured</div>`
          }
        </div>
      </div>

      <!-- Sound Notifications Section -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Sound Notifications</span>
        </div>
        <div class="sk-panel__body--flush">
          <table class="sk-table">
            <thead><tr><th>Event</th><th>Description</th><th>Sound</th><th style="text-align:center">Enabled</th></tr></thead>
            <tbody>${notificationRows(vm.notificationPreferences)}</tbody>
          </table>
        </div>
      </div>

      <!-- Terminal Output Retention Section -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Terminal Output Retention</span>
          <button class="sk-btn sk-btn--sm sk-btn--danger" style="margin-left:auto;"
            hx-post="/api/config/log-purge" hx-swap="none"
            hx-confirm="Purge all terminal output, sessions, and events older than the retention period now?"
            hx-on::after-request="if(event.detail.successful){this.textContent='Purged!';setTimeout(()=>this.textContent='Purge Now',1500);}">Purge Now</button>
        </div>
        <div class="sk-panel__body">
          <div class="sk-flex sk-items-center sk-gap-3">
            <label class="sk-muted sk-text-xs" for="log-retention-hours">Retention (hours):</label>
            <input type="number" id="log-retention-hours" name="hours" min="1" max="720" value="${vm.logRetentionHours}"
              class="sk-input sk-input--sm" style="width:80px;"
              hx-post="/api/config/log-retention" hx-trigger="change" hx-swap="none"
              hx-include="this">
            <span class="sk-text-xs sk-muted">Deletes terminal_outputs, agent_sessions, and events older than this. Default: 24h.</span>
          </div>
        </div>
      </div>

      <!-- System Section -->
      <div class="sk-panel">
        <div class="sk-panel__header">
          <span class="sk-panel__title">System</span>
        </div>
        <div class="sk-panel__body">
          <table class="sk-table">
            <tr><td class="sk-muted">Daemon State</td><td><span class="sk-badge sk-badge--${vm.daemonState === "running" ? "running" : "draft"}">${escapeHtml(vm.daemonState)}</span></td></tr>
            <tr><td class="sk-muted">Uptime</td><td>${Math.floor(vm.daemonUptime / 60)}m</td></tr>
            <tr><td class="sk-muted">Agents</td><td>${vm.agents.length}</td></tr>
            <tr><td class="sk-muted">Teams</td><td>${vm.teams.length}</td></tr>
          </table>
        </div>
      </div>
    </div>
  `, "/config");
}

export interface ApiKeyData { id: string; name: string; created_at: string; }

export function apiKeysPanel(keys: ApiKeyData[]): string {
  const rows = keys.map(k =>
    `<tr><td>${escapeHtml(k.name)}</td><td class="sk-muted sk-text-xs">${escapeHtml(k.created_at)}</td><td><button class="sk-btn sk-btn--danger sk-btn--sm" hx-delete="/api/api-keys/${escapeHtml(k.id)}" hx-target="#sk-api-keys-panel" hx-swap="outerHTML" hx-confirm="Delete this API key?">Delete</button></td></tr>`
  ).join("");
  return `<div id="sk-api-keys-panel" class="sk-panel" style="margin-bottom: var(--sk-space-6);">
    <div class="sk-panel__header"><span class="sk-panel__title">API Keys</span></div>
    <div class="sk-panel__body">
      ${keys.length > 0 ? `<table class="sk-table"><thead><tr><th>Name</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="sk-muted sk-text-xs">No API keys</p>`}
      <form hx-post="/api/api-keys" hx-target="#sk-api-keys-panel" hx-swap="outerHTML" style="margin-top:var(--sk-space-3);display:flex;gap:var(--sk-space-2);align-items:end;">
        <input type="text" name="name" placeholder="Key name" class="sk-input sk-input--sm" required>
        <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Create</button>
      </form>
    </div>
  </div>`;
}

export function configAgentRowFragment(agent: ConfigPageAgent): string {
  const eid = escapeHtml(agent.id);
  return `<tbody id="agent-row-${eid}">
    <tr>
      <td>${escapeHtml(agent.name)}</td>
      <td class="sk-mono">${escapeHtml(agent.type)}</td>
      <td class="sk-mono">${escapeHtml(agent.model)}</td>
      <td><span class="sk-badge sk-badge--${agent.status}">${agent.status}</span></td>
      <td style="text-align:right;">
        <button class="sk-btn sk-btn--sm"
          hx-get="/fragments/config/agents/${eid}/edit"
          hx-target="#agent-row-${eid}"
          hx-swap="beforeend">Edit</button>
      </td>
    </tr>
  </tbody>`;
}

export function configTeamRowFragment(team: ConfigPageTeam): string {
  const eid = escapeHtml(team.id);
  const phaseCount = Array.isArray(team.phases) ? team.phases.length : 0;
  return `<tbody id="team-row-${eid}">
    <tr>
      <td>${escapeHtml(team.name)}</td>
      <td>${team.entrypoint_agent_name ? escapeHtml(team.entrypoint_agent_name) : '<span class="sk-muted">-</span>'}</td>
      <td>${phaseCount} phase${phaseCount === 1 ? "" : "s"}</td>
      <td style="text-align:right;">
        <button class="sk-btn sk-btn--sm"
          hx-get="/fragments/config/teams/${eid}/edit"
          hx-target="#team-row-${eid}"
          hx-swap="beforeend">Edit</button>
      </td>
    </tr>
  </tbody>`;
}
