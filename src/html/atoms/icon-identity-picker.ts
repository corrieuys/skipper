/**
 * Icon identity picker — a Lucide-icon + color chooser, the icon counterpart to
 * the agent identity picker (color + creature). Shared by the team map, the task
 * form and the recurring-task form so teams / tasks / recurring runs can carry an
 * icon that shows in the sidebar, lists and headers.
 *
 * The widget holds its chosen values on the root's dataset (`data-icon` /
 * `data-color`). The team map reads them with `window.SkipperIcons.read(root)`;
 * plain server-POST forms pass `nameIcon`/`nameColor` so the widget also keeps two
 * hidden inputs in sync. The full 2000-icon set is NOT inlined into the page — the
 * script fetches `/lucide-icons.json` (embedded asset) once, shows a popular subset,
 * and filters the whole set by name + keywords as the user searches. The chosen
 * icon is rendered server-side for a no-JS preview and to tint the whole widget via
 * `--icon-color`, reusing the agent color palette (`AGENT_COLORS`).
 */
import { escapeHtml } from "./escape-html";
import { AGENT_COLORS, DEFAULT_AGENT_COLOR, sanitizeColor } from "./creature";
import { lucideSvg, sanitizeIcon } from "./lucide";

export interface IconIdentityOptions {
  icon?: string | null;
  color?: string | null;
  /** When set, the widget keeps a hidden input of this name synced to the icon id. */
  nameIcon?: string;
  /** When set, the widget keeps a hidden input of this name synced to the color. */
  nameColor?: string;
}

export function iconIdentityPicker(opts: IconIdentityOptions = {}): string {
  const icon = sanitizeIcon(opts.icon) ?? "";
  const color = sanitizeColor(opts.color ?? DEFAULT_AGENT_COLOR);

  const swatches = AGENT_COLORS.map((c) =>
    `<button type="button" class="ic-swatch${c === color ? " ic-swatch--on" : ""}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Color ${c}"></button>`,
  ).join("");

  const hidden = [
    opts.nameIcon ? `<input type="hidden" name="${escapeHtml(opts.nameIcon)}" value="${escapeHtml(icon)}" data-ic-hidden-icon>` : "",
    opts.nameColor ? `<input type="hidden" name="${escapeHtml(opts.nameColor)}" value="${escapeHtml(color)}" data-ic-hidden-color>` : "",
  ].join("");

  const preview = icon
    ? lucideSvg(icon, { color, size: 22 })
    : `<span class="ic-preview__empty" title="No icon"></span>`;

  return `<div class="ic-picker" data-icon-identity data-icon="${escapeHtml(icon)}" data-color="${color}" style="--icon-color:${color}">
    ${hidden}
    <div class="ic-picker__head">
      <span class="ic-preview" data-ic-preview>${preview}</span>
      <input type="search" class="sk-input ic-search" data-ic-search placeholder="Search icons…" autocomplete="off" aria-label="Search icons">
      <button type="button" class="ic-clear" data-ic-clear title="No icon" aria-label="Clear icon">&times;</button>
    </div>
    <div class="ic-swatches">${swatches}</div>
    <div class="ic-grid" data-ic-grid role="listbox" aria-label="Icons"></div>
  </div>`;
}

/** Picker wrapped in the standard panel chrome, so an editor adds one line. */
export function iconIdentityPanel(opts: IconIdentityOptions = {}): string {
  return `<div class="sk-panel">
    <div class="sk-panel__header"><span class="sk-panel__title">Icon</span></div>
    <div class="sk-panel__body">${iconIdentityPicker(opts)}</div>
  </div>`;
}

/**
 * One inline script per page. Fetches the icon set once, renders the popular
 * subset, wires search + selection, and exposes `window.SkipperIcons.read/set`.
 * Event-delegated + idempotent so it survives the team-map modal re-rendering.
 */
