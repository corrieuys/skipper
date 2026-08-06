import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import type { CustomAgent } from "../../custom-agents/store";
import type { McpServerRecord } from "../../custom-agents/servers";
import { PARAM_TYPES, type CustomTool, type ToolParameter } from "../../custom-tools/store";

export interface CustomAgentsPageViewModel {
  agents: CustomAgent[];
  /** MCP servers custom agents can draw tools from. */
  mcpServers: McpServerRecord[];
  importableServers: ImportableServer[];
  /** Operator-defined tools, grantable to any agent. */
  customTools: CustomTool[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

/** Index of custom agents. Empty state does the explaining, since this is new. */
export function customAgentsPage(vm: CustomAgentsPageViewModel): string {
  const cards = vm.agents.map((agent) => `
    <a class="sk-panel ca-card" href="/custom-agents/${escapeHtml(agent.id)}">
      <div class="sk-panel__body">
        <div class="ca-card__title">${escapeHtml(agent.name)}</div>
        ${agent.description ? `<p class="ca-card__desc">${escapeHtml(agent.description)}</p>` : ""}
        <div class="ca-card__meta">
          <span>${escapeHtml(agent.modelId)}</span>
          <span>·</span>
          <span>${escapeHtml(hostOf(agent.baseUrl))}</span>
          <span>·</span>
          <span>${agent.enabledTools.length + agent.enabledMcpTools.length} tool(s)</span>
        </div>
      </div>
    </a>`).join("");

  const body = vm.agents.length > 0
    ? `<div class="ca-grid">${cards}</div>`
    : `<div class="sk-panel"><div class="sk-panel__body">
         <p class="sk-muted">No custom agents yet.</p>
         <p class="sk-muted sk-text-xs">
           A custom agent runs inside Skipper instead of spawning a CLI. You give it an
           endpoint, a system prompt, and exactly the tools it is allowed to use. Once saved
           it can be picked as the provider for any agent on a team.
         </p>
       </div></div>`;

  const content = `
    ${navbar({ currentPath: "/custom-agents", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <style>
      .ca-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:var(--sk-space-4); }
      .ca-card { display:block; text-decoration:none; color:inherit; transition:border-color .12s ease; }
      .ca-card:hover { border-color:var(--sk-accent); }
      .ca-card__title { font-weight:600; margin-bottom:var(--sk-space-1); }
      .ca-card__desc { margin:0 0 var(--sk-space-2); font-size:var(--sk-text-xs); color:var(--sk-text-muted); }
      .ca-card__meta { display:flex; gap:var(--sk-space-2); flex-wrap:wrap; font-size:var(--sk-text-xs); color:var(--sk-text-muted); }
      .ca-section-head { margin:var(--sk-space-6) 0 var(--sk-space-3); font-size:var(--sk-text-sm); font-weight:600; color:var(--sk-text-muted); text-transform:uppercase; letter-spacing:0.06em; }
    </style>
    <div class="sk-container">
      <div class="sk-page-header" style="display:flex;align-items:center;justify-content:space-between;">
        <h1 class="sk-page-header__title">Custom Agents</h1>
        <a class="sk-btn sk-btn--sm sk-btn--primary" href="/custom-agents/new">New agent</a>
      </div>
      ${body}

      <!-- What an agent can be given, defined once here and ticked per agent. -->
      <div class="ca-section-head">Tools</div>
      ${mcpServersPanel(vm.mcpServers, vm.importableServers)}
      ${customToolsPanel(vm.customTools)}
    </div>`;

  return v2layout("Custom Agents", content, "/custom-agents");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface ImportableServer {
  name: string;
  slug: string;
  command: string;
  args: string[];
  source: string;
}

/**
 * MCP servers custom agents can draw tools from.
 *
 * Every mutation returns this whole panel for an htmx outerHTML swap, like the
 * API-keys panel — the tool catalogue is refreshed server-side on save, so the
 * fresh counts and any connection error come back with the same response.
 *
 * Secrets arrive already masked (`__stored__`) and render as blank fields; blank
 * on save means unchanged, matching the custom agent's API key.
 */
export function mcpServersPanel(servers: McpServerRecord[], importable: ImportableServer[]): string {
  const row = (s: McpServerRecord) => {
    const target = s.transport === "stdio"
      ? `${escapeHtml(s.command)}${s.args.length ? " " + escapeHtml(s.args.join(" ")) : ""}`
      : escapeHtml(s.url);
    const status = s.catalogueError
      ? `<span class="sk-text-xs" style="color:var(--sk-danger,#f87171);">${escapeHtml(s.catalogueError)}</span>`
      : `<span class="sk-muted sk-text-xs">${s.toolCatalogue.length} tool(s)${s.catalogueRefreshedAt ? ` · ${escapeHtml(s.catalogueRefreshedAt)}` : ""}</span>`;
    return `<tr>
      <td><code class="sk-text-xs">${escapeHtml(s.slug)}</code><div class="sk-muted sk-text-xs">${escapeHtml(s.name)}</div></td>
      <td class="sk-text-xs">${escapeHtml(s.transport)}</td>
      <td class="sk-text-xs" style="word-break:break-all;">${target}</td>
      <td>${status}</td>
      <td style="white-space:nowrap;">
        <button class="sk-btn sk-btn--sm" hx-post="/api/custom-agent-servers/${escapeHtml(s.id)}/refresh"
          hx-target="#sk-mcp-servers-panel" hx-swap="outerHTML">Refresh</button>
        <button class="sk-btn sk-btn--sm sk-btn--danger" hx-delete="/api/custom-agent-servers/${escapeHtml(s.id)}"
          hx-target="#sk-mcp-servers-panel" hx-swap="outerHTML"
          hx-confirm="Delete this server? Agents using its tools will lose them.">Delete</button>
      </td>
    </tr>`;
  };

  const importRows = importable.map((i) => `
    <li class="sk-text-xs" style="margin-bottom:var(--sk-space-1);">
      <button type="button" class="sk-btn sk-btn--sm" data-import='${escapeHtml(JSON.stringify(i))}'>Import</button>
      <code>${escapeHtml(i.name)}</code>
      <span class="sk-muted">${escapeHtml(i.source)} · ${escapeHtml([i.command, ...i.args].join(" "))}</span>
    </li>`).join("");

  return `<div id="sk-mcp-servers-panel" class="sk-panel" style="margin-bottom: var(--sk-space-6);">
    <div class="sk-panel__header"><span class="sk-panel__title">MCP Servers</span></div>
    <div class="sk-panel__body">
      <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
        Tool sources for custom agents. Skipper connects on save to read each server's tool list;
        those tools then appear as options on any custom agent, named <code>server__tool</code>.
        This is separate from the MCP servers your CLI agents use.
      </p>

      ${servers.length > 0
        ? `<table class="sk-table"><thead><tr><th>Name</th><th>Type</th><th>Target</th><th>Tools</th><th></th></tr></thead><tbody>${servers.map(row).join("")}</tbody></table>`
        : `<p class="sk-muted sk-text-xs">No MCP servers registered.</p>`}

      <form id="sk-mcp-server-form" style="margin-top:var(--sk-space-4);">
        <div style="display:grid;grid-template-columns:1fr 140px;gap:var(--sk-space-2);">
          <div><label class="sk-label" for="mcp-name">Name</label>
            <input class="sk-input sk-input--sm" id="mcp-name" type="text" placeholder="e.g. filesystem" required></div>
          <div><label class="sk-label" for="mcp-transport">Type</label>
            <select class="sk-select sk-input--sm" id="mcp-transport">
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select></div>
        </div>
        <div id="mcp-stdio-fields" style="margin-top:var(--sk-space-2);">
          <label class="sk-label" for="mcp-command">Command</label>
          <input class="sk-input sk-input--sm" id="mcp-command" type="text" placeholder="npx -y @modelcontextprotocol/server-filesystem /some/path">
          <p class="sk-muted sk-text-xs" style="margin:var(--sk-space-1) 0 0;">The command and its arguments, as you would type them.</p>
        </div>
        <div id="mcp-http-fields" style="margin-top:var(--sk-space-2);display:none;">
          <label class="sk-label" for="mcp-url">URL</label>
          <input class="sk-input sk-input--sm" id="mcp-url" type="text" placeholder="https://example.com/mcp">
        </div>
        <div style="margin-top:var(--sk-space-2);">
          <label class="sk-label" id="mcp-pairs-label">Environment variables</label>
          <div id="mcp-pairs"></div>
          <button type="button" class="sk-btn sk-btn--sm" id="mcp-add-pair" style="margin-top:var(--sk-space-1);">+ Add</button>
          <p class="sk-muted sk-text-xs" style="margin:var(--sk-space-1) 0 0;">Values may use <code>\${ENV_VAR}</code> to read from the daemon's environment instead of storing a secret here.</p>
        </div>
        <div style="margin-top:var(--sk-space-3);display:flex;gap:var(--sk-space-2);align-items:center;">
          <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Add server</button>
          <span class="sk-muted sk-text-xs">Saving connects to the server and reads its tools.</span>
        </div>
      </form>

      ${importable.length > 0 ? `
      <details style="margin-top:var(--sk-space-4);">
        <summary class="sk-text-xs" style="cursor:pointer;">Found in your Claude Code / Codex config (${importable.length})</summary>
        <p class="sk-muted sk-text-xs" style="margin:var(--sk-space-2) 0;">
          Importing copies the server here. Editing Skipper's copy never changes your Claude or Codex config.
        </p>
        <ul style="list-style:none;padding:0;margin:0;">${importRows}</ul>
      </details>` : ""}
    </div>

    <script>
    (function(){
      var form = document.getElementById('sk-mcp-server-form');
      if (!form || form.dataset.wired) return;
      form.dataset.wired = '1';

      var transport = document.getElementById('mcp-transport');
      var pairs = document.getElementById('mcp-pairs');

      function syncTransport(){
        var stdio = transport.value === 'stdio';
        document.getElementById('mcp-stdio-fields').style.display = stdio ? '' : 'none';
        document.getElementById('mcp-http-fields').style.display = stdio ? 'none' : '';
        document.getElementById('mcp-pairs-label').textContent = stdio ? 'Environment variables' : 'Headers';
      }
      transport.addEventListener('change', syncTransport);
      syncTransport();

      function addPair(k, v){
        var row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:var(--sk-space-2);margin-top:var(--sk-space-1);';
        row.innerHTML = '<input class="sk-input sk-input--sm" data-k type="text" placeholder="name">' +
          '<input class="sk-input sk-input--sm" data-v type="password" placeholder="value">' +
          '<button type="button" class="sk-btn sk-btn--sm sk-btn--danger">&times;</button>';
        row.querySelector('[data-k]').value = k || '';
        row.querySelector('[data-v]').value = v || '';
        row.querySelector('button').addEventListener('click', function(){ row.remove(); });
        pairs.appendChild(row);
      }
      document.getElementById('mcp-add-pair').addEventListener('click', function(){ addPair('', ''); });

      // The command field is one line, split into command + args on submit —
      // that is how a server's invocation is actually pasted from a README.
      form.addEventListener('submit', function(e){
        e.preventDefault();
        var raw = document.getElementById('mcp-command').value.trim().split(/\\s+/).filter(Boolean);
        var kv = {};
        Array.prototype.forEach.call(pairs.children, function(row){
          var k = row.querySelector('[data-k]').value.trim();
          if (k) kv[k] = row.querySelector('[data-v]').value;
        });
        var stdio = transport.value === 'stdio';
        var body = {
          name: document.getElementById('mcp-name').value.trim(),
          transport: transport.value,
          command: stdio ? (raw[0] || '') : '',
          args: stdio ? raw.slice(1) : [],
          url: stdio ? '' : document.getElementById('mcp-url').value.trim(),
          env: stdio ? kv : {},
          headers: stdio ? {} : kv
        };
        var btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Connecting…';
        fetch('/api/custom-agent-servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'HX-Request': 'true' },
          body: JSON.stringify(body)
        }).then(function(r){ return r.text().then(function(t){ return { ok: r.ok, text: t }; }); })
          .then(function(res){
            if (!res.ok) {
              btn.disabled = false; btn.textContent = 'Add server';
              var msg; try { msg = JSON.parse(res.text).error; } catch (e) { msg = res.text; }
              window.alert(msg || 'Could not add the server');
              return;
            }
            document.getElementById('sk-mcp-servers-panel').outerHTML = res.text;
          });
      });

      Array.prototype.forEach.call(document.querySelectorAll('[data-import]'), function(btn){
        btn.addEventListener('click', function(){
          var s = JSON.parse(btn.dataset.import);
          document.getElementById('mcp-name').value = s.name;
          transport.value = 'stdio';
          syncTransport();
          document.getElementById('mcp-command').value = [s.command].concat(s.args || []).join(' ');
          document.getElementById('mcp-name').scrollIntoView({ block: 'center' });
        });
      });
    })();
    </script>
  </div>`;
}

/**
 * Operator-defined tools: name, description, parameters, and a JavaScript body.
 *
 * One `<details>` per tool holding its whole editor, plus one for a new tool.
 * Everything posts JSON via fetch rather than htmx, because the parameter rows
 * have to be collected into an array before they mean anything.
 */
export function customToolsPanel(tools: CustomTool[]): string {
  const editor = (tool: CustomTool | null, index: number) => {
    const uid = tool ? `ct-${index}` : "ct-new";
    const t = tool ?? { id: "", name: "", description: "", parameters: [], code: "", timeoutMs: 10000 };
    const paramRows = t.parameters.map(paramRow).join("");
    return `
    <details class="ct-editor" data-tool-id="${escapeHtml(t.id)}" style="margin-bottom:var(--sk-space-2);border:1px solid var(--sk-border-subtle);border-radius:var(--sk-radius-sm);padding:var(--sk-space-2);">
      <summary style="cursor:pointer;">
        ${tool
        ? `<code>${escapeHtml(t.name)}</code> <span class="sk-muted sk-text-xs">${escapeHtml(t.description)}</span>`
        : `<strong class="sk-text-sm">+ New tool</strong>`}
      </summary>
      <div style="margin-top:var(--sk-space-3);">
        <div style="display:grid;grid-template-columns:1fr 2fr 120px;gap:var(--sk-space-2);">
          <div><label class="sk-label" for="${uid}-name">Name</label>
            <input class="sk-input sk-input--sm" id="${uid}-name" type="text" value="${escapeHtml(t.name)}" placeholder="lookup_customer"></div>
          <div><label class="sk-label" for="${uid}-desc">Description</label>
            <input class="sk-input sk-input--sm" id="${uid}-desc" type="text" value="${escapeHtml(t.description)}" placeholder="What it does, and when the model should reach for it"></div>
          <div><label class="sk-label" for="${uid}-timeout">Timeout (ms)</label>
            <input class="sk-input sk-input--sm" id="${uid}-timeout" type="number" min="100" max="120000" value="${t.timeoutMs}"></div>
        </div>

        <div style="margin-top:var(--sk-space-3);">
          <label class="sk-label">Parameters</label>
          <div id="${uid}-params">${paramRows}</div>
          <button type="button" class="sk-btn sk-btn--sm" data-add-param="${uid}" style="margin-top:var(--sk-space-1);">+ Parameter</button>
        </div>

        <div style="margin-top:var(--sk-space-3);">
          <label class="sk-label" for="${uid}-code">Function body</label>
          <textarea class="sk-input sk-mono" id="${uid}-code" rows="10"
            placeholder="const res = await fetch('https://api.example.com/customers/' + args.id);&#10;return await res.json();">${escapeHtml(t.code)}</textarea>
          <p class="sk-muted sk-text-xs" style="margin:var(--sk-space-1) 0 0;">
            An async function body. Available: <code>args</code> (the parameters),
            <code>ctx</code> (<code>taskId</code>, <code>agentId</code>, <code>instanceId</code>, <code>workingDir</code>),
            <code>console</code> (shown in the tool result) and <code>fetch</code>.
            <code>return</code> the result. Runs in a worker and is stopped at the timeout.
          </p>
        </div>

        <div style="margin-top:var(--sk-space-3);display:flex;gap:var(--sk-space-2);align-items:center;">
          <button type="button" class="sk-btn sk-btn--sm sk-btn--primary" data-save-tool="${uid}">${tool ? "Save" : "Create tool"}</button>
          <button type="button" class="sk-btn sk-btn--sm" data-test-tool="${uid}">Test run</button>
          ${tool ? `<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-delete-tool="${escapeHtml(t.id)}">Delete</button>` : ""}
          <span class="sk-text-xs" data-status="${uid}"></span>
        </div>
        <pre class="sk-text-xs sk-mono" data-result="${uid}" style="display:none;white-space:pre-wrap;margin-top:var(--sk-space-2);padding:var(--sk-space-2);border:1px solid var(--sk-border-subtle);border-radius:var(--sk-radius-sm);max-height:16rem;overflow:auto;"></pre>
      </div>
    </details>`;
  };

  return `<div id="sk-custom-tools-panel" class="sk-panel" style="margin-bottom: var(--sk-space-6);">
    <div class="sk-panel__header"><span class="sk-panel__title">Custom Tools</span></div>
    <div class="sk-panel__body">
      <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
        Tools you define yourself. Grant one to a custom agent on its own page, or to any agent —
        including a CLI agent — from the agent's card on a team. The body runs inside Skipper with
        network access, so treat it like any other script you run on this machine.
      </p>
      ${tools.map((t, i) => editor(t, i)).join("")}
      ${editor(null, -1)}
    </div>

    <script>
    (function(){
      var panel = document.getElementById('sk-custom-tools-panel');
      if (!panel || panel.dataset.wired) return;
      panel.dataset.wired = '1';

      var TYPES = ${JSON.stringify(PARAM_TYPES)};

      function paramRowHtml(){
        return '<div class="ct-param" style="display:grid;grid-template-columns:1fr 110px 2fr 90px auto;gap:var(--sk-space-2);margin-top:var(--sk-space-1);align-items:center;">' +
          '<input class="sk-input sk-input--sm" data-p="name" type="text" placeholder="name">' +
          '<select class="sk-select sk-input--sm" data-p="type">' +
            TYPES.map(function(t){ return '<option value="' + t + '">' + t + '</option>'; }).join('') +
          '</select>' +
          '<input class="sk-input sk-input--sm" data-p="description" type="text" placeholder="what it is">' +
          '<label class="sk-text-xs" style="display:flex;gap:0.3rem;align-items:center;"><input type="checkbox" data-p="required" checked>req</label>' +
          '<button type="button" class="sk-btn sk-btn--sm sk-btn--danger">&times;</button>' +
        '</div>';
      }

      panel.addEventListener('click', function(e){
        var el = e.target;
        if (el.matches('.ct-param button')) { el.closest('.ct-param').remove(); return; }

        var addFor = el.getAttribute && el.getAttribute('data-add-param');
        if (addFor) {
          var host = document.getElementById(addFor + '-params');
          host.insertAdjacentHTML('beforeend', paramRowHtml());
          return;
        }

        var saveFor = el.getAttribute && el.getAttribute('data-save-tool');
        if (saveFor) { save(el, saveFor); return; }

        var testFor = el.getAttribute && el.getAttribute('data-test-tool');
        if (testFor) { test(el, testFor); return; }

        var delId = el.getAttribute && el.getAttribute('data-delete-tool');
        if (delId) {
          if (!window.confirm('Delete this tool? Agents granted it will lose it.')) return;
          fetch('/api/custom-tools/' + encodeURIComponent(delId), { method: 'DELETE' })
            .then(function(){ window.location.reload(); });
        }
      });

      function collect(uid){
        var params = [];
        var host = document.getElementById(uid + '-params');
        Array.prototype.forEach.call(host.querySelectorAll('.ct-param'), function(row){
          var name = row.querySelector('[data-p="name"]').value.trim();
          if (!name) return;
          params.push({
            name: name,
            type: row.querySelector('[data-p="type"]').value,
            description: row.querySelector('[data-p="description"]').value.trim(),
            required: row.querySelector('[data-p="required"]').checked
          });
        });
        return {
          name: document.getElementById(uid + '-name').value.trim(),
          description: document.getElementById(uid + '-desc').value.trim(),
          timeoutMs: Number(document.getElementById(uid + '-timeout').value || 10000),
          parameters: params,
          code: document.getElementById(uid + '-code').value
        };
      }

      function status(uid, text, bad){
        var el = panel.querySelector('[data-status="' + uid + '"]');
        el.textContent = text || '';
        el.style.color = bad ? 'var(--sk-danger,#f87171)' : 'var(--sk-text-muted)';
      }

      function save(btn, uid){
        var editor = btn.closest('.ct-editor');
        var id = editor.dataset.toolId;
        var url = id ? '/api/custom-tools/' + encodeURIComponent(id) + '/update' : '/api/custom-tools';
        status(uid, 'saving…');
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collect(uid))
        }).then(function(r){ return r.json().then(function(b){ return { ok: r.ok, body: b }; }); })
          .then(function(res){
            if (!res.ok) { status(uid, res.body.error || 'Save failed', true); return; }
            window.location.reload();
          });
      }

      // Runs the body exactly as an agent's call would, so a typo surfaces here
      // rather than mid-task. Parameters come from their example values.
      function test(btn, uid){
        var out = panel.querySelector('[data-result="' + uid + '"]');
        var payload = collect(uid);
        var args = {};
        payload.parameters.forEach(function(p){
          var v = window.prompt('Test value for "' + p.name + '" (' + p.type + ')', '');
          if (v === null) return;
          if (p.type === 'number') args[p.name] = Number(v);
          else if (p.type === 'boolean') args[p.name] = v === 'true';
          else if (p.type === 'array' || p.type === 'object') { try { args[p.name] = JSON.parse(v); } catch (e) { args[p.name] = v; } }
          else args[p.name] = v;
        });
        status(uid, 'running…');
        fetch('/api/custom-tools/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: payload, args: args })
        }).then(function(r){ return r.json(); }).then(function(res){
          status(uid, res.ok ? 'ok · ' + res.durationMs + 'ms' : (res.timedOut ? 'timed out' : 'failed'), !res.ok);
          out.style.display = '';
          out.textContent = (res.logs || []).map(function(l){ return '[log] ' + l; }).concat([res.output || '']).join('\\n');
        }).catch(function(err){ status(uid, String(err), true); });
      }
    })();
    </script>
  </div>`;
}

function paramRow(p: ToolParameter): string {
  const options = PARAM_TYPES
    .map((t) => `<option value="${t}"${t === p.type ? " selected" : ""}>${t}</option>`)
    .join("");
  return `<div class="ct-param" style="display:grid;grid-template-columns:1fr 110px 2fr 90px auto;gap:var(--sk-space-2);margin-top:var(--sk-space-1);align-items:center;">
    <input class="sk-input sk-input--sm" data-p="name" type="text" value="${escapeHtml(p.name)}" placeholder="name">
    <select class="sk-select sk-input--sm" data-p="type">${options}</select>
    <input class="sk-input sk-input--sm" data-p="description" type="text" value="${escapeHtml(p.description)}" placeholder="what it is">
    <label class="sk-text-xs" style="display:flex;gap:0.3rem;align-items:center;"><input type="checkbox" data-p="required"${p.required ? " checked" : ""}>req</label>
    <button type="button" class="sk-btn sk-btn--sm sk-btn--danger">&times;</button>
  </div>`;
}
