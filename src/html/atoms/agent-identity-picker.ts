/**
 * Agent identity picker — a color + creature-character chooser shared by the team
 * map, single-agent and custom-agent editors. Self-contained: the widget holds the
 * chosen values on its root's dataset (`data-color` / `data-character`), so each
 * editor's `collect()` reads them with `readAgentIdentity(root)` and seeds an
 * existing agent with `data-color`/`data-character` on render. Include
 * `agentIdentityPickerScript()` once per page to wire clicks (event-delegated, so
 * it survives the team-map modal being re-opened).
 *
 * Creatures tint live: every option SVG inherits `--agent-color`/`--agent-ink` from
 * the root, so picking a color rewrites two vars and re-tints the whole widget with
 * no re-render. See atoms/creature.ts.
 */
import { escapeHtml } from "./escape-html";
import {
  AGENT_COLORS, CREATURE_IDS, DEFAULT_AGENT_COLOR,
  creatureSvg, inkFor, isCreatureId, sanitizeColor,
} from "./creature";

export interface AgentIdentity {
  color: string;
  character: string; // "" = none (cube fallback)
}

export function normalizeIdentity(color: unknown, character: unknown): AgentIdentity {
  return {
    color: sanitizeColor(color),
    character: isCreatureId(character) ? character : "",
  };
}

/**
 * The picker markup. `color` defaults to the standard color; `character` empty ⇒
 * the cube fallback is pre-selected. The character section (a creature is an
 * experimental extra) renders only when `experimental` is true; color is always
 * shown. When character is hidden the editors must not require one on save.
 */
export function agentIdentityPicker(opts: { color?: string; character?: string | null; experimental?: boolean } = {}): string {
  const color = sanitizeColor(opts.color ?? DEFAULT_AGENT_COLOR);
  const character = isCreatureId(opts.character) ? opts.character : "";
  const vars = `--agent-color:${color};--agent-ink:${inkFor(color)}`;

  const swatches = AGENT_COLORS.map((c) =>
    `<button type="button" class="ai-swatch${c === color ? " ai-swatch--on" : ""}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Color ${c}"></button>`,
  ).join("");

  let characterSection = "";
  if (opts.experimental) {
    const cubeOpt = `<button type="button" class="ai-creature ai-creature--none${character === "" ? " ai-creature--on" : ""}" data-character="" title="No character (cube)" aria-label="No character (cube)"><span class="ai-creature__cube zen-orb__cube"></span></button>`;
    const creatures = CREATURE_IDS.map((id) =>
      `<button type="button" class="ai-creature${id === character ? " ai-creature--on" : ""}" data-character="${id}" title="${id}" aria-label="Character ${id}">${creatureSvg(id)}</button>`,
    ).join("");
    characterSection = `<details class="ai-creatures-wrap">
      <summary class="ai-creatures-wrap__summary">Character</summary>
      <div class="ai-creatures">${cubeOpt}${creatures}</div>
    </details>`;
  }

  return `<div class="ai-picker" data-agent-identity data-color="${color}" data-character="${escapeHtml(character)}" style="${vars}">
    <div class="ai-swatches">${swatches}</div>
    ${characterSection}
  </div>`;
}

/**
 * The picker wrapped in the standard `sk-panel` chrome used by the agent editors,
 * so each editor adds one line. Seed from the stored agent's color/character.
 */
export function identityPanel(opts: { color?: string; character?: string | null; experimental?: boolean } = {}): string {
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
    var character=root.getAttribute('data-character')||'';
    root.style.setProperty('--agent-color',color);
    root.style.setProperty('--agent-ink',ink(color));
    root.querySelectorAll('.ai-swatch').forEach(function(b){b.classList.toggle('ai-swatch--on',b.getAttribute('data-color')===color);});
    root.querySelectorAll('.ai-creature').forEach(function(b){b.classList.toggle('ai-creature--on',b.getAttribute('data-character')===character);});
  }
  window.SkipperIdentity={
    read:function(root){return {color:root.getAttribute('data-color')||'${DEFAULT_AGENT_COLOR}',character:root.getAttribute('data-character')||''};},
    set:function(root,color,character){if(!root)return;root.setAttribute('data-color',color||'${DEFAULT_AGENT_COLOR}');root.setAttribute('data-character',character||'');paint(root);}
  };
  document.addEventListener('click',function(e){
    var sw=e.target.closest&&e.target.closest('.ai-swatch');
    if(sw){var root=sw.closest('[data-agent-identity]');if(root){root.setAttribute('data-color',sw.getAttribute('data-color'));paint(root);}return;}
    var cr=e.target.closest&&e.target.closest('.ai-creature');
    if(cr){var r2=cr.closest('[data-agent-identity]');if(r2){r2.setAttribute('data-character',cr.getAttribute('data-character')||'');paint(r2);}return;}
  });
  document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-agent-identity]').forEach(paint);});
  // Also paint any already-parsed pickers (script may load after DOMContentLoaded).
  document.querySelectorAll('[data-agent-identity]').forEach(paint);
})();</script>`;
}
