import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { NOTIFICATION_EVENTS } from "../../notifications/types";
import type { NotificationPreference } from "../../notifications/store";
import type { LocalTeam } from "../../teams/local-teams";

export interface ConfigPageViewModel {
  teams: LocalTeam[];
  notificationPreferences: NotificationPreference[];
  logRetentionHours: number;
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

function teamsPanel(teams: LocalTeam[]): string {
  const rows = teams.length === 0
    ? `<tr><td colspan="3" class="sk-muted" style="text-align:center;padding:1.5rem;">No teams yet. <a href="/config/teams/new">Create one.</a></td></tr>`
    : teams.map((t) => `
      <tr>
        <td>${escapeHtml(t.name)}</td>
        <td class="sk-text-xs">${t.phases.length} phase${t.phases.length === 1 ? "" : "s"}, ${t.agents.length} agent${t.agents.length === 1 ? "" : "s"}</td>
        <td style="white-space:nowrap;text-align:right;">
          <a href="/config/teams/${escapeHtml(t.id)}/edit" class="sk-btn sk-btn--sm">Edit</a>
          <a href="/api/teams/export?id=${encodeURIComponent(t.id)}" class="sk-btn sk-btn--sm">Export</a>
          <button class="sk-btn sk-btn--sm sk-btn--danger"
            hx-post="/api/teams/${escapeHtml(t.id)}/delete"
            hx-confirm="Delete team '${escapeHtml(t.name)}'?"
            hx-target="closest tr"
            hx-swap="outerHTML">Delete</button>
        </td>
      </tr>`).join("");

  return `
      <!-- Teams Section -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Teams</span>
          <span class="sk-panel__count">${teams.length}</span>
          <div style="margin-left:auto;display:flex;gap:var(--sk-space-2);">
            <a href="/api/teams/export" class="sk-btn sk-btn--sm">Export All</a>
            <a href="/config/teams/new" class="sk-btn sk-btn--sm sk-btn--primary">New Team</a>
          </div>
        </div>
        <div class="sk-panel__body--flush">
          <table class="sk-table">
            <thead><tr><th>Name</th><th>Contents</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="sk-panel__body">
          <h4 style="margin:0 0 var(--sk-space-2);">Import Teams</h4>
          <p class="sk-muted sk-text-xs" style="margin:0 0 var(--sk-space-2);">Paste an export (an array of teams, or <code>{"teams":[...]}</code>), or choose a file. Existing ids are updated; new ids are created.</p>
          <textarea id="team-import-json" class="sk-textarea" rows="5" placeholder='{"teams":[ ... ]}'></textarea>
          <div style="display:flex;gap:var(--sk-space-3);align-items:center;margin-top:var(--sk-space-2);">
            <input type="file" id="team-import-file" accept="application/json,.json" class="sk-input" style="max-width:280px;">
            <button type="button" class="sk-btn sk-btn--sm sk-btn--primary" id="team-import-btn">Import</button>
          </div>
          <div id="team-import-result" class="sk-text-xs" style="margin-top:var(--sk-space-2);"></div>
        </div>
      </div>
      <script>
      (function(){
        var fileInput = document.getElementById('team-import-file');
        var textArea = document.getElementById('team-import-json');
        var btn = document.getElementById('team-import-btn');
        var result = document.getElementById('team-import-result');
        if (fileInput) fileInput.addEventListener('change', function(){
          var f = fileInput.files && fileInput.files[0];
          if (!f) return;
          var reader = new FileReader();
          reader.onload = function(){ textArea.value = String(reader.result || ''); };
          reader.readAsText(f);
        });
        if (btn) btn.addEventListener('click', async function(){
          result.textContent = 'Importing...';
          var raw = textArea.value.trim();
          if (!raw) { result.textContent = 'Nothing to import.'; return; }
          var parsed;
          try { parsed = JSON.parse(raw); } catch (e) { result.textContent = 'Invalid JSON: ' + e.message; return; }
          try {
            var res = await fetch('/api/teams/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
            var data = await res.json();
            if (!res.ok) { result.textContent = 'Import failed: ' + (data.error || res.status); return; }
            var msg = 'Imported ' + (data.imported || 0) + ', updated ' + (data.updated || 0) + '.';
            if (data.errors && data.errors.length) msg += ' Errors: ' + data.errors.map(function(e){ return e.team + ': ' + e.error; }).join('; ');
            result.textContent = msg;
            setTimeout(function(){ window.location.reload(); }, 1200);
          } catch (e) { result.textContent = 'Import failed: ' + e.message; }
        });
      })();
      </script>`;
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
  return v2layout("Configuration", `
    ${navbar({ currentPath: "/config", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Configuration</h1>
      </div>

      ${teamsPanel(vm.teams)}

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

