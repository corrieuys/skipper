/**
 * Agent identity picker — a color chooser shared by the team map, single-agent
 * and custom-agent editors. Self-contained: the widget holds the chosen color on
 * its root's dataset (`data-color`), so each editor's `collect()` reads it with
 * `SkipperIdentity.read(root)` and seeds an existing agent with `data-color` on
 * render. The stored `character` rides along on `data-character` untouched (no
 * control edits it), so a save round-trips it. Include
 * `agentIdentityPickerScript()` once per page to wire clicks (event-delegated, so
 * it survives the team-map modal being re-opened).
 */
import { escapeHtml } from "./escape-html";
import { AGENT_COLORS, DEFAULT_AGENT_COLOR, inkFor, isCreatureId, sanitizeColor } from "./creature";

export interface AgentIdentity {
  color: string;
  character: string; // "" = none
}

export function normalizeIdentity(color: unknown, character: unknown): AgentIdentity {
  return {
    color: sanitizeColor(color),
    character: isCreatureId(character) ? character : "",
  };
}

/**
 * The picker markup. `color` defaults to the standard color; `character` is only
 * carried on the root so the editors round-trip the stored value.
 */
export function agentIdentityPicker(opts: { color?: string; character?: string | null } = {}): string {
  const color = sanitizeColor(opts.color ?? DEFAULT_AGENT_COLOR);
  const character = isCreatureId(opts.character) ? opts.character : "";
  const vars = `--agent-color:${color};--agent-ink:${inkFor(color)}`;

  const swatches = AGENT_COLORS.map((c) =>
    `<button type="button" class="ai-swatch${c === color ? " ai-swatch--on" : ""}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Color ${c}"></button>`,
  ).join("");

  return `<div class="ai-picker" data-agent-identity data-color="${color}" data-character="${escapeHtml(character)}" style="${vars}">
    <div class="ai-swatches">${swatches}</div>
  </div>`;
}

/**
 * The picker wrapped in the standard `sk-panel` chrome used by the agent editors,
 * so each editor adds one line. Seed from the stored agent's color/character.
 */
export function identityPanel(opts: { color?: string; character?: string | null } = {}): string {
  return `<div class="sk-panel">
    <div class="sk-panel__header"><span class="sk-panel__title">Identity</span></div>
    <div class="sk-panel__body">
      ${agentIdentityPicker(opts)}
    </div>
  </div>`;
}

/**
 * One inline script per page that wires every `[data-agent-identity]` picker.
 * Also exposes `window.SkipperIdentity.set(root, color, character)` so an editor
 * can push a loaded agent's identity into the widget.
 */
export function agentIdentityPickerScript(): string {
  return `<script>(function(){
  if (window.SkipperIdentity) return;
  function ink(hex){var s=(hex||'').trim();if(!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s))s='${DEFAULT_AGENT_COLOR}';var h=s.slice(1);if(h.length===3)h=h.split('').map(function(c){return c+c;}).join('');var n=parseInt(h,16);function cl(v){return Math.max(0,Math.min(255,v));}var r=cl((n>>16)-45),g=cl(((n>>8)&255)-45),b=cl((n&255)-45);return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);}
  function paint(root){
    var color=root.getAttribute('data-color')||'${DEFAULT_AGENT_COLOR}';
    root.style.setProperty('--agent-color',color);
    root.style.setProperty('--agent-ink',ink(color));
    root.querySelectorAll('.ai-swatch').forEach(function(b){b.classList.toggle('ai-swatch--on',b.getAttribute('data-color')===color);});
  }
  window.SkipperIdentity={
    read:function(root){return {color:root.getAttribute('data-color')||'${DEFAULT_AGENT_COLOR}',character:root.getAttribute('data-character')||''};},
    set:function(root,color,character){if(!root)return;root.setAttribute('data-color',color||'${DEFAULT_AGENT_COLOR}');root.setAttribute('data-character',character||'');paint(root);}
  };
  document.addEventListener('click',function(e){
    var sw=e.target.closest&&e.target.closest('.ai-swatch');
    if(sw){var root=sw.closest('[data-agent-identity]');if(root){root.setAttribute('data-color',sw.getAttribute('data-color'));paint(root);}return;}
  });
  document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-agent-identity]').forEach(paint);});
  // Also paint any already-parsed pickers (script may load after DOMContentLoaded).
  document.querySelectorAll('[data-agent-identity]').forEach(paint);
})();</script>`;
}
