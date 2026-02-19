import { escapeHtml } from "../atoms/escape-html";
import type { AgentDefinition } from "../../config/store";
import type { AgentTypeDefinition } from "../../agents/types";

// Agent types the operator can actually pick from in the UI. Other types
// (opencode, oz, conversation-skipper) remain valid in the DB/config but are
// hidden here until they're properly supported end-to-end.
const ALLOWED_AGENT_TYPES = new Set(["claude-code", "codex"]);

export function configAgentEditFragment(agent: AgentDefinition, agentTypes: AgentTypeDefinition[]): string {
  const eid = escapeHtml(agent.id);

  // Keep the agent's current type visible even if it's not in the allow-list,
  // so editing a legacy agent doesn't silently lose its type.
  const visibleTypes = agentTypes.filter(
    (t) => ALLOWED_AGENT_TYPES.has(t.name) || t.name === agent.type,
  );

  const typeOptions = visibleTypes.map((t) =>
    `<option value="${escapeHtml(t.name)}"${t.name === agent.type ? " selected" : ""}>${escapeHtml(t.name)}</option>`
  ).join("");

  // Per-type model lists drive both the initial render and the JS that
  // repopulates the model dropdown when the operator changes the type.
  const modelsByType: Record<string, string[]> = {};
  for (const t of visibleTypes) modelsByType[t.name] = t.available_models;

  const activeModels = modelsByType[agent.type] ?? [];
  const modelOptions = activeModels.map((m) =>
    `<option value="${escapeHtml(m)}"${m === agent.model ? " selected" : ""}>${escapeHtml(m)}</option>`
  ).join("");
  const modelsByTypeJson = escapeHtml(JSON.stringify(modelsByType));

  const caps = (agent.capabilities ?? []).join(", ");

  return `<tr id="agent-edit-${eid}" class="sk-edit-row">
    <td colspan="5">
      <form hx-post="/api/config/agents/${eid}" hx-target="#agent-row-${eid}" hx-swap="outerHTML" class="sk-inline-edit-form">
        <div class="sk-inline-edit-form__grid">
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Name</span>
            <span class="sk-inline-edit-form__hint">Display name shown in the UI and delegation prompts.</span>
            <input type="text" name="name" value="${escapeHtml(agent.name)}" class="sk-input sk-input--sm" required>
          </div>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Type</span>
            <span class="sk-inline-edit-form__hint">CLI tool used to run this agent.</span>
            <select name="type" class="sk-select sk-select--sm"
              data-agent-edit-type
              data-models-by-type="${modelsByTypeJson}"
              onchange="(function(sel){var map=JSON.parse(sel.getAttribute('data-models-by-type')||'{}');var models=map[sel.value]||[];var modelSel=sel.closest('form').querySelector('select[name=model]');if(!modelSel)return;var current=modelSel.value;modelSel.innerHTML=models.map(function(m){return '<option value=\\''+m+'\\''+(m===current?' selected':'')+'>'+m+'</option>';}).join('');if(models.indexOf(current)===-1&&current){var o=document.createElement('option');o.value=current;o.textContent=current;o.selected=true;modelSel.appendChild(o);}})(this)">${typeOptions}</select>
          </div>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Model</span>
            <span class="sk-inline-edit-form__hint">LLM model passed to the CLI via its model flag. Filtered to the selected type.</span>
            <select name="model" class="sk-select sk-select--sm">${modelOptions}
              ${!activeModels.includes(agent.model) ? `<option value="${escapeHtml(agent.model)}" selected>${escapeHtml(agent.model)}</option>` : ""}
            </select>
          </div>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Capabilities</span>
            <span class="sk-inline-edit-form__hint">Tags describing what this agent can do. Used for delegation matching.</span>
            <input type="text" name="capabilities" value="${escapeHtml(caps)}" class="sk-input sk-input--sm" placeholder="comma-separated">
          </div>
        </div>
        <div class="sk-inline-edit-form__field" style="margin-top:var(--sk-space-3);">
          <span class="sk-inline-edit-form__label">Instruction</span>
          <span class="sk-inline-edit-form__hint">System prompt injected when this agent is spawned. Defines the agent's role, constraints, and output expectations.</span>
          <textarea name="instruction" rows="8" class="sk-textarea sk-textarea--sm" style="font-family:var(--sk-font-mono);font-size:11px;">${escapeHtml(agent.instruction ?? "")}</textarea>
        </div>
        <div class="sk-inline-edit-form__actions">
          <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Save</button>
          <button type="button" class="sk-btn sk-btn--sm" onclick="document.getElementById('agent-edit-${eid}').remove()">Cancel</button>
        </div>
      </form>
    </td>
  </tr>`;
}
