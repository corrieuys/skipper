import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { themePickerFragment } from "../styles/themes";
import { NOTIFICATION_EVENTS } from "../../notifications/types";
import { isExperimental } from "../../config/feature-flags";
import { agentIdentityPicker, agentIdentityPickerScript } from "../atoms/agent-identity-picker";
import type { NotificationPreference } from "../../notifications/store";
import type { ModelChoice, AgentTypeOption } from "../../config/model-settings";
import type { SlackConfigView } from "../../config/slack-settings";
import { taskMemoryPanel, type TaskMemoryPanelData } from "../fragments/task-memory-config.fragment";

export interface ConfigPageViewModel {
  notificationPreferences: NotificationPreference[];
  logRetentionHours: number;
  taskRetentionDays: number;
  recurringTaskRetentionDays: number;
  parallelExecution: boolean;
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
  skipperConnectHasKey: boolean;
  skipperConnectUrl: string;
  apiKeys: ApiKeyData[];
  modelSettings: {
    skipper: ModelChoice;
    greg: ModelChoice;
    dictation: ModelChoice;
    task_title: Partial<ModelChoice>;
    options: AgentTypeOption[];
  };
  slack?: SlackConfigView;
  /** Task memory embeddings settings + local server status (experimental). */
  taskMemory?: TaskMemoryPanelData;
  autoUpdate: {
    enabled: boolean;
    currentVersion: string;
    availableVersion: string | null;
  };
  /** Skipper's own orb identity (experimental config section). */
  skipperIdentity: { color: string; character: string };
}

/** One provider (agent type) + model row for a subsystem. Model list is filtered
 *  client-side when the provider changes (see the script in modelSettingsPanel). */
function modelSettingRow(
  target: "skipper" | "greg" | "dictation" | "task_title",
  label: string,
  hint: string,
  current: Partial<ModelChoice>,
  options: AgentTypeOption[],
  allowUnset = false,
): string {
  // A row that allows "unset" (task_title) offers a leading blank option so the
  // operator can clear the provider and keep the title required.
  const unsetOpt = allowUnset
    ? `<option value=""${!current.agent_type ? " selected" : ""}>Not set (title required)</option>`
    : "";
  const typeOpts = unsetOpt + options
    .map((o) => `<option value="${escapeHtml(o.name)}"${o.name === current.agent_type ? " selected" : ""}>${escapeHtml(o.name)}</option>`)
    .join("");
  return `<form class="sk-model-row" data-model-target="${target}"
      hx-post="/api/config/model-settings" hx-swap="none"
      hx-on::after-request="if(event.detail.successful){var b=this.querySelector('button');b.textContent='Saved';setTimeout(function(){b.textContent='Save';},1200);}">
    <input type="hidden" name="target" value="${target}">
    <div class="sk-model-row__name">
      <div class="sk-text-sm" style="color:var(--sk-text);">${escapeHtml(label)}</div>
      <div class="sk-text-xs sk-muted">${escapeHtml(hint)}</div>
    </div>
    <div class="sk-model-row__field">
      <label class="sk-model-row__label" for="model-type-${target}">Provider</label>
      <select id="model-type-${target}" name="agent_type" class="sk-input sk-input--sm" data-model-type>${typeOpts}</select>
    </div>
    <div class="sk-model-row__field">
      <label class="sk-model-row__label" for="model-model-${target}">Model</label>
      <input id="model-model-${target}" type="text" name="model" class="sk-input sk-input--sm" data-model-model
             value="${escapeHtml(current.model ?? "")}" placeholder="default" autocomplete="off">
    </div>
    <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary sk-model-row__save">Save</button>
  </form>`;
}