export function iconIdentityPickerScript(): string {
  return `<script>(function(){
  if (window.SkipperIcons) return;
  var DEFAULT='${DEFAULT_AGENT_COLOR}';
  var DATA=null, PENDING=[];
  function svg(inner){return '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+inner+'</svg>';}
  function ensureData(cb){
    if(DATA){cb(DATA);return;}
    PENDING.push(cb);
    if(PENDING.length>1)return;
    fetch('/lucide-icons.json').then(function(r){return r.json();}).then(function(d){DATA=d;PENDING.splice(0).forEach(function(f){f(d);});}).catch(function(){DATA={icons:{},keywords:{},popular:[]};PENDING.splice(0).forEach(function(f){f(DATA);});});
  }
  function matches(d,q){
    q=q.trim().toLowerCase();
    var out=[];
    if(!q){return d.popular.filter(function(id){return d.icons[id];});}
    var ids=Object.keys(d.icons);
    for(var i=0;i<ids.length&&out.length<240;i++){
      var id=ids[i];
      if(id.indexOf(q)!==-1){out.push(id);continue;}
      var kw=d.keywords[id];
      if(kw){for(var j=0;j<kw.length;j++){if(kw[j].indexOf(q)!==-1){out.push(id);break;}}}
    }
    return out;
  }
  function renderGrid(root,q){
    var grid=root.querySelector('[data-ic-grid]');if(!grid)return;
    ensureData(function(d){
      var sel=root.getAttribute('data-icon')||'';
      var ids=matches(d,q||'');
      var html='';
      for(var i=0;i<ids.length;i++){var id=ids[i];html+='<button type="button" class="ic-icon'+(id===sel?' ic-icon--on':'')+'" data-icon-id="'+id+'" title="'+id+'" aria-label="'+id+'">'+svg(d.icons[id])+'</button>';}
      grid.innerHTML=html||'<div class="ic-grid__empty">No matches</div>';
    });
  }
  function paintPreview(root){
    var prev=root.querySelector('[data-ic-preview]');if(!prev)return;
    var id=root.getAttribute('data-icon')||'';
    ensureData(function(d){prev.innerHTML=id&&d.icons[id]?svg(d.icons[id]):'<span class="ic-preview__empty" title="No icon"></span>';});
  }
  function paint(root){
    var color=root.getAttribute('data-color')||DEFAULT;
    root.style.setProperty('--icon-color',color);
    root.querySelectorAll('.ic-swatch').forEach(function(b){b.classList.toggle('ic-swatch--on',b.getAttribute('data-color')===color);});
    var sel=root.getAttribute('data-icon')||'';
    root.querySelectorAll('.ic-icon').forEach(function(b){b.classList.toggle('ic-icon--on',b.getAttribute('data-icon-id')===sel);});
    var hi=root.querySelector('[data-ic-hidden-icon]');if(hi)hi.value=sel;
    var hc=root.querySelector('[data-ic-hidden-color]');if(hc)hc.value=color;
    paintPreview(root);
  }
  function initRoot(root){if(root.__icInit)return;root.__icInit=true;renderGrid(root,'');paint(root);}
  window.SkipperIcons={
    read:function(root){return {icon:root.getAttribute('data-icon')||'',color:root.getAttribute('data-color')||DEFAULT};},
    set:function(root,icon,color){if(!root)return;root.setAttribute('data-icon',icon||'');root.setAttribute('data-color',color||DEFAULT);renderGrid(root,(root.querySelector('[data-ic-search]')||{}).value||'');paint(root);}
  };
  document.addEventListener('click',function(e){
    var t=e.target;
    var sw=t.closest&&t.closest('.ic-swatch');
    if(sw){var r=sw.closest('[data-icon-identity]');if(r){r.setAttribute('data-color',sw.getAttribute('data-color'));paint(r);}return;}
    var ic=t.closest&&t.closest('.ic-icon');
    if(ic){var r2=ic.closest('[data-icon-identity]');if(r2){var id=ic.getAttribute('data-icon-id');r2.setAttribute('data-icon',r2.getAttribute('data-icon')===id?'':id);paint(r2);}return;}
    var cl=t.closest&&t.closest('[data-ic-clear]');
    if(cl){var r3=cl.closest('[data-icon-identity]');if(r3){r3.setAttribute('data-icon','');paint(r3);}return;}
  });
  document.addEventListener('input',function(e){
    var s=e.target;if(!s.hasAttribute||!s.hasAttribute('data-ic-search'))return;
    var r=s.closest('[data-icon-identity]');if(r)renderGrid(r,s.value);
  });
  function initAll(){document.querySelectorAll('[data-icon-identity]').forEach(initRoot);}
  document.addEventListener('DOMContentLoaded',initAll);
  initAll();
})();</script>`;
}
