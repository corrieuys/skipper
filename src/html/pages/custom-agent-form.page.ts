import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { agentIdentityPicker, agentIdentityPickerScript } from "../atoms/agent-identity-picker";
import { isExperimental } from "../../config/feature-flags";
import { randomIdentity } from "../atoms/creature";
import { LOCAL_TOOLS } from "../../custom-agents/tools/registry";
import { MCP_TOOL_GROUPS } from "../../custom-agents/mcp-catalogue";
import type { CustomAgent } from "../../custom-agents/store";
import { qualifyToolName, type McpServerRecord } from "../../custom-agents/servers";
import type { CustomTool } from "../../custom-tools/store";

export interface SkillChoice {
  name: string;
  description: string;
}

export interface CustomAgentFormViewModel {
  /** null when creating. */
  agent: CustomAgent | null;
  skills: SkillChoice[];
  /** Registered MCP servers, rendered from their cached tool catalogues. */
  mcpServers: McpServerRecord[];
  /** Operator-defined tools available to grant. */
  customTools: CustomTool[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

// Raw JSON for an inline <script> body. HTML entities are not decoded inside
// <script>, so escapeHtml() would emit invalid JS — escape only the sequences
// that could terminate the element or open an HTML comment.
function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const BLANK = {
  id: "",
  name: "",
  description: "",
  baseUrl: "",
  modelId: "",
  apiKey: "",
  headers: {} as Record<string, string>,
  queryParams: {} as Record<string, string>,
  systemPrompt: "",
  enabledTools: [] as string[],
  enabledMcpTools: [] as string[],
  enabledServerTools: [] as string[],
  enabledCustomTools: [] as string[],
  enabledSkills: [] as string[],
  maxSteps: 40,
  temperature: null as number | null,
  color: null as string | null,
  character: null as string | null,
};

/**
 * Custom agent editor. The whole form is one client-side AGENT object that Save
 * POSTs as JSON, matching how the team map works — a header row or a tool
 * checkbox is a mutation, not a round trip.
 *
 * Secrets are never rendered. A stored key arrives as the sentinel the API sends
 * and is shown as an empty field with a "leave blank to keep" hint; blank on save
 * means unchanged.
 */
export function customAgentFormPage(vm: CustomAgentFormViewModel): string {
  const isNew = vm.agent === null;
  const agent = vm.agent ?? BLANK;

  const toolRows = LOCAL_TOOLS.map((t) => checkboxRow("tool", t.id, t.label, t.description, t.writes)).join("");

  const mcpGroups = MCP_TOOL_GROUPS.map((group) => `
    <div class="ca-group">
      <div class="ca-group__head">
        <span class="ca-group__label">${escapeHtml(group.label)}</span>
        <button type="button" class="sk-btn sk-btn--sm" data-group-all="${escapeHtml(group.key)}">Toggle all</button>
      </div>
      <p class="ca-group__hint">${escapeHtml(group.hint)}</p>
      <div class="ca-checks" data-group="${escapeHtml(group.key)}">
        ${group.tools.map((t) => checkboxRow("mcp", t.name, t.label, t.description, false, t.rootOnly)).join("")}
      </div>
    </div>`).join("");

  const serverGroups = vm.mcpServers.length > 0
    ? vm.mcpServers.map((server) => {
      if (server.toolCatalogue.length === 0) {
        return `
    <div class="ca-group">
      <div class="ca-group__head"><span class="ca-group__label">${escapeHtml(server.name)}</span></div>
      <p class="ca-group__hint">${server.catalogueError
        ? `Could not read this server's tools: ${escapeHtml(server.catalogueError)}`
        : "This server reported no tools."} Fix it on the Config page, then refresh it there.</p>
    </div>`;
      }
      return `
    <div class="ca-group">
      <div class="ca-group__head">
        <span class="ca-group__label">${escapeHtml(server.name)}</span>
        <button type="button" class="sk-btn sk-btn--sm" data-group-all="srv-${escapeHtml(server.slug)}">Toggle all</button>
      </div>
      <p class="ca-group__hint">Exposed to the agent as <code>${escapeHtml(server.slug)}__&lt;tool&gt;</code>.${server.catalogueError
        ? ` Last refresh failed: ${escapeHtml(server.catalogueError)} — this list may be stale.`
        : ""}</p>
      <div class="ca-checks" data-group="srv-${escapeHtml(server.slug)}">
        ${server.toolCatalogue.map((t) =>
        checkboxRow("server", qualifyToolName(server.slug, t.name), t.name, t.description, false)).join("")}
      </div>
    </div>`;
    }).join("")
    : `<p class="sk-muted sk-text-xs">No MCP servers registered. Add one under <strong>MCP Servers</strong> on the <a href="/agent-library">Agents</a> page and its tools will appear here.</p>`;

  const customToolRows = vm.customTools.length > 0
    ? vm.customTools.map((t) => checkboxRow("custom", t.name, t.name, t.description, false)).join("")
    : `<p class="sk-muted sk-text-xs">No custom tools defined. Add one under <strong>Custom Tools</strong> on the <a href="/agent-library">Agents</a> page.</p>`;

  const skillRows = vm.skills.length > 0
    ? vm.skills.map((s) => checkboxRow("skill", s.name, s.name, s.description, false)).join("")
    : `<p class="sk-muted sk-text-xs">No skills found on this machine. Skipper reads them from <code>~/.claude/skills</code> and <code>~/.agents/skills</code>.</p>`;

  const content = `
    ${navbar({ currentPath: "/agent-library", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <style>
      .ca-form { display:flex; flex-direction:column; gap:var(--sk-space-6); }
      .ca-row { display:grid; grid-template-columns:1fr 1fr; gap:var(--sk-space-4); }
      .ca-field { display:flex; flex-direction:column; gap:var(--sk-space-1); }
      .ca-hint { margin:0; font-size:var(--sk-text-xs); color:var(--sk-text-muted); }
      .ca-checks { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:var(--sk-space-2); }
      .ca-check { display:flex; gap:var(--sk-space-2); align-items:flex-start; padding:var(--sk-space-2);
                  border:1px solid var(--sk-border-subtle); border-radius:var(--sk-radius-sm); }
      .ca-check input { margin-top:0.2rem; }
      .ca-check__label { font-size:var(--sk-text-sm); }
      .ca-check__desc { display:block; font-size:var(--sk-text-xs); color:var(--sk-text-muted); }
      .ca-tag { font-size:0.65rem; text-transform:uppercase; letter-spacing:0.05em;
                border:1px solid var(--sk-border-subtle); border-radius:var(--sk-radius-sm);
                padding:0 0.3rem; color:var(--sk-text-muted); margin-left:0.35rem; }
      .ca-group { margin-bottom:var(--sk-space-4); }
      .ca-group__head { display:flex; align-items:center; justify-content:space-between; }
      .ca-group__label { font-weight:600; font-size:var(--sk-text-sm); }
      .ca-group__hint { margin:0 0 var(--sk-space-2); font-size:var(--sk-text-xs); color:var(--sk-text-muted); }
      .ca-pairs { display:flex; flex-direction:column; gap:var(--sk-space-2); }
      .ca-pair { display:grid; grid-template-columns:1fr 1fr auto; gap:var(--sk-space-2); }
      .ca-probe { font-size:var(--sk-text-xs); margin-left:var(--sk-space-2); }
      .ca-probe--ok { color:var(--sk-success, #4ade80); }
      .ca-probe--err { color:var(--sk-danger, #f87171); }
    </style>
    <div class="tm-shell">
      <div class="tm-topbar">
        <a class="tm-topbar__back" href="/agent-library">&larr; Agents</a>
        <div class="tm-topbar__heading">
          <h1 class="tm-topbar__title">${escapeHtml(isNew ? "New custom agent" : agent.name)}<span class="tm-dot" id="ca-dirty" hidden title="Unsaved changes"></span></h1>
          <div class="tm-topbar__sub">A custom agent that runs in-process against its own endpoint.</div>
        </div>
        <div class="tm-topbar__actions">
          <span class="tm-error" id="ca-error"></span>
          ${isNew ? "" : `<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" id="ca-delete">Delete</button>`}
          <button type="button" class="sk-btn sk-btn--sm sk-btn--primary" id="ca-save">${isNew ? "Create agent" : "Save"}</button>
        </div>
      </div>

      <div class="ca-form">
        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Identity</span></div>
          <div class="sk-panel__body">
            <div class="ca-row">
              <div class="ca-field"><label class="sk-label" for="ca-name">Name</label>
                <input class="sk-input" id="ca-name" type="text" placeholder="e.g. Research Assistant"></div>
              <div class="ca-field"><label class="sk-label" for="ca-desc">Description</label>
                <input class="sk-input" id="ca-desc" type="text" placeholder="What this agent is for (optional)"></div>
            </div>
            <div class="ca-field" style="margin-top:var(--sk-space-3);">
              <label class="sk-label">Color &amp; character</label>
              ${agentIdentityPicker((() => {
                // A fresh agent gets a random color + creature by default (experimental).
                const def = (isNew && isExperimental()) ? randomIdentity() : null;
                return {
                  color: agent.color ?? def?.color,
                  character: agent.character ?? def?.character,
                  experimental: isExperimental(),
                };
              })())}
            </div>
          </div>
        </div>

        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Endpoint</span></div>
          <div class="sk-panel__body">
            <div class="ca-row">
              <div class="ca-field"><label class="sk-label" for="ca-url">Base URL</label>
                <input class="sk-input" id="ca-url" type="text" placeholder="https://api.openai.com/v1">
                <p class="ca-hint">The API root, not the /chat/completions path. Local servers work too:
                  LM Studio is <code>http://localhost:1234/v1</code>, llama-server is <code>http://localhost:8080/v1</code>,
                  Ollama is <code>http://localhost:11434/v1</code>.</p>
              </div>
              <div class="ca-field"><label class="sk-label" for="ca-model">Model</label>
                <input class="sk-input" id="ca-model" type="text" list="ca-model-list" placeholder="gpt-4.1-mini">
                <datalist id="ca-model-list"></datalist>
                <p class="ca-hint">
                  <button type="button" class="sk-btn sk-btn--sm" id="ca-probe">Test connection</button>
                  <span id="ca-probe-result" class="ca-probe"></span>
                </p>
              </div>
            </div>
            <div class="ca-field" style="margin-top:var(--sk-space-3);">
              <label class="sk-label" for="ca-key">API key</label>
              <input class="sk-input" id="ca-key" type="password" autocomplete="off" placeholder="">
              <p class="ca-hint" id="ca-key-hint">
                Leave blank for a local server that needs no authentication.
                You can also write <code>\${MY_API_KEY}</code> to read it from the daemon's environment
                instead of storing it here.
              </p>
            </div>

            <div class="ca-field" style="margin-top:var(--sk-space-4);">
              <label class="sk-label">Extra headers</label>
              <p class="ca-hint">For providers that do not use a bearer token, e.g. Azure's <code>api-key</code>,
                or attribution headers. Values may use <code>\${ENV_VAR}</code>.</p>
              <div class="ca-pairs" id="ca-headers"></div>
              <button type="button" class="sk-btn sk-btn--sm" id="ca-add-header" style="align-self:flex-start;margin-top:var(--sk-space-2);">+ Header</button>
            </div>

            <div class="ca-field" style="margin-top:var(--sk-space-4);">
              <label class="sk-label">Query parameters</label>
              <p class="ca-hint">Appended to every request URL. Azure OpenAI requires <code>api-version</code>; nothing else normally needs this.</p>
              <div class="ca-pairs" id="ca-query"></div>
              <button type="button" class="sk-btn sk-btn--sm" id="ca-add-query" style="align-self:flex-start;margin-top:var(--sk-space-2);">+ Parameter</button>
            </div>
          </div>
        </div>

        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">System prompt</span></div>
          <div class="sk-panel__body">
            <textarea class="sk-input" id="ca-prompt" rows="10" placeholder="Who this agent is and how it should work."></textarea>
            <p class="ca-hint">Skipper appends the working directory, the tool list, and any enabled skills.
              The task instructions arrive separately as the first message.</p>
          </div>
        </div>

        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Tools</span></div>
          <div class="sk-panel__body">
            <p class="ca-hint" style="margin-bottom:var(--sk-space-3);">
              Only what you enable here is sent to the model. A disabled tool is not described to it at all.
            </p>
            <div class="ca-group">
              <div class="ca-group__head"><span class="ca-group__label">Files</span></div>
              <p class="ca-group__hint">Skipper's own tools. They resolve paths against the task's working directory and cannot leave it.</p>
              <div class="ca-checks">${toolRows}</div>
            </div>
            <div class="ca-group__head" style="margin-top:var(--sk-space-5);"><span class="ca-group__label">Skipper tools</span></div>
            <p class="ca-group__hint">The same MCP tools a CLI agent gets. What a run actually receives is
              also limited by the session: a delegated agent never gets phase control.</p>
            ${mcpGroups}

            <div class="ca-group__head" style="margin-top:var(--sk-space-5);"><span class="ca-group__label">MCP server tools</span></div>
            <p class="ca-group__hint">Tools from the MCP servers registered on the Config page. The list is what each
              server reported when it was last refreshed.</p>
            ${serverGroups}

            <div class="ca-group__head" style="margin-top:var(--sk-space-5);"><span class="ca-group__label">Custom tools</span></div>
            <p class="ca-group__hint">Tools you defined on the Config page. Ticking one here gives it to this agent
              everywhere it is used; a team can grant more on top.</p>
            <div class="ca-checks">${customToolRows}</div>
          </div>
        </div>

        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Skills</span></div>
          <div class="sk-panel__body">
            <p class="ca-hint" style="margin-bottom:var(--sk-space-3);">
              Enabled skills are listed in the system prompt by name and summary. The agent pulls the full text
              with <code>load_skill</code> when it needs one.
            </p>
            <div class="ca-checks">${skillRows}</div>
          </div>
        </div>

        <div class="sk-panel">
          <div class="sk-panel__header"><span class="sk-panel__title">Limits</span></div>
          <div class="sk-panel__body">
            <div class="ca-row">
              <div class="ca-field"><label class="sk-label" for="ca-steps">Max steps</label>
                <input class="sk-input" id="ca-steps" type="number" min="1" max="200">
                <p class="ca-hint">How many tool-use rounds one run may take before it stops.</p>
              </div>
              <div class="ca-field"><label class="sk-label" for="ca-temp">Temperature</label>
                <input class="sk-input" id="ca-temp" type="number" min="0" max="2" step="0.1" placeholder="provider default">
                <p class="ca-hint">Leave blank to let the provider decide.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
    (function(){
      var AGENT = ${jsonScript(agent)};
      var IS_NEW = ${isNew ? "true" : "false"};
      var STORED = "__stored__";

      var $ = function(id){ return document.getElementById(id); };
      function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]; }); }

      var dirty = false;
      function markDirty(){ dirty = true; var d = $('ca-dirty'); if (d) d.hidden = false; }

      // ── Key/value rows ────────────────────────────────────────────────
      // A stored secret arrives as the sentinel and is rendered blank, so an
      // untouched row saves as "" and the server keeps what it already has.
      function renderPairs(hostId, obj, secret){
        var host = $(hostId);
        host.innerHTML = '';
        Object.keys(obj).forEach(function(k){ addPair(hostId, k, obj[k] === STORED ? '' : obj[k], secret); });
      }
      function addPair(hostId, key, value, secret){
        var host = $(hostId);
        var row = document.createElement('div');
        row.className = 'ca-pair';
        row.innerHTML =
          '<input class="sk-input" data-k type="text" placeholder="name" value="' + esc(key || '') + '">' +
          '<input class="sk-input" data-v type="' + (secret ? 'password' : 'text') + '" placeholder="' +
            (secret ? 'blank keeps the stored value' : 'value') + '" value="' + esc(value || '') + '">' +
          '<button type="button" class="sk-btn sk-btn--sm sk-btn--danger">&times;</button>';
        row.querySelector('button').addEventListener('click', function(){ row.remove(); });
        host.appendChild(row);
      }
      function readPairs(hostId){
        var out = {};
        Array.prototype.forEach.call($(hostId).querySelectorAll('.ca-pair'), function(row){
          var k = row.querySelector('[data-k]').value.trim();
          if (!k) return;
          out[k] = row.querySelector('[data-v]').value;
        });
        return out;
      }

      // ── Checkboxes ────────────────────────────────────────────────────
      function setChecks(kind, values){
        var wanted = {};
        (values || []).forEach(function(v){ wanted[v] = true; });
        Array.prototype.forEach.call(document.querySelectorAll('[data-kind="' + kind + '"]'), function(box){
          box.checked = !!wanted[box.value];
        });
      }
      function readChecks(kind){
        return Array.prototype.filter.call(
          document.querySelectorAll('[data-kind="' + kind + '"]'),
          function(box){ return box.checked; }
        ).map(function(box){ return box.value; });
      }

      // ── Load ──────────────────────────────────────────────────────────
      $('ca-name').value = AGENT.name || '';
      $('ca-desc').value = AGENT.description || '';
      $('ca-url').value = AGENT.baseUrl || '';
      $('ca-model').value = AGENT.modelId || '';
      $('ca-prompt').value = AGENT.systemPrompt || '';
      $('ca-steps').value = AGENT.maxSteps == null ? 40 : AGENT.maxSteps;
      $('ca-temp').value = AGENT.temperature == null ? '' : AGENT.temperature;
      if (AGENT.apiKey === STORED) {
        $('ca-key').placeholder = 'stored — leave blank to keep';
      }
      renderPairs('ca-headers', AGENT.headers || {}, true);
      renderPairs('ca-query', AGENT.queryParams || {}, false);
      setChecks('tool', AGENT.enabledTools);
      setChecks('mcp', AGENT.enabledMcpTools);
      setChecks('server', AGENT.enabledServerTools);
      setChecks('custom', AGENT.enabledCustomTools);
      setChecks('skill', AGENT.enabledSkills);

      $('ca-add-header').addEventListener('click', function(){ addPair('ca-headers', '', '', true); });
      $('ca-add-query').addEventListener('click', function(){ addPair('ca-query', '', '', false); });

      Array.prototype.forEach.call(document.querySelectorAll('[data-group-all]'), function(btn){
        btn.addEventListener('click', function(){
          var boxes = document.querySelectorAll('[data-group="' + btn.dataset.groupAll + '"] input[type=checkbox]');
          var allOn = Array.prototype.every.call(boxes, function(b){ return b.checked; });
          Array.prototype.forEach.call(boxes, function(b){ b.checked = !allOn; });
        });
      });

      // ── Collect ───────────────────────────────────────────────────────
      function collect(){
        var temp = $('ca-temp').value.trim();
        var idRoot = document.querySelector('.ca-form [data-agent-identity]');
        var ident = (idRoot && window.SkipperIdentity) ? window.SkipperIdentity.read(idRoot) : { color: AGENT.color, character: AGENT.character };
        return {
          id: AGENT.id || undefined,
          name: $('ca-name').value.trim(),
          description: $('ca-desc').value.trim(),
          baseUrl: $('ca-url').value.trim(),
          modelId: $('ca-model').value.trim(),
          apiKey: $('ca-key').value,
          headers: readPairs('ca-headers'),
          queryParams: readPairs('ca-query'),
          systemPrompt: $('ca-prompt').value,
          enabledTools: readChecks('tool'),
          enabledMcpTools: readChecks('mcp'),
          enabledServerTools: readChecks('server'),
          enabledCustomTools: readChecks('custom'),
          enabledSkills: readChecks('skill'),
          maxSteps: Number($('ca-steps').value || 40),
          temperature: temp === '' ? null : Number(temp),
          color: ident.color,
          character: ident.character || null
        };
      }

      function showError(msg){ $('ca-error').textContent = msg || ''; }

      // ── Test connection ───────────────────────────────────────────────
      $('ca-probe').addEventListener('click', function(){
        var out = $('ca-probe-result');
        out.className = 'ca-probe';
        out.textContent = 'checking…';
        fetch('/api/custom-agents/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collect())
        }).then(function(r){ return r.json(); }).then(function(res){
          out.className = 'ca-probe ' + (res.ok ? 'ca-probe--ok' : 'ca-probe--err');
          out.textContent = res.message || res.error || (res.ok ? 'ok' : 'failed');
          var list = $('ca-model-list');
          list.innerHTML = (res.models || []).map(function(m){
            return '<option value="' + esc(m) + '"></option>';
          }).join('');
        }).catch(function(err){
          out.className = 'ca-probe ca-probe--err';
          out.textContent = String(err);
        });
      });

      // ── Save / delete ─────────────────────────────────────────────────
      $('ca-save').addEventListener('click', function(){
        showError('');
        var url = IS_NEW ? '/api/custom-agents' : '/api/custom-agents/' + encodeURIComponent(AGENT.id) + '/update';
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collect())
        }).then(function(r){ return r.json().then(function(b){ return { ok: r.ok, body: b }; }); })
          .then(function(res){
            if (!res.ok) { showError(res.body.error || 'Save failed'); return; }
            dirty = false;
            window.location.href = '/agent-library';
          })
          .catch(function(err){ showError(String(err)); });
      });

      var del = $('ca-delete');
      if (del) del.addEventListener('click', function(){
        if (!window.confirm('Delete this agent? Team members using it will need a different provider.')) return;
        fetch('/api/custom-agents/' + encodeURIComponent(AGENT.id), { method: 'DELETE' })
          .then(function(){ dirty = false; window.location.href = '/agent-library'; });
      });

      // ── Dirty guard ───────────────────────────────────────────────────
      Array.prototype.forEach.call(document.querySelectorAll('.ca-form input, .ca-form textarea, .ca-form select'), function(elm){
        elm.addEventListener('input', markDirty);
        elm.addEventListener('change', markDirty);
      });
      window.addEventListener('beforeunload', function(e){ if (!dirty) return; e.preventDefault(); e.returnValue = ''; });
    })();
    </script>
    ${agentIdentityPickerScript()}`;

  return v2layout(isNew ? "New custom agent" : agent.name, content, "/agent-library");
}

function checkboxRow(
  kind: "tool" | "mcp" | "skill" | "server" | "custom",
  value: string,
  label: string,
  description: string,
  writes: boolean,
  rootOnly?: boolean,
): string {
  const tags = [
    writes ? `<span class="ca-tag">writes</span>` : "",
    rootOnly ? `<span class="ca-tag">root only</span>` : "",
  ].join("");
  return `
    <label class="ca-check">
      <input type="checkbox" data-kind="${kind}" value="${escapeHtml(value)}">
      <span>
        <span class="ca-check__label">${escapeHtml(label)}${tags}</span>
        <span class="ca-check__desc">${escapeHtml(description)}</span>
      </span>
    </label>`;
}
