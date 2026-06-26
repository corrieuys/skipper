import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import type { LocalTeam, LocalTeamAgent } from "../../teams/local-teams";
import type { TeamPhase } from "../../config/store";

export interface AgentTypeChoice {
  name: string;
  models: string[];
}

export interface LocalTeamFormViewModel {
  team: LocalTeam | null;
  agentTypes: AgentTypeChoice[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

// Serialize a value for embedding inside an HTML attribute value.
function jsonAttr(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}

// Serialize a value for embedding inside an inline <script> element body.
// HTML entities are NOT decoded inside <script>, so escapeHtml() would produce
// invalid JS. Instead emit raw JSON, escaping only the sequences that could
// terminate the script element or start an HTML comment.
function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function localTeamFormPage(vm: LocalTeamFormViewModel): string {
  const isEdit = !!vm.team;
  const title = isEdit ? "Edit Team" : "New Team";
  const action = isEdit
    ? `/api/teams/${escapeHtml(vm.team!.id)}/update`
    : "/api/teams";

  const phases: TeamPhase[] = vm.team?.phases ?? [];
  const agents: LocalTeamAgent[] = vm.team?.agents ?? [];

  return v2layout(title, `
    ${navbar({ currentPath: "/config", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container" style="max-width:760px;">
      <div class="sk-page-header">
        <a href="/config" class="sk-page-header__back">&larr; Config</a>
        <h1 class="sk-page-header__title">${escapeHtml(title)}</h1>
      </div>
      <div class="sk-panel">
        <div class="sk-panel__body">
          <form id="lt-form" hx-post="${action}" hx-swap="none">
            ${isEdit ? `<input type="hidden" name="id" value="${escapeHtml(vm.team!.id)}">` : ""}

            <div class="sk-form-group">
              <label class="sk-label">Team Name</label>
              <input type="text" name="name" class="sk-input"
                value="${escapeHtml(vm.team?.name ?? "")}"
                placeholder="e.g. Feature Strike Team" required autofocus>
            </div>

            <div class="sk-form-group">
              <label class="sk-label">Skipper Prompt</label>
              <textarea name="skipper_prompt" class="sk-textarea" rows="4"
                placeholder="Extra context for Skipper, the implicit team lead (optional)...">${escapeHtml(vm.team?.skipper_prompt ?? "")}</textarea>
            </div>

            <hr style="margin:var(--sk-space-4) 0;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--sk-space-2);">
              <h3 style="margin:0;">Phases</h3>
              <button type="button" class="sk-btn sk-btn--sm" id="lt-add-phase">+ Add Phase</button>
            </div>
            <p class="sk-muted sk-text-xs" style="margin:0 0 var(--sk-space-3);">At least one phase is required.</p>
            <div id="lt-phases"></div>

            <hr style="margin:var(--sk-space-4) 0;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--sk-space-2);">
              <h3 style="margin:0;">Agents</h3>
              <button type="button" class="sk-btn sk-btn--sm" id="lt-add-agent">+ Add Agent</button>
            </div>
            <p class="sk-muted sk-text-xs" style="margin:0 0 var(--sk-space-3);">Skipper is the implicit team lead — do not add it here. Each agent reports to Skipper by default.</p>
            <div id="lt-agents"></div>

            <input type="hidden" name="phases" id="lt-phases-json">
            <input type="hidden" name="agents" id="lt-agents-json">
            <input type="hidden" name="hooks" id="lt-hooks-json" value="${jsonAttr(vm.team?.hooks ?? [])}">

            <div id="lt-error" class="sk-text-xs" style="color:var(--sk-danger);margin-top:var(--sk-space-3);"></div>

            <div style="display:flex;gap:var(--sk-space-3);margin-top:var(--sk-space-4);">
              <button type="submit" class="sk-btn sk-btn--primary">${isEdit ? "Save Changes" : "Create Team"}</button>
              <a href="/config" class="sk-btn sk-btn--link">Cancel</a>
            </div>
          </form>
        </div>
      </div>
    </div>

    <script>
    (function(){
      var AGENT_TYPES = ${jsonScript(vm.agentTypes)};
      var INITIAL_PHASES = ${jsonScript(phases)};
      var INITIAL_AGENTS = ${jsonScript(agents)};

      var phasesEl = document.getElementById('lt-phases');
      var agentsEl = document.getElementById('lt-agents');

      function el(html){ var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
      function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

      function phaseRow(p){
        p = p || {};
        var node = el(
          '<fieldset style="border:1px solid var(--sk-border);border-radius:6px;padding:var(--sk-space-3);margin-bottom:var(--sk-space-3);">' +
            '<div style="display:flex;gap:var(--sk-space-2);align-items:flex-end;margin-bottom:var(--sk-space-2);">' +
              '<label class="sk-label" style="flex:1;">Phase name<input class="sk-input" data-f="name" type="text" value="' + esc(p.name) + '" placeholder="e.g. build"></label>' +
              '<label class="sk-label" style="display:flex;align-items:center;gap:4px;white-space:nowrap;"><input data-f="review" type="checkbox"' + (p.review ? ' checked' : '') + '> Review gate</label>' +
              '<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-remove>Remove</button>' +
            '</div>' +
            '<label class="sk-label">Prompt<textarea class="sk-textarea" data-f="prompt" rows="3" placeholder="What this phase should accomplish...">' + esc(p.prompt) + '</textarea></label>' +
          '</fieldset>'
        );
        node.querySelector('[data-remove]').addEventListener('click', function(){ node.remove(); });
        return node;
      }

      function typeOptions(selectedType){
        return AGENT_TYPES.map(function(t){
          return '<option value="' + esc(t.name) + '"' + (t.name === selectedType ? ' selected' : '') + '>' + esc(t.name) + '</option>';
        }).join('');
      }

      function agentRow(a){
        a = a || {};
        var node = el(
          '<fieldset style="border:1px solid var(--sk-border);border-radius:6px;padding:var(--sk-space-3);margin-bottom:var(--sk-space-3);">' +
            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:var(--sk-space-2);align-items:end;margin-bottom:var(--sk-space-2);">' +
              '<label class="sk-label">Name<input class="sk-input" data-f="name" type="text" value="' + esc(a.name) + '" placeholder="e.g. Coder"></label>' +
              '<label class="sk-label">Type<select class="sk-select" data-f="type">' + typeOptions(a.type) + '</select></label>' +
              '<label class="sk-label">Model<input class="sk-input" data-f="model" type="text" value="' + esc(a.model || 'default') + '" placeholder="default"></label>' +
              '<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-remove>Remove</button>' +
            '</div>' +
            '<label class="sk-label">Role<input class="sk-input" data-f="role" type="text" value="' + esc(a.role || '') + '" placeholder="e.g. worker (optional)"></label>' +
            '<label class="sk-label">Instruction<textarea class="sk-textarea" data-f="instruction" rows="3" placeholder="System instruction for this agent...">' + esc(a.instruction) + '</textarea></label>' +
            '<input type="hidden" data-f="id" value="' + esc(a.id || '') + '">' +
          '</fieldset>'
        );
        node.querySelector('[data-remove]').addEventListener('click', function(){ node.remove(); });
        return node;
      }

      document.getElementById('lt-add-phase').addEventListener('click', function(){ phasesEl.appendChild(phaseRow({})); });
      document.getElementById('lt-add-agent').addEventListener('click', function(){ agentsEl.appendChild(agentRow({})); });

      (INITIAL_PHASES.length ? INITIAL_PHASES : [{}]).forEach(function(p){ phasesEl.appendChild(phaseRow(p)); });
      INITIAL_AGENTS.forEach(function(a){ agentsEl.appendChild(agentRow(a)); });

      function collectPhases(){
        var out = [];
        phasesEl.querySelectorAll('fieldset').forEach(function(fs){
          var name = fs.querySelector('[data-f="name"]').value.trim();
          if (!name) return;
          out.push({
            name: name,
            prompt: fs.querySelector('[data-f="prompt"]').value,
            review: fs.querySelector('[data-f="review"]').checked
          });
        });
        return out;
      }

      function collectAgents(){
        var out = [];
        agentsEl.querySelectorAll('fieldset').forEach(function(fs){
          var type = fs.querySelector('[data-f="type"]').value.trim();
          if (!type) return;
          var role = fs.querySelector('[data-f="role"]').value.trim();
          var idVal = fs.querySelector('[data-f="id"]').value.trim();
          var agent = {
            name: fs.querySelector('[data-f="name"]').value.trim(),
            type: type,
            model: fs.querySelector('[data-f="model"]').value.trim() || 'default',
            instruction: fs.querySelector('[data-f="instruction"]').value
          };
          if (idVal) agent.id = idVal;
          if (role) agent.role = role;
          out.push(agent);
        });
        return out;
      }

      var form = document.getElementById('lt-form');
      var errEl = document.getElementById('lt-error');
      form.addEventListener('htmx:configRequest', function(evt){
        var phasesJson = JSON.stringify(collectPhases());
        var agentsJson = JSON.stringify(collectAgents());
        // Keep the hidden inputs in sync (for non-htmx fallbacks)...
        document.getElementById('lt-phases-json').value = phasesJson;
        document.getElementById('lt-agents-json').value = agentsJson;
        // ...but htmx has already snapshotted form values into evt.detail.parameters
        // by the time this fires, so write the dynamic fields there directly.
        if (evt && evt.detail && evt.detail.parameters) {
          evt.detail.parameters['phases'] = phasesJson;
          evt.detail.parameters['agents'] = agentsJson;
        }
      });
      form.addEventListener('htmx:afterRequest', function(evt){
        var xhr = evt.detail.xhr;
        if (evt.detail.successful) {
          var redirect = xhr.getResponseHeader('HX-Redirect');
          window.location.href = redirect || '/config';
          return;
        }
        var msg = 'Save failed.';
        try { var d = JSON.parse(xhr.responseText); if (d && d.error) msg = d.error; } catch (e) {}
        errEl.textContent = msg;
      });
    })();
    </script>
  `, "/config");
}
