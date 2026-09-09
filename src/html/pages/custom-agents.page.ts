import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import type { CustomAgent } from "../../custom-agents/store";
import type { SingleAgent } from "../../single-agents/store";
import type { McpServerRecord } from "../../custom-agents/servers";
import { PARAM_TYPES, type CustomTool, type ToolParameter } from "../../custom-tools/store";

export interface CustomAgentsPageViewModel {
  agents: CustomAgent[];
  /** Single agents (CLI provider + model + prompt), shown alongside custom agents. */
  singleAgents: SingleAgent[];
  /** MCP servers custom agents can draw tools from. */
  mcpServers: McpServerRecord[];
  importableServers: ImportableServer[];
  /** Operator-defined tools, grantable to any agent. */
  customTools: CustomTool[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

/** A single-agent card for the combined library. Kind badge tells it from a custom agent. */
function singleAgentCard(agent: SingleAgent): string {
  const slack = agent.config.slackEnabled ? `<span class="tm-chip tm-chip--slack">Slack</span>` : "";
  const slash = agent.config.slashCommand ? `<span class="tm-chip">${escapeHtml(agent.config.slashCommand)}</span>` : "";
  return `<div class="tm-card">
    <a class="tm-card__link" href="/single-agents/${escapeHtml(agent.id)}">
      <div class="tm-card__name">${escapeHtml(agent.name)} <span class="tm-chip ca-kind">Headless CLI</span></div>
      <div class="tm-card__meta">
        <span>${escapeHtml(agent.agent_type)}</span>
        <span>&middot;</span>
        <span>${escapeHtml(agent.model || "default")}</span>
      </div>
    </a>
    ${slack || slash ? `<div class="tm-phase__chips">${slack}${slash}</div>` : ""}
    <div class="tm-card__actions">
      <a class="sk-btn sk-btn--sm" href="/single-agents/${escapeHtml(agent.id)}">Open</a>
      <button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-sa-delete="${escapeHtml(agent.id)}"
        data-sa-name="${escapeHtml(agent.name)}">Delete</button>
    </div>
  </div>`;
}

/** Mirrors the teams index: same card grid, same reading order. */
function agentCard(agent: CustomAgent): string {
  const tools = [
    ...agent.enabledTools,
    ...agent.enabledMcpTools,
    ...agent.enabledServerTools,
    ...agent.enabledCustomTools,
  ];
  const shown = tools.slice(0, 4);
  const mini = tools.length > 0
    ? `<div class="tm-mini">
         ${shown.map((t) => `<span class="tm-mini__node">${escapeHtml(t)}</span>`).join("")}
         ${tools.length > shown.length ? `<span class="tm-mini__node">+${tools.length - shown.length} more</span>` : ""}
       </div>`
    : `<div class="tm-mini"><span class="sk-text-xs sk-muted">No tools granted</span></div>`;
  return `<div class="tm-card">
    <a class="tm-card__link" href="/custom-agents/${escapeHtml(agent.id)}">
      <div class="tm-card__name">${escapeHtml(agent.name)} <span class="tm-chip ca-kind">Custom</span></div>
      ${agent.description ? `<p class="ca-card__desc">${escapeHtml(agent.description)}</p>` : ""}
      <div class="tm-card__meta">
        <span>${escapeHtml(agent.modelId)}</span>
        <span>&middot;</span>
        <span>${escapeHtml(hostOf(agent.baseUrl))}</span>
        ${agent.enabledSkills.length > 0 ? `<span>&middot;</span><span>${agent.enabledSkills.length} skill${agent.enabledSkills.length === 1 ? "" : "s"}</span>` : ""}
      </div>
      ${mini}
    </a>
    <div class="tm-card__actions">
      <a class="sk-btn sk-btn--sm" href="/custom-agents/${escapeHtml(agent.id)}">Open</a>
      <button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-ca-delete="${escapeHtml(agent.id)}"
        data-ca-name="${escapeHtml(agent.name)}">Delete</button>
    </div>
  </div>`;
}

/** Index of custom agents. Empty state does the explaining, since this is new. */
export function customAgentsPage(vm: CustomAgentsPageViewModel): string {
  const singleGrid = `<div class="tm-grid">
    ${vm.singleAgents.map(singleAgentCard).join("")}
    <a class="tm-card tm-card--new" href="/single-agents/new">+ New headless CLI agent</a>
  </div>`;
  const customGrid = `<div class="tm-grid">
    ${vm.agents.map(agentCard).join("")}
    <a class="tm-card tm-card--new" href="/custom-agents/new">+ New custom agent</a>
  </div>`;

  const content = `
    ${navbar({ currentPath: "/agent-library", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <style>
      .ca-shell { max-width: 1100px; }
      .ca-card__desc { margin:0; font-size:var(--sk-text-xs); color:var(--sk-text-muted); line-height:1.5; }
      .ca-section-head { margin:var(--sk-space-8) 0 var(--sk-space-3); font-size:var(--sk-text-sm); font-weight:600; color:var(--sk-text-muted); text-transform:uppercase; letter-spacing:0.06em; }
      .ca-kind { font-size:0.6rem; opacity:0.7; vertical-align:middle; }

      /* Panels: same surface language as the team cards, so they read as
         objects on the wallpaper instead of faint boxes. */
      .ca-panel { background:var(--sk-surface-3); border:1px solid var(--sk-border); border-radius:var(--sk-panel-radius); padding:var(--sk-space-4); margin-bottom:var(--sk-space-4); }
      .ca-panel__title { font-family:var(--sk-font-heading); font-size:var(--sk-text-lg); color:var(--sk-text); margin:0 0 var(--sk-space-1); }
      .ca-intro { margin:0 0 var(--sk-space-3); font-size:var(--sk-text-xs); color:var(--sk-text-muted); line-height:1.6; max-width:52rem; }
      .ca-hint { margin:var(--sk-space-1) 0 0; font-size:var(--sk-text-xs); color:var(--sk-text-muted); }
      .ca-field { margin-top:var(--sk-space-3); }
      .ca-row2 { display:grid; grid-template-columns:minmax(0,1fr) 140px; gap:var(--sk-space-3); }
      .ca-actions { margin-top:var(--sk-space-4); display:flex; gap:var(--sk-space-2); align-items:center; }

      /* Expandable rows: add-server form, config imports, tool editors */
      .ca-fold { background:var(--sk-surface-2); border:1px solid var(--sk-border); border-radius:var(--sk-radius-md); margin-top:var(--sk-space-3); transition:border-color .15s ease; }
      .ca-fold:hover { border-color:var(--sk-border-active); }
      .ca-fold > summary { list-style:none; cursor:pointer; padding:var(--sk-space-2) var(--sk-space-3); font-size:var(--sk-text-sm); color:var(--sk-text-muted); display:flex; gap:var(--sk-space-2); align-items:baseline; min-width:0; }
      .ca-fold > summary::-webkit-details-marker { display:none; }
      .ca-fold > summary:hover { color:var(--sk-text); }
      .ca-fold[open] > summary { color:var(--sk-text); border-bottom:1px solid var(--sk-border); }
      .ca-fold__body { padding:var(--sk-space-3); }
      .ca-fold__desc { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--sk-text-xs); color:var(--sk-text-muted); }

      .ct-editor.ca-fold { margin-top:var(--sk-space-2); }
      .ct-head-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,2fr) 110px; gap:var(--sk-space-3); }
      .ct-param { display:grid; grid-template-columns:minmax(0,1fr) 100px minmax(0,2fr) 60px auto; gap:var(--sk-space-2); margin-top:var(--sk-space-1); align-items:center; }
      .ct-param__req { font-size:var(--sk-text-xs); display:flex; gap:0.3rem; align-items:center; }
      .ct-result { white-space:pre-wrap; margin-top:var(--sk-space-2); padding:var(--sk-space-2); border:1px solid var(--sk-border); border-radius:var(--sk-radius-sm); max-height:16rem; overflow:auto; }
      .ca-import-list { list-style:none; padding:0; margin:0; }
      .ca-import-list li { display:flex; gap:var(--sk-space-2); align-items:center; margin-bottom:var(--sk-space-1); min-width:0; }
      .ca-import-list .ca-import__cmd { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    </style>
    <div class="tm-shell ca-shell">
      <div class="tm-topbar">
        <div class="tm-topbar__heading">
          <h1 class="tm-topbar__title">Agents</h1>
          <div class="tm-topbar__sub">Reusable agents you can assign to run a task alone, or add to a team. A headless CLI agent spawns a CLI provider; a custom agent runs in-process against its own endpoint.</div>
        </div>
        <div class="tm-topbar__actions">
          <a class="sk-btn sk-btn--sm" href="/single-agents/new">New headless CLI agent</a>
          <a class="sk-btn sk-btn--sm sk-btn--primary" href="/custom-agents/new">New custom agent</a>
        </div>
      </div>

      <div class="ca-section-head">Headless CLI agents</div>
      ${singleGrid}

      <div class="ca-section-head">Custom agents</div>
      ${customGrid}

      <!-- What a custom agent can be given, defined once here and ticked per agent. -->
      <div class="ca-section-head">Tool sources</div>
      ${mcpServersPanel(vm.mcpServers, vm.importableServers)}
      ${customToolsPanel(vm.customTools)}
    </div>

    <script>
    (function(){
      document.querySelectorAll('[data-ca-delete]').forEach(function(btn){
        btn.addEventListener('click', async function(){
          var id = btn.getAttribute('data-ca-delete');
          var name = btn.getAttribute('data-ca-name');
          if (!window.confirm('Delete agent "' + name + '"? Teams using it will need a new provider.')) return;
          var res = await fetch('/api/custom-agents/' + encodeURIComponent(id), { method: 'DELETE' });
          if (res.ok) window.location.reload();
        });
      });
      document.querySelectorAll('[data-sa-delete]').forEach(function(btn){
        btn.addEventListener('click', async function(){
          var id = btn.getAttribute('data-sa-delete');
          var name = btn.getAttribute('data-sa-name');
          if (!window.confirm('Delete headless CLI agent "' + name + '"? Tasks assigned to it will need a new assignee.')) return;
          var res = await fetch('/api/single-agents/' + encodeURIComponent(id), { method: 'DELETE' });
          if (res.ok) window.location.reload();
        });
      });
    })();
    </script>`;

  return v2layout("Agents", content, "/agent-library");
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
  // Secret env/header values never leave the server: mask each present value to
  // the same `__stored__` marker the JSON API uses, so an untouched field round-
  // trips to "keep the stored value" on update (`updateMcpServer` keepBlanks).
  const mask = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v ? "__stored__" : ""]));
  const row = (s: McpServerRecord) => {
    const target = s.transport === "stdio"
      ? `${escapeHtml(s.command)}${s.args.length ? " " + escapeHtml(s.args.join(" ")) : ""}`
      : escapeHtml(s.url);
    const status = s.catalogueError
      ? `<span class="sk-text-xs" style="color:var(--sk-danger,#f87171);">${escapeHtml(s.catalogueError)}</span>`
      : `<span class="sk-muted sk-text-xs">${s.toolCatalogue.length} tool(s)${s.catalogueRefreshedAt ? ` · ${escapeHtml(s.catalogueRefreshedAt)}` : ""}</span>`;
    // The stored slug rides along so a rename on edit keeps the existing slug —
    // agents grant tools as `slug__tool`, so re-deriving it from the new name
    // would silently orphan every grant.
    const editPayload = {
      id: s.id, slug: s.slug, name: s.name, transport: s.transport,
      command: s.command, args: s.args, url: s.url,
      env: mask(s.env), headers: mask(s.headers),
    };
    return `<tr>
      <td><code class="sk-text-xs">${escapeHtml(s.slug)}</code><div class="sk-muted sk-text-xs">${escapeHtml(s.name)}</div></td>
      <td class="sk-text-xs">${escapeHtml(s.transport)}</td>
      <td class="sk-text-xs" style="word-break:break-all;">${target}</td>
      <td>${status}</td>
      <td style="white-space:nowrap;">
        <button type="button" class="sk-btn sk-btn--sm" data-edit='${escapeHtml(JSON.stringify(editPayload))}'>Edit</button>
        <button class="sk-btn sk-btn--sm" hx-post="/api/custom-agent-servers/${escapeHtml(s.id)}/refresh"
          hx-target="#sk-mcp-servers-panel" hx-swap="outerHTML">Refresh</button>
        <button class="sk-btn sk-btn--sm sk-btn--danger" hx-delete="/api/custom-agent-servers/${escapeHtml(s.id)}"
          hx-target="#sk-mcp-servers-panel" hx-swap="outerHTML"
          hx-confirm="Delete this server? Agents using its tools will lose them.">Delete</button>
      </td>
    </tr>`;
  };

  const importRows = importable.map((i) => `
    <li class="sk-text-xs">
      <button type="button" class="sk-btn sk-btn--sm" data-import='${escapeHtml(JSON.stringify(i))}'>Import</button>
      <code>${escapeHtml(i.name)}</code>
      <span class="sk-muted ca-import__cmd">${escapeHtml(i.source)} · ${escapeHtml([i.command, ...i.args].join(" "))}</span>
    </li>`).join("");

  return `<div id="sk-mcp-servers-panel" class="ca-panel">
    <h2 class="ca-panel__title">MCP servers</h2>
    <div>
      <p class="ca-intro">
        Tool sources for custom agents. Skipper connects on save to read each server's tool list;
        those tools then appear as options on any custom agent, named <code>server__tool</code>.
        This is separate from the MCP servers your CLI agents use.
      </p>

      ${servers.length > 0
        ? `<table class="sk-table"><thead><tr><th>Name</th><th>Type</th><th>Target</th><th>Tools</th><th></th></tr></thead><tbody>${servers.map(row).join("")}</tbody></table>`
        : `<p class="sk-muted sk-text-xs" style="margin:0;">No MCP servers registered.</p>`}

      <details class="ca-fold" id="mcp-add-fold">
        <summary id="mcp-fold-summary">+ Add server</summary>
        <form id="sk-mcp-server-form" class="ca-fold__body">
          <div class="ca-row2">
            <div><label class="sk-label" for="mcp-name">Name</label>
              <input class="sk-input sk-input--sm" id="mcp-name" type="text" placeholder="e.g. filesystem" required></div>
            <div><label class="sk-label" for="mcp-transport">Type</label>
              <select class="sk-select sk-input--sm" id="mcp-transport">
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select></div>
          </div>
          <div id="mcp-stdio-fields" class="ca-field">
            <label class="sk-label" for="mcp-command">Command</label>
            <input class="sk-input sk-input--sm" id="mcp-command" type="text" placeholder="npx -y @modelcontextprotocol/server-filesystem /some/path">
            <p class="ca-hint">The command and its arguments, as you would type them.</p>
          </div>
          <div id="mcp-http-fields" class="ca-field" style="display:none;">
            <label class="sk-label" for="mcp-url">URL</label>
            <input class="sk-input sk-input--sm" id="mcp-url" type="text" placeholder="https://example.com/mcp">
          </div>
          <div class="ca-field">
            <label class="sk-label" id="mcp-pairs-label">Environment variables</label>
            <div id="mcp-pairs"></div>
            <button type="button" class="sk-btn sk-btn--sm" id="mcp-add-pair" style="margin-top:var(--sk-space-1);">+ Add</button>
            <p class="ca-hint">Values may use <code>\${ENV_VAR}</code> to read from the daemon's environment instead of storing a secret here.</p>
          </div>
          <div class="ca-actions">
            <button type="submit" id="mcp-submit" class="sk-btn sk-btn--sm sk-btn--primary">Add server</button>
            <button type="button" id="mcp-cancel-edit" class="sk-btn sk-btn--sm" style="display:none;">Cancel</button>
            <span class="sk-muted sk-text-xs">Saving connects to the server and reads its tools. Leave a masked value blank to keep it.</span>
          </div>
        </form>
      </details>

      ${importable.length > 0 ? `
      <details class="ca-fold">
        <summary>Found in your Claude Code / Codex config (${importable.length})</summary>
        <div class="ca-fold__body">
          <p class="ca-intro">
            Importing copies the server here. Editing Skipper's copy never changes your Claude or Codex config.
          </p>
          <ul class="ca-import-list">${importRows}</ul>
        </div>
      </details>` : ""}
    </div>

    <script>
    (function(){
      var form = document.getElementById('sk-mcp-server-form');
      if (!form || form.dataset.wired) return;
      form.dataset.wired = '1';

      var transport = document.getElementById('mcp-transport');
      var pairs = document.getElementById('mcp-pairs');
      var submitBtn = document.getElementById('mcp-submit');
      var cancelBtn = document.getElementById('mcp-cancel-edit');
      var summary = document.getElementById('mcp-fold-summary');

      function resetToAdd(){
        delete form.dataset.editId;
        delete form.dataset.editSlug;
        document.getElementById('mcp-name').value = '';
        document.getElementById('mcp-command').value = '';
        document.getElementById('mcp-url').value = '';
        pairs.innerHTML = '';
        transport.value = 'stdio';
        syncTransport();
        submitBtn.textContent = 'Add server';
        cancelBtn.style.display = 'none';
        summary.textContent = '+ Add server';
      }
      cancelBtn.addEventListener('click', resetToAdd);

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
        var editId = form.dataset.editId;
        var body = {
          name: document.getElementById('mcp-name').value.trim(),
          transport: transport.value,
          command: stdio ? (raw[0] || '') : '',
          args: stdio ? raw.slice(1) : [],
          url: stdio ? '' : document.getElementById('mcp-url').value.trim(),
          env: stdio ? kv : {},
          headers: stdio ? {} : kv
        };
        // On edit, carry id + the stored slug so the update targets this row and
        // never re-derives the slug from a changed name.
        if (editId) { body.id = editId; body.slug = form.dataset.editSlug || ''; }
        var url = editId
          ? '/api/custom-agent-servers/' + encodeURIComponent(editId) + '/update'
          : '/api/custom-agent-servers';
        var idle = editId ? 'Save changes' : 'Add server';
        var btn = submitBtn;
        btn.disabled = true; btn.textContent = 'Connecting…';
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'HX-Request': 'true' },
          body: JSON.stringify(body)
        }).then(function(r){ return r.text().then(function(t){ return { ok: r.ok, text: t }; }); })
          .then(function(res){
            if (!res.ok) {
              btn.disabled = false; btn.textContent = idle;
              var msg; try { msg = JSON.parse(res.text).error; } catch (e) { msg = res.text; }
              window.alert(msg || 'Could not save the server');
              return;
            }
            document.getElementById('sk-mcp-servers-panel').outerHTML = res.text;
          });
      });

      Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function(btn){
        btn.addEventListener('click', function(){
          var s = JSON.parse(btn.dataset.edit);
          var fold = document.getElementById('mcp-add-fold');
          if (fold) fold.open = true;
          form.dataset.editId = s.id;
          form.dataset.editSlug = s.slug || '';
          document.getElementById('mcp-name').value = s.name || '';
          transport.value = s.transport;
          syncTransport();
          document.getElementById('mcp-command').value = s.transport === 'stdio'
            ? [s.command].concat(s.args || []).join(' ') : '';
          document.getElementById('mcp-url').value = s.transport === 'stdio' ? '' : (s.url || '');
          pairs.innerHTML = '';
          var kv = s.transport === 'stdio' ? (s.env || {}) : (s.headers || {});
          Object.keys(kv).forEach(function(k){ addPair(k, kv[k]); });
          submitBtn.textContent = 'Save changes';
          cancelBtn.style.display = '';
          summary.textContent = 'Edit server';
          document.getElementById('mcp-name').scrollIntoView({ block: 'center' });
        });
      });

      Array.prototype.forEach.call(document.querySelectorAll('[data-import]'), function(btn){
        btn.addEventListener('click', function(){
          var s = JSON.parse(btn.dataset.import);
          resetToAdd();
          var fold = document.getElementById('mcp-add-fold');
          if (fold) fold.open = true;
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
    <details class="ct-editor ca-fold" data-tool-id="${escapeHtml(t.id)}">
      <summary>
        ${tool
        ? `<code>${escapeHtml(t.name)}</code><span class="ca-fold__desc">${escapeHtml(t.description)}</span>`
        : `+ New tool`}
      </summary>
      <div class="ca-fold__body">
        <div class="ct-head-grid">
          <div><label class="sk-label" for="${uid}-name">Name</label>
            <input class="sk-input sk-input--sm" id="${uid}-name" type="text" value="${escapeHtml(t.name)}" placeholder="lookup_customer"></div>
          <div><label class="sk-label" for="${uid}-desc">Description</label>
            <input class="sk-input sk-input--sm" id="${uid}-desc" type="text" value="${escapeHtml(t.description)}" placeholder="What it does, and when the model should reach for it"></div>
          <div><label class="sk-label" for="${uid}-timeout">Timeout (ms)</label>
            <input class="sk-input sk-input--sm" id="${uid}-timeout" type="number" min="100" max="120000" value="${t.timeoutMs}"></div>
        </div>

        <div class="ca-field">
          <label class="sk-label">Parameters</label>
          <div id="${uid}-params">${paramRows}</div>
          <button type="button" class="sk-btn sk-btn--sm" data-add-param="${uid}" style="margin-top:var(--sk-space-1);">+ Parameter</button>
        </div>

        <div class="ca-field">
          <label class="sk-label" for="${uid}-code">Function body</label>
          <textarea class="sk-input sk-mono" id="${uid}-code" rows="10"
            placeholder="const res = await fetch('https://api.example.com/customers/' + args.id);&#10;return await res.json();">${escapeHtml(t.code)}</textarea>
          <p class="ca-hint">
            An async function body. Available: <code>args</code> (the parameters),
            <code>ctx</code> (<code>taskId</code>, <code>agentId</code>, <code>instanceId</code>, <code>workingDir</code>),
            <code>console</code> (shown in the tool result) and <code>fetch</code>.
            <code>return</code> the result. Runs in a worker and is stopped at the timeout.
          </p>
        </div>

        <div class="ca-actions">
          <button type="button" class="sk-btn sk-btn--sm sk-btn--primary" data-save-tool="${uid}">${tool ? "Save" : "Create tool"}</button>
          <button type="button" class="sk-btn sk-btn--sm" data-test-tool="${uid}">Test run</button>
          ${tool ? `<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-delete-tool="${escapeHtml(t.id)}">Delete</button>` : ""}
          <span class="sk-text-xs" data-status="${uid}"></span>
        </div>
        <pre class="sk-text-xs sk-mono ct-result" data-result="${uid}" style="display:none;"></pre>
      </div>
    </details>`;
  };

  return `<div id="sk-custom-tools-panel" class="ca-panel">
    <h2 class="ca-panel__title">Custom tools</h2>
    <div>
      <p class="ca-intro">
        Tools you define yourself. Grant one to a custom agent on its own page, or to any agent,
        CLI agents included, from the agent's card on a team. The body runs inside Skipper with
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
        return '<div class="ct-param">' +
          '<input class="sk-input sk-input--sm" data-p="name" type="text" placeholder="name">' +
          '<select class="sk-select sk-input--sm" data-p="type">' +
            TYPES.map(function(t){ return '<option value="' + t + '">' + t + '</option>'; }).join('') +
          '</select>' +
          '<input class="sk-input sk-input--sm" data-p="description" type="text" placeholder="what it is">' +
          '<label class="ct-param__req"><input type="checkbox" data-p="required" checked>req</label>' +
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
  return `<div class="ct-param">
    <input class="sk-input sk-input--sm" data-p="name" type="text" value="${escapeHtml(p.name)}" placeholder="name">
    <select class="sk-select sk-input--sm" data-p="type">${options}</select>
    <input class="sk-input sk-input--sm" data-p="description" type="text" value="${escapeHtml(p.description)}" placeholder="what it is">
    <label class="ct-param__req"><input type="checkbox" data-p="required"${p.required ? " checked" : ""}>req</label>
    <button type="button" class="sk-btn sk-btn--sm sk-btn--danger">&times;</button>
  </div>`;
}