function modelSettingsPanel(ms: ConfigPageViewModel["modelSettings"]): string {
  // Model is free text — providers ship new model names faster than any list we
  // could bake in, so there is no per-provider model picker, just a text field.
  return `<div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
    <div class="sk-panel__header">
      <span class="sk-panel__title">Default Agent Models</span>
    </div>
    <div class="sk-panel__body">
      <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
        Provider + model for each core agent. Model is any name the provider accepts.
        Stored on this machine only (not committed).
      </p>
      ${modelSettingRow("skipper", "Skipper", "Root task orchestrator", ms.skipper, ms.options)}
      ${modelSettingRow("greg", "Greg", "Heckler bot", ms.greg, ms.options)}
      ${modelSettingRow("task_title", "Task Title Generator", "Generates a short title from the description when none is given", ms.task_title ?? {}, ms.options, true)}
      ${isExperimental() ? modelSettingRow("dictation", "Dictation Rewriter", "Cleans up dictated task descriptions", ms.dictation, ms.options) : ""}
    </div>
  </div>`;
}


/** Experimental: pick the Skipper's own color + creature for the active-agent orb. */
function skipperCharacterPanel(identity: { color: string; character: string } = { color: "", character: "" }): string {
  return `<div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
    <div class="sk-panel__header">
      <span class="sk-panel__title">Skipper Character</span>
    </div>
    <div class="sk-panel__body">
      <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
        The Skipper's color and creature in the active-agent orb. Stored on this machine only.
      </p>
      ${agentIdentityPicker({ color: identity.color, character: identity.character, experimental: true })}
      <div style="margin-top:var(--sk-space-3);display:flex;align-items:center;gap:var(--sk-space-2);">
        <button type="button" id="sk-skipper-identity-save" class="sk-btn sk-btn--sm sk-btn--primary">Save</button>
        <span id="sk-skipper-identity-status" class="sk-muted sk-text-xs"></span>
      </div>
    </div>
    <script>(function(){
      var btn=document.getElementById('sk-skipper-identity-save');
      if(!btn)return;
      btn.addEventListener('click',function(){
        var root=document.querySelector('#sk-skipper-identity-save').closest('.sk-panel__body').querySelector('[data-agent-identity]');
        var id=(root&&window.SkipperIdentity)?window.SkipperIdentity.read(root):{color:'',character:''};
        var status=document.getElementById('sk-skipper-identity-status');
        fetch('/api/config/skipper-identity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(id)})
          .then(function(r){return r.json();})
          .then(function(res){status.textContent=res.ok?'Saved':(res.error||'Failed');setTimeout(function(){status.textContent='';},1500);})
          .catch(function(e){status.textContent=String(e);});
      });
    })();</script>
  </div>
  ${agentIdentityPickerScript()}`;
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
    <style>
      /* Clearer visual separation between config sections. Scoped with :where()
         (zero specificity) so themes that give panels their own chrome — win95
         title bars, geocities, artemis glass — keep it and win. The token-only
         dark themes, where stacked panels blur together behind an 8% hairline,
         instead get a tinted header bar, a firmer border, and card elevation.
         No border-radius: the UI reads square everywhere and it avoids rounding
         win95's beveled panels. */
      :where(.sk-config) .sk-panel {
        border-color: var(--sk-border-subtle);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.30);
      }
      :where(.sk-config) .sk-panel__header {
        background: var(--sk-surface-2);
        border-bottom-color: var(--sk-border-subtle);
        min-height: 2.6rem;
      }
      :where(.sk-config) .sk-panel__title {
        font-size: var(--sk-text-base);
        letter-spacing: 0.06em;
      }
    </style>
    <div class="sk-container sk-config">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Configuration</h1>
      </div>

      <!-- Appearance Section (first) -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Appearance</span>
        </div>
        <div class="sk-panel__body">
          <div class="sk-flex sk-items-center sk-gap-3">
            <label class="sk-muted sk-text-xs">Theme:</label>
            ${themePickerFragment()}
            <span class="sk-text-xs sk-muted">Applies immediately. Stored in this browser.</span>
          </div>
        </div>
      </div>


      <!-- Task Execution Section -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Task Execution</span>
        </div>
        <div class="sk-panel__body">
          <label class="sk-checkbox" style="margin-top:0;">
            <input type="checkbox" id="parallel-tasks-enabled" name="enabled" ${vm.parallelExecution ? "checked" : ""}
              hx-post="/api/settings/parallel-tasks" hx-trigger="change" hx-swap="none" hx-include="this">
            <span class="sk-checkbox__toggle"></span>
            <span class="sk-checkbox__label">Run tasks in parallel</span>
          </label>
          <p class="sk-muted sk-text-xs" style="margin:var(--sk-space-2) 0 0;">
            When on, the daemon runs multiple approved tasks at once. When off, tasks run one at a time.
          </p>
        </div>
      </div>

      ${modelSettingsPanel(vm.modelSettings)}

      ${isExperimental() ? skipperCharacterPanel(vm.skipperIdentity) : ""}

      ${isExperimental() && vm.taskMemory ? taskMemoryPanel(vm.taskMemory) : ""}

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

      <!-- Auto Update Section -->
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Auto Update</span>
          <span class="sk-text-xs sk-muted" style="margin-left:auto;">Current: ${escapeHtml(vm.autoUpdate.currentVersion === "dev" ? "dev" : "v" + vm.autoUpdate.currentVersion)}${vm.autoUpdate.availableVersion ? ` · latest available: v${escapeHtml(vm.autoUpdate.availableVersion)}` : ""}</span>
        </div>
        <div class="sk-panel__body">
          <label class="sk-checkbox" style="margin-top:0;">
            <input type="checkbox" id="auto-update-enabled" name="enabled" ${vm.autoUpdate.enabled ? "checked" : ""}
              hx-post="/api/config/auto-update" hx-trigger="change" hx-swap="none" hx-include="this">
            <span class="sk-checkbox__toggle"></span>
            <span class="sk-checkbox__label">Automatically apply patch updates</span>
          </label>
          <p class="sk-muted sk-text-xs" style="margin:var(--sk-space-2) 0 0;">
            When this is on, <strong>patch</strong> releases (x.y.<strong>Z</strong>) are downloaded and applied automatically, and Skipper
            restarts itself <strong>only when no task is running</strong>. <strong>Minor and major</strong>
            updates are never auto-applied — run <code>skipper update</code> then <code>skipper restart</code> yourself. Applies to installed binaries only.
          </p>
        </div>
      </div>

      <!-- Task Auto-Delete Section (experimental only) -->
      ${isExperimental() ? `
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Task Auto-Delete</span>
        </div>
        <div class="sk-panel__body">
          <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
            Automatically delete finished tasks (completed or failed) once they have gone this many days without activity,
            measured from their last update. Active tasks are never touched. The daemon sweeps hourly. Set to <strong>0 to disable</strong>.
          </p>
          <div class="sk-flex sk-items-center sk-gap-3" style="margin-bottom:var(--sk-space-3);">
            <label class="sk-muted sk-text-xs" style="width:150px;" for="task-retention-days">Regular tasks (days):</label>
            <input type="number" id="task-retention-days" name="regular_days" min="0" max="3650" value="${vm.taskRetentionDays}"
              class="sk-input sk-input--sm" style="width:80px;"
              hx-post="/api/config/task-retention" hx-trigger="change" hx-swap="none" hx-include="this">
            <span class="sk-text-xs sk-muted">One-off tasks created directly.</span>
          </div>
          <div class="sk-flex sk-items-center sk-gap-3">
            <label class="sk-muted sk-text-xs" style="width:150px;" for="recurring-task-retention-days">Recurring runs (days):</label>
            <input type="number" id="recurring-task-retention-days" name="recurring_days" min="0" max="3650" value="${vm.recurringTaskRetentionDays}"
              class="sk-input sk-input--sm" style="width:80px;"
              hx-post="/api/config/task-retention" hx-trigger="change" hx-swap="none" hx-include="this">
            <span class="sk-text-xs sk-muted">Runs spawned by recurring/scheduled tasks (these pile up fastest).</span>
          </div>
        </div>
      </div>
      ` : ""}

      <!-- Skipper Connect Section (experimental only) -->
      ${isExperimental() ? `
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Skipper Connect</span>
        </div>
        <div class="sk-panel__body">
          <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
            Link this instance to a remote Skipper Connect service to control it from anywhere:
            its web app, REST API, and webhooks, plus public links for published artifacts. The daemon
            dials out over a single WebSocket and never exposes an inbound port. Provide the remote
            instance URL and paste its Connect API key (the instance identity is embedded in the key).
            Use the navbar toggle to enable or disable the live connection.
          </p>
          <form hx-post="/api/config/skipper-connect" hx-swap="none"
            hx-on::after-request="if(event.detail.successful&&event.target===this){window.location.reload();}">
            <div style="display:flex;flex-direction:column;gap:var(--sk-space-3);">
              <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="sc-url">Connect URL</label>
                <input type="text" id="sc-url" name="url"
                  value="${escapeHtml(vm.skipperConnectUrl)}"
                  placeholder="Remote instance URL, e.g. wss://your-instance.example"
                  class="sk-input sk-input--sm" style="flex:1;">
              </div>
              <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="sc-key">Connect API Key</label>
                <input type="password" id="sc-key" name="key"
                  placeholder="${vm.skipperConnectHasKey ? "(saved — enter to replace)" : "Paste connect JWT from dashboard"}"
                  class="sk-input sk-input--sm" style="flex:1;">
              </div>
              <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                <span class="sk-muted sk-text-xs" style="width:130px;">Status</span>
                <span hx-get="/api/settings/skipper-connect/status" hx-trigger="load, every 5s" hx-swap="outerHTML" class="sk-text-xs"><span style="width:7px;height:7px;border-radius:50%;background:var(--sk-text-subtle);display:inline-block;margin-right:4px;"></span>–</span>
              </div>
              <div>
                <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Save</button>
              </div>
            </div>
          </form>
        </div>
      </div>
      ` : ""}

      <!-- API Keys Section (experimental only) -->
      ${isExperimental() ? apiKeysPanel(vm.apiKeys) : ""}

      <!-- Slack Integration Section (experimental only) -->
      ${isExperimental() && vm.slack ? slackPanel(vm.slack) : ""}
    </div>
  `, "/config");
}

export function slackPanel(slack: SlackConfigView): string {
  return `
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Slack Integration</span>
        </div>
        <div class="sk-panel__body">
          <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
            Let Skipper post to Slack <strong>as your app</strong> (not as you) and drive tasks from Slack.
            Paste a Bot User OAuth token (<code>xoxb-…</code>) from your app's OAuth &amp; Permissions page.
            Turn the tools on per team via the "Enable Slack integration" checkbox on each team.
          </p>
          <details style="margin-bottom:var(--sk-space-3);">
            <summary class="sk-text-xs" style="cursor:pointer;font-weight:600;">Required Slack app setup &amp; permissions</summary>
            <div class="sk-muted sk-text-xs" style="margin-top:var(--sk-space-2);display:flex;flex-direction:column;gap:var(--sk-space-3);">
              <div>
                <strong>Bot Token Scopes</strong> — OAuth &amp; Permissions → Bot Token Scopes:
                <ul style="margin:var(--sk-space-1) 0 0;padding-left:var(--sk-space-4);">
                  <li><code>chat:write</code> — post &amp; update messages</li>
                  <li><code>channels:read</code>, <code>groups:read</code> — resolve <code>#channel</code> names to IDs</li>
                  <li><code>channels:history</code>, <code>groups:history</code> — read public / private channel messages</li>
                  <li><code>im:write</code> — open direct messages</li>
                  <li><code>users:read</code>, <code>users:read.email</code> — look up users (incl. DM by email)</li>
                  <li><code>commands</code> — added automatically when you create a slash command</li>
                </ul>
              </div>
              <div>
                <strong>App-Level Token</strong> — Basic Information → App-Level Tokens (the <code>xapp-…</code> token):
                <ul style="margin:var(--sk-space-1) 0 0;padding-left:var(--sk-space-4);">
                  <li><code>connections:write</code> — required for Socket Mode</li>
                </ul>
              </div>
              <div>
                <strong>Enable these features</strong> (left sidebar of your app config):
                <ul style="margin:var(--sk-space-1) 0 0;padding-left:var(--sk-space-4);">
                  <li><strong>Socket Mode</strong> — delivers slash commands, button clicks &amp; events with no public URL</li>
                  <li><strong>Interactivity &amp; Shortcuts</strong> — required for the Approve / Reject / Respond / Iterate buttons</li>
                  <li><strong>Slash Commands</strong> — create each command you want to bind to a team or recurring task</li>
                  <li><strong>Event Subscriptions</strong> — turn on <em>Enable Events</em>, then under "Subscribe to bot events" add
                    <code>message.channels</code> (public) and/or <code>message.groups</code> (private).
                    <strong>Required to capture thread replies as task notes</strong> — without it, replies in a task's thread are never received (escalations, reviews &amp; completion notices still post, they are outbound-only).</li>
                </ul>
              </div>
              <div>
                <strong>Then:</strong> invite the app to any channel it posts to (<code>/invite @YourApp</code>), and
                <strong>reinstall the app</strong> after changing scopes or adding commands.
              </div>
            </div>
          </details>
          <form hx-post="/api/config/slack" hx-swap="none"
            hx-on::after-request="if(event.detail.successful&&event.target===this){var b=this.querySelector('[data-save]');if(b){b.textContent='Saved';setTimeout(function(){b.textContent='Save';},1200);}}">
            <div style="display:flex;flex-direction:column;gap:var(--sk-space-3);">
              <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="slack-token">Bot Token</label>
                <input type="password" id="slack-token" name="bot_token" autocomplete="off"
                  placeholder="${slack.botTokenSet ? "(saved — enter to replace)" : "xoxb-…"}"
                  class="sk-input sk-input--sm" style="flex:1;">
              </div>
              <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="slack-channel">Default Channel</label>
                <input type="text" id="slack-channel" name="default_channel"
                  value="${escapeHtml(slack.defaultChannel)}"
                  placeholder="#general or C0123456789 (optional)"
                  class="sk-input sk-input--sm" style="flex:1;">
              </div>

              <hr style="border:none;border-top:1px solid var(--sk-border);margin:var(--sk-space-2) 0;">
              <p class="sk-muted sk-text-xs" style="margin:0;">
                <strong>Slash commands (Socket Mode).</strong> Drive Skipper from Slack with no public URL — paste the
                app-level token (<code>xapp-…</code>) below (see "Required Slack app setup" above). Bind each command to a
                team or a recurring task; only allowlisted Slack users can trigger actions.
              </p>
              <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="slack-app-token">App-Level Token</label>
                <input type="password" id="slack-app-token" name="app_token" autocomplete="off"
                  placeholder="${slack.appTokenSet ? "(saved — enter to replace)" : "xapp-…"}"
                  class="sk-input sk-input--sm" style="flex:1;">
              </div>
              <div style="display:flex;align-items:flex-start;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="slack-allowed-users">Allowed Users</label>
                <textarea id="slack-allowed-users" name="allowed_users" rows="2"
                  placeholder="U012ABCDEF, U345GHIJKL (Slack user IDs, comma or newline separated)"
                  class="sk-input sk-input--sm" style="flex:1;">${escapeHtml(slack.allowedUsers.join(", "))}</textarea>
              </div>
              <label class="sk-checkbox" style="margin-top:0;">
                <input type="checkbox" id="slack-socket-enabled" name="socket_enabled" ${slack.socketEnabled ? "checked" : ""}>
                <span class="sk-checkbox__toggle"></span>
                <span class="sk-checkbox__label">Enable Socket Mode (inbound slash commands, buttons &amp; thread replies)</span>
              </label>
              <p class="sk-muted sk-text-xs" style="margin:0;">
                Escalations, phase reviews &amp; completion notices post to each task's origin thread (or the default channel for tasks not started from Slack) — there is no separate push toggle; it is <strong>per-team</strong>, so enable Slack on each team. Action buttons need <strong>Interactivity</strong> enabled in your Slack app, and only allowlisted users can act. Capturing thread replies as notes additionally needs <strong>Event Subscriptions</strong> (see setup above).
              </p>

              <div style="display:flex;gap:var(--sk-space-2);align-items:center;">
                <button type="submit" data-save class="sk-btn sk-btn--sm sk-btn--primary">Save</button>
                <button type="button" class="sk-btn sk-btn--sm"
                  hx-post="/api/config/slack/test" hx-target="#slack-test-result" hx-swap="innerHTML">Test</button>
                <span id="slack-test-result" class="sk-text-xs sk-muted"></span>
              </div>
            </div>
          </form>
        </div>
      </div>`;
}


export interface ApiKeyData { id: string; name: string; created_at: string; }

export function apiKeysPanel(keys: ApiKeyData[], newKey?: { name: string; key: string }): string {
  const rows = keys.map(k =>
    `<tr><td>${escapeHtml(k.name)}</td><td class="sk-muted sk-text-xs">${escapeHtml(k.created_at)}</td><td><button class="sk-btn sk-btn--danger sk-btn--sm" hx-delete="/api/api-keys/${escapeHtml(k.id)}" hx-target="#sk-api-keys-panel" hx-swap="outerHTML" hx-confirm="Delete this API key?">Delete</button></td></tr>`
  ).join("");
  // One-time reveal: the plaintext key exists only in this response — the DB
  // stores its hash, so it can never be shown again.
  const newKeyBanner = newKey ? `
      <div class="sk-panel__body" style="border:1px solid var(--sk-accent);border-radius:var(--sk-radius);margin-bottom:var(--sk-space-3);padding:var(--sk-space-3);">
        <p class="sk-text-xs" style="margin-bottom:var(--sk-space-2);"><strong>${escapeHtml(newKey.name)}</strong> created. Copy the key now — it is shown only once:</p>
        <div style="display:flex;gap:var(--sk-space-2);align-items:center;">
          <code id="sk-new-api-key" class="sk-text-xs" style="user-select:all;word-break:break-all;">${escapeHtml(newKey.key)}</code>
          <button type="button" class="sk-btn sk-btn--sm"
            onclick="navigator.clipboard.writeText(document.getElementById('sk-new-api-key').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);})">Copy</button>
        </div>
      </div>` : "";
  return `<div id="sk-api-keys-panel" class="sk-panel" style="margin-bottom: var(--sk-space-6);">
    <div class="sk-panel__header"><span class="sk-panel__title">API Keys</span></div>
    <div class="sk-panel__body">
      <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
        Keys authenticate external MCP clients (Bearer on /mcp) and the JSON data API (Bearer on /data/*).
      </p>
      ${newKeyBanner}
      ${keys.length > 0 ? `<table class="sk-table"><thead><tr><th>Name</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="sk-muted sk-text-xs">No API keys</p>`}
      <form hx-post="/api/api-keys" hx-target="#sk-api-keys-panel" hx-swap="outerHTML" style="margin-top:var(--sk-space-3);display:flex;gap:var(--sk-space-2);align-items:end;">
        <input type="text" name="name" placeholder="Key name" class="sk-input sk-input--sm" required>
        <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Create</button>
      </form>
    </div>
  </div>`;
}

