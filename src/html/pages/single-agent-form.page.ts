import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { isExperimental } from "../../config/feature-flags";
import { agentIdentityPickerScript, identityPanel } from "../atoms/agent-identity-picker";
import { randomIdentity } from "../atoms/creature";
import type { SingleAgent } from "../../single-agents/store";

export interface SingleAgentFormViewModel {
  /** null when creating. */
  agent: SingleAgent | null;
  /** Provider allowlist (model-settings). Model itself is free text, per convention. */
  modelProviders: string[];
  /** Operator-defined tools grantable to this agent. Empty when none are defined. */
  customTools: { name: string; description: string }[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

// Raw JSON for an inline <script> body. HTML entities are not decoded inside
// <script>, so escapeHtml() would emit invalid JS - escape only the sequences
// that could terminate the element or open an HTML comment.
function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function customToolBox(t: { name: string; description: string }): string {
  return `<label class="sk-checkbox" style="align-items:flex-start;">
    <input type="checkbox" data-ct value="${escapeHtml(t.name)}">
    <span class="sk-checkbox__toggle"></span>
    <span class="sk-checkbox__label"><code>${escapeHtml(t.name)}</code>${t.description
      ? `<span class="tm-field__hint" style="display:block;margin:0;">${escapeHtml(t.description)}</span>`
      : ""}</span>
  </label>`;
}

/**
 * Create/edit form for a single agent. Built like the team map: one client-side
 * AGENT object seeded via jsonScript(), the fields load from it, and nothing
 * persists until Save POSTs the whole record as JSON.
 */
export function singleAgentFormPage(vm: SingleAgentFormViewModel): string {
  const isNew = vm.agent === null;
  const experimental = isExperimental();
  const agent: SingleAgent = vm.agent ?? {
    id: "",
    name: "",
    agent_type: "",
    model: "default",
    instruction: "",
    capabilities: [],
    config: {},
    created_at: "",
    updated_at: "",
  };

  const providerOptions = vm.modelProviders
    .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
    .join("");

  const slackPanel = experimental
    ? `
        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Slack</span></div>
          <div class="sk-panel__body">
            <div class="tm-field">
              <label class="sk-checkbox"><input type="checkbox" id="sa-slack">
                <span class="sk-checkbox__toggle"></span>
                <span class="sk-checkbox__label">Expose the Slack tools to this agent</span></label>
              <p class="tm-field__hint">Needs a Slack bot token under <a href="/config">Config</a>.</p>
            </div>
            <div class="tm-field" style="margin-top:var(--sk-space-3);">
              <label class="sk-label" for="sa-slash">Slash command</label>
              <input class="sk-input" id="sa-slash" type="text" placeholder="/researcher">
              <p class="tm-field__hint">Running it in Slack creates and auto-approves a task on this agent.</p>
            </div>
          </div>
        </div>`
    : "";

  const customToolsPanel = vm.customTools.length > 0
    ? `
        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Custom tools</span></div>
          <div class="sk-panel__body">
            <p class="tm-field__hint" style="margin-top:0;">Operator-defined tools granted to this agent.</p>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--sk-space-2);">
              ${vm.customTools.map(customToolBox).join("")}
            </div>
          </div>
        </div>`
    : "";

  return v2layout(isNew ? "New headless CLI agent" : agent.name, `
    ${navbar({ currentPath: "/agent-library", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="tm-shell">
      <div class="tm-topbar">
        <a class="tm-topbar__back" href="/agent-library">&larr; Agents</a>
        <div class="tm-topbar__heading">
          <h1 class="tm-topbar__title">${escapeHtml(isNew ? "New headless CLI agent" : agent.name)}<span class="tm-dot" id="sa-dirty" hidden title="Unsaved changes"></span></h1>
          <div class="tm-topbar__sub">A headless CLI agent that runs one task by itself.</div>
        </div>
        <div class="tm-topbar__actions">
          <span class="tm-error" id="sa-error"></span>
          ${isNew ? "" : `<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" id="sa-delete">Delete</button>`}
          <button type="button" class="sk-btn sk-btn--sm sk-btn--primary" id="sa-save">${isNew ? "Create agent" : "Save"}</button>
        </div>
      </div>

      <div id="sa-form">
        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Agent</span></div>
          <div class="sk-panel__body">
            <div class="tm-field">
              <label class="sk-label" for="sa-name">Name</label>
              <input class="sk-input" id="sa-name" type="text" placeholder="e.g. Researcher">
            </div>
            <div class="tm-field__row" style="margin-top:var(--sk-space-3);">
              <div class="tm-field">
                <label class="sk-label" for="sa-provider">Provider</label>
                <select class="sk-select" id="sa-provider">${providerOptions}</select>
              </div>
              <div class="tm-field">
                <label class="sk-label" for="sa-model">Model</label>
                <input class="sk-input" id="sa-model" type="text" placeholder="default" autocomplete="off" spellcheck="false">
                <p class="tm-field__hint">Any model name the provider accepts, e.g. <code>claude-opus-5</code>, <code>claude-sonnet-4-6</code>.</p>
              </div>
            </div>
            <div class="tm-field" style="margin-top:var(--sk-space-3);">
              <label class="sk-label" for="sa-capabilities">Capabilities</label>
              <input class="sk-input" id="sa-capabilities" type="text" placeholder="e.g. research, web (comma-separated)">
              <p class="tm-field__hint">Optional. Comma-separated tags.</p>
            </div>
          </div>
        </div>

        ${identityPanel((() => {
          // A fresh agent gets a random color + creature by default (experimental).
          const def = (isNew && experimental) ? randomIdentity() : null;
          return {
            color: agent.config?.color ?? def?.color,
            character: agent.config?.character ?? def?.character,
            experimental,
          };
        })())}

        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Instruction</span></div>
          <div class="sk-panel__body">
            <div class="tm-field">
              <textarea class="sk-textarea tm-field__prompt" id="sa-instruction" placeholder="System prompt for this agent..."></textarea>
              <p class="tm-field__hint">The agent's system prompt. The task instructions arrive separately as the first message.</p>
            </div>
          </div>
        </div>
        ${slackPanel}
        ${customToolsPanel}
      </div>
    </div>
    ${agentIdentityPickerScript()}

    <script>
    (function(){
      var AGENT = ${jsonScript(agent)};
      var IS_NEW = ${isNew ? "true" : "false"};
      var EXPERIMENTAL = ${experimental ? "true" : "false"};
      var MODEL_PROVIDERS = ${jsonScript(vm.modelProviders)};
      var CUSTOM_TOOLS = ${jsonScript(vm.customTools)};

      var $ = function(id){ return document.getElementById(id); };
      var dirty = false;
      function markDirty(){ dirty = true; var d = $('sa-dirty'); if (d) d.hidden = false; }
      function showError(msg){ var e = $('sa-error'); if (e) e.textContent = msg || ''; }

      // Keep the stored provider selectable even when it is not in the allowlist,
      // so editing an agent never silently changes its provider.
      function setProvider(value){
        var sel = $('sa-provider');
        if (!sel) return;
        if (value && !Array.prototype.some.call(sel.options, function(o){ return o.value === value; })) {
          var opt = document.createElement('option');
          opt.value = value; opt.textContent = value;
          sel.insertBefore(opt, sel.firstChild);
        }
        sel.value = value || '';
      }

      function setCts(values){
        var want = {};
        (values || []).forEach(function(v){ want[v] = true; });
        Array.prototype.forEach.call(document.querySelectorAll('[data-ct]'), function(b){ b.checked = !!want[b.value]; });
      }
      function readCts(){
        return Array.prototype.filter.call(document.querySelectorAll('[data-ct]'), function(b){ return b.checked; })
          .map(function(b){ return b.value; });
      }

      // ── Load ──────────────────────────────────────────────────────────
      $('sa-name').value = AGENT.name || '';
      setProvider(AGENT.agent_type || (MODEL_PROVIDERS[0] || ''));
      $('sa-model').value = (AGENT.model && AGENT.model !== 'default') ? AGENT.model : '';
      $('sa-instruction').value = AGENT.instruction || '';
      $('sa-capabilities').value = (AGENT.capabilities || []).join(', ');
      var cfg0 = AGENT.config || {};
      if (EXPERIMENTAL) {
        if ($('sa-slack')) $('sa-slack').checked = cfg0.slackEnabled === true;
        if ($('sa-slash')) $('sa-slash').value = cfg0.slashCommand || '';
      }
      if (CUSTOM_TOOLS.length) setCts(cfg0.customTools || []);

      // ── Collect ───────────────────────────────────────────────────────
      // Base the config on the stored record so a section that is not rendered
      // (Slack when non-experimental, custom tools when none are defined) keeps
      // its stored value instead of being read as cleared.
      function collect(){
        var caps = $('sa-capabilities').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
        var stored = AGENT.config || {};
        var cfg = { slackEnabled: stored.slackEnabled === true };
        if (stored.slashCommand) cfg.slashCommand = stored.slashCommand;
        if (stored.customTools && stored.customTools.length) cfg.customTools = stored.customTools;
        if (EXPERIMENTAL) {
          if ($('sa-slack')) cfg.slackEnabled = $('sa-slack').checked;
          if ($('sa-slash')) cfg.slashCommand = $('sa-slash').value.trim();
        }
        if (CUSTOM_TOOLS.length) cfg.customTools = readCts();
        var idRoot = document.querySelector('#sa-form [data-agent-identity]');
        var ident = (idRoot && window.SkipperIdentity) ? window.SkipperIdentity.read(idRoot) : { color: stored.color, character: stored.character };
        cfg.color = ident.color;
        cfg.character = ident.character || null;
        return {
          name: $('sa-name').value.trim(),
          agent_type: $('sa-provider').value,
          model: $('sa-model').value.trim(),
          instruction: $('sa-instruction').value,
          capabilities: caps,
          config: cfg
        };
      }

      // ── Save / delete ─────────────────────────────────────────────────
      var saveBtn = $('sa-save');
      saveBtn.addEventListener('click', function(){
        showError('');
        var payload = collect();
        if (!payload.name) { showError('An agent needs a name.'); return; }
        if (!payload.agent_type) { showError('Pick a provider.'); return; }
        var url = IS_NEW ? '/api/single-agents' : '/api/single-agents/' + encodeURIComponent(AGENT.id) + '/update';
        var label = saveBtn.textContent;
        saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
          .then(function(r){ return r.json().then(function(b){ return { ok: r.ok, body: b }; }); })
          .then(function(res){
            if (!res.ok) { showError(res.body.error || 'Save failed.'); saveBtn.disabled = false; saveBtn.textContent = label; return; }
            dirty = false;
            var d = $('sa-dirty'); if (d) d.hidden = true;
            if (IS_NEW && res.body.id) { window.location.href = '/single-agents/' + encodeURIComponent(res.body.id); return; }
            saveBtn.textContent = 'Saved';
            setTimeout(function(){ saveBtn.textContent = label; saveBtn.disabled = false; }, 1200);
          })
          .catch(function(err){ showError(String(err)); saveBtn.disabled = false; saveBtn.textContent = label; });
      });

      var del = $('sa-delete');
      if (del) del.addEventListener('click', function(){
        if (!window.confirm('Delete agent "' + (AGENT.name || '') + '"? This cannot be undone.')) return;
        fetch('/api/single-agents/' + encodeURIComponent(AGENT.id), { method: 'DELETE' })
          .then(function(){ dirty = false; window.location.href = '/agent-library'; });
      });

      // ── Dirty guard ───────────────────────────────────────────────────
      Array.prototype.forEach.call(document.querySelectorAll('#sa-form input, #sa-form textarea, #sa-form select'), function(elm){
        elm.addEventListener('input', markDirty);
        elm.addEventListener('change', markDirty);
      });
      window.addEventListener('beforeunload', function(e){ if (!dirty) return; e.preventDefault(); e.returnValue = ''; });
    })();
    </script>
  `, "/agent-library");
}
