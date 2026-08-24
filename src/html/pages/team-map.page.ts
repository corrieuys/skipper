import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { isExperimental } from "../../config/feature-flags";
import type { LocalTeam } from "../../teams/local-teams";

/**
 * One selectable provider. The model is free text rather than a pick list — a
 * provider ships new model names faster than the agent-type config is updated —
 * so the models it advertises are not carried into the page.
 */
export interface AgentTypeChoice {
  name: string;
  /**
   * What to show instead of `name`. Custom agents are keyed `custom:<uuid>`,
   * which is unreadable in a dropdown; the definition's own name goes here.
   * Absent for the CLI providers, whose name is already the label.
   */
  label?: string;
}

/** An operator-defined tool a team may grant to any of its agents. */
export interface CustomToolChoice {
  name: string;
  description: string;
}

export interface TeamMapViewModel {
  /** null when creating a brand-new team (the map starts from a scaffold). */
  team: LocalTeam | null;
  agentTypes: AgentTypeChoice[];
  /** Operator-defined tools selectable per agent. Empty when none are defined. */
  customTools: CustomToolChoice[];
  /**
   * Providers selectable for a real-time team's transcription-summary model
   * (the model-settings allowlist). Model itself is free text, per convention.
   */
  modelProviders: string[];
  /**
   * Agent library, offered in the crew's "add from library" control. A pick adds
   * a LIVE REFERENCE member carrying `refType` (`single:<id>` for a headless CLI
   * agent, `custom:<id>` for a custom agent); the definition's provider, model,
   * prompt and tools are resolved from the record at run time, not copied. Empty
   * when none / not experimental.
   */
  agentLibrary: Array<{ id: string; name: string; refType: string; kind: "single" | "custom"; provider: string; model: string }>;
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

/**
 * Interactive team map. The whole diagram is rendered client-side from one TEAM
 * object so that every edit (reorder a phase, toggle a gate, edit an agent)
 * is a mutation + re-render rather than a round trip. Nothing persists until
 * Save, which POSTs the entire team as JSON to the same API the config form uses.
 */
export function teamMapPage(vm: TeamMapViewModel): string {
  const isNew = !vm.team;
  const title = isNew ? "New Team" : vm.team!.name;

  // Scaffold for a new team: one phase so the flow is never empty.
  const team = vm.team ?? {
    id: "",
    name: "",
    skipper_prompt: "",
    hooks: [],
    phases: [{ name: "build", prompt: "", review: false }],
    agents: [],
    config: {},
    created_at: "",
    updated_at: "",
  };

  return v2layout(title, `
    ${navbar({ currentPath: "/teams", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="tm-shell">
      <div class="tm-topbar">
        <a class="tm-topbar__back" href="/teams">&larr; Teams</a>
        <div class="tm-topbar__heading">
          <h1 class="tm-topbar__title"><span id="tm-title">${escapeHtml(team.name || "Untitled team")}</span><span class="tm-dot" id="tm-dirty" hidden title="Unsaved changes"></span></h1>
          <div class="tm-topbar__sub" id="tm-subtitle"></div>
        </div>
        <div class="tm-topbar__actions">
          <span class="tm-error" id="tm-error"></span>
          <button type="button" class="sk-btn sk-btn--sm" id="tm-settings">Team settings</button>
          ${isNew ? "" : `<a class="sk-btn sk-btn--sm" href="/api/teams/export?id=${encodeURIComponent(team.id)}">Export</a>`}
          ${isNew ? "" : `<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" id="tm-delete">Delete</button>`}
          <button type="button" class="sk-btn sk-btn--sm sk-btn--primary" id="tm-save">${isNew ? "Create team" : "Save"}</button>
        </div>
      </div>

      <div class="tm-band">
        <div class="tm-band__head">
          <span class="tm-band__label">Phase flow</span>
          <span class="tm-band__hint">Click a phase to edit its prompt. Click a diamond to toggle the review gate that pauses the task for a human.</span>
        </div>
        <div class="tm-flow-wrap tm-board" id="tm-flow-wrap">
          <div class="tm-flow" id="tm-flow"></div>
          <button type="button" class="tm-flow-nav tm-flow-nav--left" id="tm-flow-left" aria-label="Scroll phases left" title="Earlier phases">&#8249;</button>
          <button type="button" class="tm-flow-nav tm-flow-nav--right" id="tm-flow-right" aria-label="Scroll phases right" title="Later phases">&#8250;</button>
        </div>
      </div>

      <div class="tm-band">
        <div class="tm-band__head">
          <span class="tm-band__label">Crew</span>
          <span class="tm-band__hint">Skipper is the implicit lead and cannot be removed.</span>
        </div>
        <div class="tm-tree tm-board" id="tm-crew"></div>
      </div>
    </div>

    <div class="sk-modal" id="tm-modal">
      <div class="sk-modal__content tm-modal__content">
        <div class="sk-modal__header">
          <h2 class="tm-modal__title" id="tm-modal-title"></h2>
          <button type="button" class="tm-modal__close" id="tm-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="sk-modal__body" id="tm-modal-body"></div>
        <div class="tm-modal__footer" id="tm-modal-footer"></div>
      </div>
    </div>

    <script>
    (function(){
      var TEAM = ${jsonScript({
        id: team.id,
        name: team.name,
        skipper_prompt: team.skipper_prompt,
        hooks: team.hooks,
        phases: team.phases,
        agents: team.agents,
        config: team.config ?? {},
      })};
      var AGENT_TYPES = ${jsonScript(vm.agentTypes)};
      var CUSTOM_TOOLS = ${jsonScript(vm.customTools)};
      var MODEL_PROVIDERS = ${jsonScript(vm.modelProviders)};
      var LIBRARY = ${jsonScript(vm.agentLibrary)};
      var IS_NEW = ${isNew ? "true" : "false"};

      // A library reference member carries a ref token as its type: single:<id>
      // (headless CLI agent) or custom:<id> (custom agent). Its provider/model/
      // prompt/tools live in the record and are resolved at run time, so the
      // editor shows it as a locked reference, not editable provider fields.
      var REF = {};
      LIBRARY.forEach(function(e){ REF[e.refType] = e; });
      function isRefType(t){ return !!t && (t.indexOf('single:') === 0 || t.indexOf('custom:') === 0); }
      function refKindLabel(kind){ return kind === 'custom' ? 'Custom agent' : 'Headless CLI agent'; }
      function refEntry(t){ return REF[t] || null; }
      function refKindOf(t){ return t.indexOf('custom:') === 0 ? 'custom' : 'single'; }
      // Editor page for the referenced record, so "Edit agent" lands on the agent
      // itself (same tab), not the library index.
      function refEditHref(e){
        if (!e) return '';
        return (e.kind === 'custom' ? '/custom-agents/' : '/single-agents/') + encodeURIComponent(e.id);
      }
      // Small link glyph marking a member as an externally-referenced library agent.
      var REF_ICON = '<span class="tm-ref-icon" title="Referenced from the agent library">' +
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;opacity:0.75">' +
        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
        '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>';

      function typeLabel(name){
        for (var i = 0; i < AGENT_TYPES.length; i++) {
          if (AGENT_TYPES[i].name === name) return AGENT_TYPES[i].label || AGENT_TYPES[i].name;
        }
        return name;
      }
      // Consensus and the per-team Slack opt-in are experimental everywhere else
      // in the UI (task form, config page), so they stay gated here too. When a
      // section is not rendered its apply path must LEAVE the stored value alone
      // rather than read a missing field as "cleared".
      var EXPERIMENTAL = ${isExperimental() ? "true" : "false"};

      var flowEl = document.getElementById('tm-flow');
      var crewEl = document.getElementById('tm-crew');
      var dirtyEl = document.getElementById('tm-dirty');
      var errEl = document.getElementById('tm-error');
      var titleEl = document.getElementById('tm-title');
      var subtitleEl = document.getElementById('tm-subtitle');
      var dirty = false;

      function esc(s){
        return String(s == null ? '' : s)
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
      function el(html){ var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
      function markDirty(){ dirty = true; dirtyEl.hidden = false; }

      // Ensure every agent carries a stable client-side id so consensus reviewer
      // refs survive renames.
      function slug(s){
        return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
      }
      function uniqueAgentId(base, exceptId){
        var used = {};
        TEAM.agents.forEach(function(a){ if (a.id && a.id !== exceptId) used[a.id] = true; });
        var candidate = slug(base) || 'agent';
        if (!used[candidate]) return candidate;
        var i = 2;
        while (used[candidate + '-' + i]) i++;
        return candidate + '-' + i;
      }

      // Agent ids are author-facing (they show up in exports and in consensus
      // reviewer refs), so keep them tracking the name until the team is saved.
      // Every inbound reference has to move with the id.
      function renameAgentId(a, nextId){
        if (!nextId || nextId === a.id) return;
        var prevId = a.id;
        if (TEAM.id) {
          var before = TEAM.id + ':' + prevId;
          var after = TEAM.id + ':' + nextId;
          TEAM.phases.forEach(function(p){
            if (p.consensus && p.consensus.reviewer_agent_id === before) p.consensus.reviewer_agent_id = after;
          });
        }
        a.id = nextId;
      }
      TEAM.agents.forEach(function(a){ if (!a.id) a.id = uniqueAgentId(a.name || 'agent'); });

      // ── Header summary ────────────────────────────────────────────────
      function renderHeader(){
        titleEl.textContent = TEAM.name || 'Untitled team';
        document.title = (TEAM.name || 'New Team') + ' - Skipper';
        var gates = TEAM.phases.filter(function(p){ return p.review; }).length;
        var bits = [
          TEAM.phases.length + ' phase' + (TEAM.phases.length === 1 ? '' : 's'),
          TEAM.agents.length + ' agent' + (TEAM.agents.length === 1 ? '' : 's'),
          gates + ' review gate' + (gates === 1 ? '' : 's')
        ];
        if (TEAM.config && TEAM.config.slackEnabled) bits.push('Slack on');
        if (TEAM.config && TEAM.config.slashCommand) bits.push(TEAM.config.slashCommand);
        subtitleEl.textContent = bits.join(' · ');
      }

      // ── Phase flow ────────────────────────────────────────────────────
      // One connector per gap. It carries the insert affordance (hover-only) and,
      // when a phase precedes it, that phase's review-gate diamond — a gate belongs
      // to the phase it follows, because the task pauses on leaving that phase.
      function connector(insertAt, gatePhaseIdx){
        var html = '<div class="tm-conn' + (gatePhaseIdx != null ? ' tm-conn--gate' : '') + '">' +
          '<button type="button" class="tm-conn__insert" title="Insert phase here" aria-label="Insert phase here">+</button>';
        var gateOn = false;
        if (gatePhaseIdx != null) {
          gateOn = !!TEAM.phases[gatePhaseIdx].review;
          var phaseName = esc(TEAM.phases[gatePhaseIdx].name);
          // Always labelled, in both states: an unlabelled diamond gives no clue
          // that it is the review-gate toggle. The label lives outside the button
          // because the button is rotated 45°, so text inside it would need a
          // counter-rotation fighting the centring transform.
          html += '<span class="tm-gate-wrap">' +
            '<button type="button" class="tm-gate' + (gateOn ? ' tm-gate--on' : '') + '" ' +
              'title="' + (gateOn
                ? 'Review gate on — the task pauses after "' + phaseName + '" for a human. Click to remove.'
                : 'No review gate — click to make the task pause after "' + phaseName + '" for human review.') + '" ' +
              'aria-pressed="' + (gateOn ? 'true' : 'false') + '" ' +
              'aria-label="' + (gateOn ? 'Remove review gate after ' : 'Add review gate after ') + phaseName + '">' +
              '<span class="tm-gate__glyph">' + (gateOn ? '&#10003;' : '+') + '</span>' +
            '</button>' +
            '<span class="tm-gate__label' + (gateOn ? '' : ' tm-gate__label--off') + '">' +
              (gateOn ? 'Review gate' : 'Add review gate') +
            '</span>' +
          '</span>';
        }
        var node = el(html + '</div>');
        node.querySelector('.tm-conn__insert').addEventListener('click', function(){
          TEAM.phases.splice(insertAt, 0, { name: 'new phase', prompt: '', review: false });
          markDirty(); render();
          openPhaseModal(insertAt);
        });
        var gate = node.querySelector('.tm-gate');
        if (gate) {
          gate.addEventListener('click', function(){
            TEAM.phases[gatePhaseIdx].review = !TEAM.phases[gatePhaseIdx].review;
            markDirty(); render();
          });
        }
        return node;
      }

      function phaseNode(p, i){
        var chips = '';
        if (p.review) chips += '<span class="tm-chip tm-chip--review">Gate</span>';
        if (p.consensus) chips += '<span class="tm-chip tm-chip--consensus">' + esc(p.consensus.agent_count) + '&times; ' + esc(p.consensus.strategy) + '</span>';
        if (p.consensus && p.consensus.worktree) chips += '<span class="tm-chip">worktree</span>';

        var promptText = (p.prompt || '').trim();
        var node = el(
          '<div class="tm-phase" role="button" tabindex="0">' +
            '<div class="tm-tools">' +
              '<button type="button" class="tm-tools__btn" data-a="left" title="Move earlier" aria-label="Move phase earlier"' + (i === 0 ? ' disabled' : '') + '>&#9664;</button>' +
              '<button type="button" class="tm-tools__btn" data-a="right" title="Move later" aria-label="Move phase later"' + (i === TEAM.phases.length - 1 ? ' disabled' : '') + '>&#9654;</button>' +
              '<button type="button" class="tm-tools__btn tm-tools__btn--danger" data-a="del" title="Remove phase" aria-label="Remove phase">&times;</button>' +
            '</div>' +
            '<div class="tm-phase__top">' +
              '<span class="tm-phase__idx">' + String(i + 1).padStart(2, '0') + '</span>' +
              '<span class="tm-phase__name">' + esc(p.name) + '</span>' +
            '</div>' +
            '<div class="tm-phase__prompt' + (promptText ? '' : ' tm-phase__prompt--empty') + '">' +
              (promptText ? esc(promptText) : 'No prompt yet — click to write one.') +
            '</div>' +
            (chips ? '<div class="tm-phase__chips">' + chips + '</div>' : '') +
          '</div>'
        );

        function open(){ openPhaseModal(i); }
        node.addEventListener('click', function(e){
          if (e.target.closest('.tm-tools')) return;
          open();
        });
        node.addEventListener('keydown', function(e){
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        node.querySelector('[data-a="left"]').addEventListener('click', function(){ movePhase(i, -1); });
        node.querySelector('[data-a="right"]').addEventListener('click', function(){ movePhase(i, 1); });
        node.querySelector('[data-a="del"]').addEventListener('click', function(){
          if (TEAM.phases.length === 1) { flashError('A team needs at least one phase.'); return; }
          if (!window.confirm('Remove phase "' + (p.name || '') + '"?')) return;
          TEAM.phases.splice(i, 1); markDirty(); render();
        });
        return node;
      }

      function movePhase(i, delta){
        var j = i + delta;
        if (j < 0 || j >= TEAM.phases.length) return;
        var tmp = TEAM.phases[i];
        TEAM.phases[i] = TEAM.phases[j];
        TEAM.phases[j] = tmp;
        markDirty(); render();
      }

      function renderFlow(){
        flowEl.innerHTML = '';
        flowEl.appendChild(el('<div class="tm-cap tm-cap--start"><span class="tm-cap__ring"></span><span>Start</span></div>'));
        TEAM.phases.forEach(function(p, i){
          flowEl.appendChild(connector(i, i === 0 ? null : i - 1));
          flowEl.appendChild(phaseNode(p, i));
        });
        flowEl.appendChild(connector(TEAM.phases.length, TEAM.phases.length ? TEAM.phases.length - 1 : null));
        var add = el('<button type="button" class="tm-add tm-add--phase">+ Phase</button>');
        add.addEventListener('click', function(){
          TEAM.phases.push({ name: 'new phase', prompt: '', review: false });
          markDirty(); render();
          openPhaseModal(TEAM.phases.length - 1);
        });
        flowEl.appendChild(add);
        // Plain rail (no insert, no gate) so the add button does not sit flush
        // against the end cap.
        flowEl.appendChild(el('<div class="tm-conn tm-conn--plain"></div>'));
        flowEl.appendChild(el('<div class="tm-cap tm-cap--end"><span class="tm-cap__ring"></span><span>Complete</span></div>'));
      }

      // ── Crew tree ─────────────────────────────────────────────────────
      function agentNode(a){
        var meta, instr = '';
        if (isRefType(a.type)) {
          // Live reference: mark it with the link icon and show the record's
          // provider/model (owned by the library) so the card is not just a label.
          var e = refEntry(a.type);
          var kind = e ? e.kind : refKindOf(a.type);
          meta = REF_ICON + '<span>' + esc(refKindLabel(kind)) + '</span>';
          if (e) {
            if (kind === 'single' && e.provider) meta += '<span>·</span><span>' + esc(e.provider) + '</span>';
            if (e.model) meta += '<span>·</span><span>' + esc(e.model) + '</span>';
          } else {
            meta += '<span>·</span><span class="sk-muted">missing</span>';
          }
        } else {
          meta = '<span>' + esc(typeLabel(a.type)) + '</span><span>·</span><span>' + esc(a.model || 'default') + '</span>';
          if (a.instruction) instr = '<div class="tm-agent__instr">' + esc(a.instruction) + '</div>';
        }
        if (a.role) meta += '<span>·</span><span>' + esc(a.role) + '</span>';
        var node = el(
          '<div class="tm-agent" role="button" tabindex="0">' +
            '<div class="tm-tools">' +
              '<button type="button" class="tm-tools__btn tm-tools__btn--danger" data-a="del" title="Remove agent" aria-label="Remove agent">&times;</button>' +
            '</div>' +
            '<div class="tm-agent__name">' + esc(a.name || a.id) + '</div>' +
            '<div class="tm-agent__meta">' + meta + '</div>' +
            instr +
          '</div>'
        );
        function open(){ openAgentModal(a.id); }
        node.addEventListener('click', function(e){
          if (e.target.closest('.tm-tools')) return;
          open();
        });
        node.addEventListener('keydown', function(e){
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        node.querySelector('[data-a="del"]').addEventListener('click', function(){
          if (!window.confirm('Remove agent "' + (a.name || a.id) + '"?')) return;
          removeAgent(a.id);
        });
        return node;
      }

      function removeAgent(id){
        if (!TEAM.agents.some(function(x){ return x.id === id; })) return;
        TEAM.agents = TEAM.agents.filter(function(a){ return a.id !== id; });
        // Drop consensus reviewer references to the removed agent.
        var ns = TEAM.id ? TEAM.id + ':' + id : null;
        TEAM.phases.forEach(function(p){
          if (p.consensus && ns && p.consensus.reviewer_agent_id === ns) delete p.consensus.reviewer_agent_id;
        });
        markDirty(); render();
      }

      // The crew is a flat line: Skipper is a member like the rest, just the one
      // that starts every phase. There is no reporting hierarchy — every agent is
      // reachable from Skipper.
      function renderCrew(){
        crewEl.innerHTML = '';
        var leadPrompt = (TEAM.skipper_prompt || '').trim();
        var lead = el(
          '<div class="tm-lead" role="button" tabindex="0">' +
            '<div class="tm-lead__name">Skipper</div>' +
            '<div class="tm-lead__role">Team lead · entrypoint</div>' +
            '<div class="tm-agent__instr">' + (leadPrompt ? esc(leadPrompt) : '<span class="sk-muted">No extra context — click to add a Skipper prompt.</span>') + '</div>' +
          '</div>'
        );
        lead.addEventListener('click', function(){ openSkipperModal(); });
        lead.addEventListener('keydown', function(e){
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSkipperModal(); }
        });

        crewEl.appendChild(lead);
        TEAM.agents.forEach(function(a){ crewEl.appendChild(agentNode(a)); });

        var addNode = el('<button type="button" class="tm-add tm-add--agent">+ Agent</button>');
        addNode.addEventListener('click', function(){ addAgent(); });
        crewEl.appendChild(addNode);

        // Add a library agent as a LIVE REFERENCE member (headless CLI or custom).
        // The member only carries a ref token + name/role; the provider, model,
        // prompt and tools are resolved from the record at run time, so later
        // edits to the library agent flow through to this team.
        if (LIBRARY.length) {
          var lib = el('<select class="sk-select tm-add tm-add--lib" title="Add a live reference to a library agent"><option value="">+ From library</option></select>');
          function group(kind, label){
            var items = LIBRARY.filter(function(e){ return e.kind === kind; });
            if (!items.length) return;
            var og = document.createElement('optgroup');
            og.label = label;
            items.forEach(function(e){
              var opt = document.createElement('option');
              opt.value = e.refType;
              opt.textContent = e.name;
              og.appendChild(opt);
            });
            lib.appendChild(og);
          }
          group('single', 'Headless CLI agents');
          group('custom', 'Custom agents');
          lib.addEventListener('change', function(){
            var e = refEntry(lib.value);
            if (e) addFromLibrary(e);
            lib.value = '';
          });
          crewEl.appendChild(lib);
        }
      }

      function addAgent(){
        var type = (AGENT_TYPES[0] && AGENT_TYPES[0].name) || 'claude-code';
        var id = uniqueAgentId('agent');
        TEAM.agents.push({ id: id, name: 'New Agent', type: type, model: 'default', instruction: '', customTools: [] });
        markDirty(); render();
        openAgentModal(id);
      }

      // A library pick is a reference: store only the ref token + a display name.
      // Everything else is resolved from the record at run time.
      function addFromLibrary(entry){
        var id = uniqueAgentId(entry.name || 'agent');
        TEAM.agents.push({ id: id, name: entry.name || 'Agent', type: entry.refType });
        markDirty(); render();
        openAgentModal(id);
      }

      // ── Flow overflow indicators ──────────────────────────────────────
      // The track scrolls horizontally and can easily run past the viewport, so
      // shade the cut edge and offer a scroll button — but only on the side that
      // actually has more track.
      var flowWrap = document.getElementById('tm-flow-wrap');
      function updateFlowOverflow(){
        var max = flowEl.scrollWidth - flowEl.clientWidth;
        var x = flowEl.scrollLeft;
        flowWrap.classList.toggle('is-overflow-left', x > 2);
        flowWrap.classList.toggle('is-overflow-right', x < max - 2);
      }
      function scrollFlow(dir){
        flowEl.scrollBy({ left: dir * Math.max(260, flowEl.clientWidth * 0.8), behavior: 'smooth' });
      }
      flowEl.addEventListener('scroll', updateFlowOverflow);
      window.addEventListener('resize', updateFlowOverflow);
      document.getElementById('tm-flow-left').addEventListener('click', function(){ scrollFlow(-1); });
      document.getElementById('tm-flow-right').addEventListener('click', function(){ scrollFlow(1); });

      function render(){
        renderHeader(); renderFlow(); renderCrew();
        // Measure after the browser has laid the new nodes out.
        requestAnimationFrame(updateFlowOverflow);
      }

      // ── Modal plumbing ────────────────────────────────────────────────
      var modal = document.getElementById('tm-modal');
      var modalTitle = document.getElementById('tm-modal-title');
      var modalBody = document.getElementById('tm-modal-body');
      var modalFooter = document.getElementById('tm-modal-footer');

      function openModal(title, bodyHtml, footerHtml, wire){
        modalTitle.innerHTML = title;
        modalBody.innerHTML = bodyHtml;
        modalFooter.innerHTML = footerHtml;
        modal.classList.add('sk-modal--open');
        if (wire) wire();
        var first = modalBody.querySelector('input, textarea, select');
        if (first) first.focus();
      }
      function closeModal(){
        modal.classList.remove('sk-modal--open');
        modalBody.innerHTML = '';
        modalFooter.innerHTML = '';
      }
      document.getElementById('tm-modal-close').addEventListener('click', closeModal);
      // Backdrop close, but only when the press also STARTED on the backdrop.
      // Dragging a textarea's resize grip past the modal edge fires the click on
      // the common ancestor (the backdrop), which would otherwise close the modal
      // and discard the edit mid-drag.
      var pressTarget = null;
      modal.addEventListener('pointerdown', function(e){ pressTarget = e.target; });
      modal.addEventListener('click', function(e){
        if (e.target === modal && pressTarget === modal) closeModal();
      });
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape' && modal.classList.contains('sk-modal--open')) closeModal();
      });

      function doneFooter(label){
        return '<span class="tm-modal__footer-spacer"></span>' +
               '<button type="button" class="sk-btn sk-btn--sm" data-m="cancel">Cancel</button>' +
               '<button type="button" class="sk-btn sk-btn--sm sk-btn--primary" data-m="apply">' + (label || 'Apply') + '</button>';
      }
      function wireFooter(apply, after){
        modalFooter.querySelector('[data-m="cancel"]').addEventListener('click', closeModal);
        modalFooter.querySelector('[data-m="apply"]').addEventListener('click', function(){
          if (apply() === false) return;
          markDirty(); render(); closeModal();
          if (after) after();
        });
      }

      // ── Phase modal ───────────────────────────────────────────────────
      function openPhaseModal(i){
        var p = TEAM.phases[i];
        if (!p) return;
        var c = p.consensus || null;
        var reviewerOptions = ['<option value="">— none —</option>'].concat(
          TEAM.agents.map(function(a){
            var val = TEAM.id ? TEAM.id + ':' + a.id : '';
            var sel = (c && c.reviewer_agent_id === val && val) ? ' selected' : '';
            return '<option value="' + esc(val) + '"' + sel + '>' + esc(a.name || a.id) + '</option>';
          })
        ).join('');

        var body =
          '<div class="tm-field__row">' +
            '<div class="tm-field"><label class="sk-label">Phase name</label>' +
              '<input class="sk-input" data-f="name" type="text" value="' + esc(p.name) + '" placeholder="e.g. build"></div>' +
            '<div class="tm-field"><label class="sk-label">Review gate</label>' +
              '<label class="sk-checkbox"><input type="checkbox" data-f="review"' + (p.review ? ' checked' : '') + '>' +
              '<span class="sk-checkbox__toggle"></span>' +
              '<span class="sk-checkbox__label">Pause for human review before advancing</span></label></div>' +
          '</div>' +
          '<div class="tm-field">' +
            '<label class="sk-label">Phase prompt</label>' +
            '<textarea class="sk-textarea tm-field__prompt" data-f="prompt" placeholder="What this phase should accomplish, and what &quot;done&quot; looks like...">' + esc(p.prompt) + '</textarea>' +
            '<p class="tm-field__hint">Given to Skipper when the task enters this phase. Task-level overrides can replace it per task.</p>' +
          '</div>' +
          (EXPERIMENTAL ?
          '<div class="tm-sub">' +
            '<div class="tm-sub__head">' +
              '<label class="sk-checkbox"><input type="checkbox" data-f="consensus_on"' + (c ? ' checked' : '') + '>' +
              '<span class="sk-checkbox__toggle"></span>' +
              '<span class="sk-checkbox__label">Consensus — run this phase with parallel agents</span></label>' +
            '</div>' +
            '<div data-consensus-fields' + (c ? '' : ' hidden') + '>' +
              '<div class="tm-field__row">' +
                '<div class="tm-field"><label class="sk-label">Agents</label>' +
                  '<input class="sk-input" data-f="agent_count" type="number" min="2" max="10" value="' + esc(c ? c.agent_count : 2) + '"></div>' +
                '<div class="tm-field"><label class="sk-label">Strategy</label>' +
                  '<select class="sk-select" data-f="strategy">' +
                    '<option value="best_of"' + (!c || c.strategy === 'best_of' ? ' selected' : '') + '>Best of N</option>' +
                    '<option value="majority"' + (c && c.strategy === 'majority' ? ' selected' : '') + '>Majority</option>' +
                    '<option value="merge"' + (c && c.strategy === 'merge' ? ' selected' : '') + '>Merge</option>' +
                  '</select></div>' +
              '</div>' +
              '<div class="tm-field__row">' +
                '<div class="tm-field"><label class="sk-label">Reviewer</label>' +
                  '<select class="sk-select" data-f="reviewer"' + (TEAM.id ? '' : ' disabled') + '>' + reviewerOptions + '</select>' +
                  (TEAM.id ? '' : '<p class="tm-field__hint">Available once the team is saved.</p>') + '</div>' +
                '<div class="tm-field"><label class="sk-label">Isolation</label>' +
                  '<label class="sk-checkbox"><input type="checkbox" data-f="worktree"' + (c && c.worktree ? ' checked' : '') + '>' +
                  '<span class="sk-checkbox__toggle"></span>' +
                  '<span class="sk-checkbox__label">Each agent in its own git worktree</span></label></div>' +
              '</div>' +
            '</div>' +
          '</div>' : '');

        openModal('Phase <span class="tm-phase__idx">' + String(i + 1).padStart(2, '0') + '</span>', body, doneFooter(), function(){
          if (EXPERIMENTAL) {
            var fields = modalBody.querySelector('[data-consensus-fields]');
            modalBody.querySelector('[data-f="consensus_on"]').addEventListener('change', function(){
              fields.hidden = !this.checked;
            });
          }
          wireFooter(function(){
            var name = modalBody.querySelector('[data-f="name"]').value.trim();
            if (!name) { flashError('A phase needs a name.'); return false; }
            p.name = name;
            p.prompt = modalBody.querySelector('[data-f="prompt"]').value;
            p.review = modalBody.querySelector('[data-f="review"]').checked;
            // Not rendered → the phase keeps whatever consensus config it had.
            if (!EXPERIMENTAL) return;
            if (modalBody.querySelector('[data-f="consensus_on"]').checked) {
              var count = parseInt(modalBody.querySelector('[data-f="agent_count"]').value, 10);
              if (!(count >= 2 && count <= 10)) { flashError('Consensus agent count must be between 2 and 10.'); return false; }
              var reviewer = modalBody.querySelector('[data-f="reviewer"]').value;
              p.consensus = {
                agent_count: count,
                strategy: modalBody.querySelector('[data-f="strategy"]').value,
                worktree: modalBody.querySelector('[data-f="worktree"]').checked
              };
              if (reviewer) p.consensus.reviewer_agent_id = reviewer;
            } else {
              delete p.consensus;
            }
          });
        });
      }

      // ── Agent modal ───────────────────────────────────────────────────
      // Operator-defined tools granted to this agent on this team. This is the
      // only way a CLI agent (claude-code, codex) gets one — a custom agent can
      // also carry its own list, and the session receives the union.
      function customToolsField(grantedList){
        if (!CUSTOM_TOOLS.length) return '';
        var granted = {};
        (grantedList || []).forEach(function(n){ granted[n] = true; });
        var boxes = CUSTOM_TOOLS.map(function(t){
          return '<label class="sk-checkbox" style="align-items:flex-start;">' +
            '<input type="checkbox" data-ct value="' + esc(t.name) + '"' + (granted[t.name] ? ' checked' : '') + '>' +
            '<span class="sk-checkbox__toggle"></span>' +
            '<span class="sk-checkbox__label"><code>' + esc(t.name) + '</code>' +
              (t.description ? '<span class="tm-field__hint" style="display:block;margin:0;">' + esc(t.description) + '</span>' : '') +
            '</span></label>';
        }).join('');
        return '<div class="tm-field"><label class="sk-label">Custom tools</label>' +
          '<p class="tm-field__hint">Tools defined on the Config page. Granted to this agent on this team.</p>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--sk-space-2);">' + boxes + '</div></div>';
      }

      function openAgentModal(agentId){
        var a = TEAM.agents.find(function(x){ return x.id === agentId; });
        if (!a) return;

        // A library reference: only the display name + role are editable. The
        // provider, model, prompt and tools come live from the record, so the
        // editor shows them as owned by the library, not as fields.
        if (isRefType(a.type)) {
          var e = refEntry(a.type);
          var kind = e ? e.kind : refKindOf(a.type);
          var kindLabel = refKindLabel(kind);
          var refName = e ? e.name : 'Missing - this library agent was deleted';
          // Provider is only meaningful for a headless CLI agent; a custom agent
          // runs against its own endpoint, so only its model is shown.
          var detailRow = '';
          if (e && kind === 'single' && e.provider) {
            detailRow += '<div class="tm-field"><label class="sk-label">Provider</label>' +
              '<input class="sk-input" type="text" value="' + esc(e.provider) + '" readonly></div>';
          }
          if (e && e.model) {
            detailRow += '<div class="tm-field"><label class="sk-label">Model</label>' +
              '<input class="sk-input" type="text" value="' + esc(e.model) + '" readonly></div>';
          }
          var refBody =
            '<div class="tm-field__row">' +
              '<div class="tm-field"><label class="sk-label">Name</label>' +
                '<input class="sk-input" data-f="name" type="text" value="' + esc(a.name) + '" placeholder="e.g. Coder"></div>' +
              '<div class="tm-field"><label class="sk-label">Role</label>' +
                '<input class="sk-input" data-f="role" type="text" value="' + esc(a.role || '') + '" placeholder="e.g. worker (optional)"></div>' +
            '</div>' +
            '<div class="tm-field"><label class="sk-label">' + REF_ICON + ' ' + esc(kindLabel) + '</label>' +
              '<div class="sk-input" style="display:flex;align-items:center;justify-content:space-between;gap:var(--sk-space-2);">' +
                '<span>' + esc(refName) + '</span>' +
                (e ? '<a class="sk-btn sk-btn--sm" href="' + refEditHref(e) + '">Edit agent</a>' : '') +
              '</div></div>' +
            (detailRow ? '<div class="tm-field__row">' + detailRow + '</div>' : '') +
            '<p class="tm-field__hint">A live reference. Its provider, model, prompt and tools come from the library ' +
              'record and update here whenever you edit it there.</p>';
          openModal('Agent', refBody, doneFooter(), function(){
            wireFooter(function(){
              var name = modalBody.querySelector('[data-f="name"]').value.trim();
              if (!name) { flashError('An agent needs a name.'); return false; }
              a.name = name;
              var role = modalBody.querySelector('[data-f="role"]').value.trim();
              if (role) a.role = role; else delete a.role;
            });
          });
          return;
        }

        var typeOpts = AGENT_TYPES.map(function(t){
          return '<option value="' + esc(t.name) + '"' + (t.name === a.type ? ' selected' : '') + '>' + esc(t.label || t.name) + '</option>';
        }).join('');

        var body =
          '<div class="tm-field__row">' +
            '<div class="tm-field"><label class="sk-label">Name</label>' +
              '<input class="sk-input" data-f="name" type="text" value="' + esc(a.name) + '" placeholder="e.g. Coder"></div>' +
            '<div class="tm-field"><label class="sk-label">Role</label>' +
              '<input class="sk-input" data-f="role" type="text" value="' + esc(a.role || '') + '" placeholder="e.g. worker (optional)"></div>' +
          '</div>' +
          '<div class="tm-field__row">' +
            '<div class="tm-field"><label class="sk-label">Provider</label>' +
              '<select class="sk-select" data-f="type">' + typeOpts + '</select></div>' +
            '<div class="tm-field"><label class="sk-label">Model</label>' +
              '<input class="sk-input" data-f="model" type="text" value="' + esc(a.model || 'default') + '" placeholder="default" ' +
                'autocomplete="off" spellcheck="false">' +
              '<p class="tm-field__hint">Any model name the provider accepts, e.g. ' +
                '<code>claude-opus-5</code>, <code>claude-sonnet-4-6</code>.</p></div>' +
          '</div>' +
          '<div class="tm-field"><label class="sk-label">Instruction</label>' +
            '<textarea class="sk-textarea tm-field__prompt" data-f="instruction" placeholder="System instruction for this agent...">' + esc(a.instruction || '') + '</textarea></div>' +
          customToolsField(a.customTools);

        openModal('Agent', body, doneFooter(), function(){
          var typeSel = modalBody.querySelector('[data-f="type"]');
          var modelInput = modalBody.querySelector('[data-f="model"]');
          wireFooter(function(){
            var name = modalBody.querySelector('[data-f="name"]').value.trim();
            if (!name) { flashError('An agent needs a name.'); return false; }
            a.name = name;
            a.type = typeSel.value;
            a.model = modelInput.value.trim() || 'default';
            a.instruction = modalBody.querySelector('[data-f="instruction"]').value;
            var role = modalBody.querySelector('[data-f="role"]').value.trim();
            if (role) a.role = role; else delete a.role;
            // Only read the tool checkboxes when the section was rendered; with
            // no tools defined it is absent and must leave the stored list alone.
            if (CUSTOM_TOOLS.length > 0) {
              a.customTools = Array.prototype.filter.call(
                modalBody.querySelectorAll('[data-ct]'), function(b){ return b.checked; }
              ).map(function(b){ return b.value; });
            }
            // Fresh agents still carry the placeholder id — give them one derived
            // from the name. An id the author has already saved stays put.
            if (/^agent(-[0-9]+)?$/.test(a.id)) renameAgentId(a, uniqueAgentId(name, a.id));
          });
        });
      }

      // ── Skipper modal (prompt + custom tools) ─────────────────────────
      function openSkipperModal(){
        var cfg = TEAM.config || {};
        var body =
          '<div class="tm-field"><label class="sk-label">Skipper prompt</label>' +
            '<textarea class="sk-textarea tm-field__prompt" data-f="skipper_prompt" placeholder="Extra context for Skipper, the team lead (optional)...">' + esc(TEAM.skipper_prompt || '') + '</textarea>' +
            '<p class="tm-field__hint">Prepended to every phase Skipper runs for this team.</p></div>' +
          customToolsField(cfg.skipperCustomTools);

        openModal('Skipper', body, doneFooter(), function(){
          wireFooter(function(){
            TEAM.skipper_prompt = modalBody.querySelector('[data-f="skipper_prompt"]').value;
            // Only read the tool checkboxes when the section was rendered; with
            // no tools defined it is absent and must leave the stored list alone.
            if (CUSTOM_TOOLS.length > 0) {
              TEAM.config = TEAM.config || {};
              TEAM.config.skipperCustomTools = Array.prototype.filter.call(
                modalBody.querySelectorAll('[data-ct]'), function(b){ return b.checked; }
              ).map(function(b){ return b.value; });
            }
          });
        });
      }

      // ── Team settings modal (name + mode + realtime + Slack) ──────────
      function openSettingsModal(){
        var cfg = TEAM.config || {};
        var rt = cfg.realtime || {};
        var providerOpts = MODEL_PROVIDERS.map(function(p){
          return '<option value="' + esc(p) + '"' + (rt.summaryProvider === p ? ' selected' : '') + '>' + esc(p) + '</option>';
        }).join('');
        var body =
          '<div class="tm-field"><label class="sk-label">Team name</label>' +
            '<input class="sk-input" data-f="name" type="text" value="' + esc(TEAM.name) + '" placeholder="e.g. Feature Strike Team"></div>' +
          (EXPERIMENTAL ?
          '<div class="tm-sub">' +
            '<div class="tm-field"><label class="sk-label">Team mode</label>' +
              '<select class="sk-select" data-f="team_mode">' +
                '<option value="regular"' + (cfg.mode === 'realtime' ? '' : ' selected') + '>Regular</option>' +
                '<option value="realtime"' + (cfg.mode === 'realtime' ? ' selected' : '') + '>Real-time</option>' +
              '</select>' +
              '<p class="tm-field__hint">Real-time teams back audio/text tasks and need no phases.</p></div>' +
          '</div>' +
          '<div class="tm-sub" id="tm-rt-config"' + (cfg.mode === 'realtime' ? '' : ' style="display:none"') + '>' +
            '<div class="tm-sub__head"><strong class="sk-text-sm">Transcription summary</strong></div>' +
            '<div class="tm-field">' +
              '<label class="sk-checkbox"><input type="checkbox" data-f="rt_summary_enabled"' + (rt.summaryEnabled === false ? '' : ' checked') + '>' +
              '<span class="sk-checkbox__toggle"></span>' +
              '<span class="sk-checkbox__label">Summarize the transcript before feeding the agent</span></label>' +
              '<p class="tm-field__hint">Off feeds the raw cleaned transcript instead.</p>' +
            '</div>' +
            '<div class="sk-model-row">' +
              '<div class="sk-model-row__field"><label class="sk-label">Summary provider</label>' +
                '<select class="sk-select" data-f="rt_summary_provider">' + providerOpts + '</select></div>' +
              '<div class="sk-model-row__field"><label class="sk-label">Summary model</label>' +
                '<input class="sk-input" data-f="rt_summary_model" type="text" value="' + esc(rt.summaryModel || '') + '" placeholder="default"></div>' +
            '</div>' +
          '</div>' +
          '<div class="tm-sub">' +
            '<div class="tm-sub__head"><strong class="sk-text-sm">Slack</strong></div>' +
            '<div class="tm-field">' +
              '<label class="sk-checkbox"><input type="checkbox" data-f="slack_enabled"' + (cfg.slackEnabled ? ' checked' : '') + '>' +
              '<span class="sk-checkbox__toggle"></span>' +
              '<span class="sk-checkbox__label">Expose the Slack tools to this team</span></label>' +
              '<p class="tm-field__hint">Needs a Slack bot token under <a href="/config">Config</a>.</p>' +
            '</div>' +
            '<div class="tm-field"><label class="sk-label">Slash command</label>' +
              '<input class="sk-input" data-f="slash_command" type="text" value="' + esc(cfg.slashCommand || '') + '" placeholder="/software-team">' +
              '<p class="tm-field__hint">Running it in Slack creates and auto-approves a task on this team.</p></div>' +
          '</div>' : '');

        var isCreate = !TEAM.id;
        openModal(isCreate ? 'New team' : 'Team settings', body, doneFooter(isCreate ? 'Create team' : null), function(){
          // Show the realtime summary controls only while mode is realtime.
          var modeSel = modalBody.querySelector('[data-f="team_mode"]');
          var rtBlock = modalBody.querySelector('#tm-rt-config');
          if (modeSel && rtBlock) {
            modeSel.addEventListener('change', function(){
              rtBlock.style.display = modeSel.value === 'realtime' ? '' : 'none';
            });
          }
          wireFooter(function(){
            var name = modalBody.querySelector('[data-f="name"]').value.trim();
            if (!name) { flashError('A team needs a name.'); return false; }
            TEAM.name = name;
            TEAM.config = TEAM.config || {};
            // Not rendered → leave the stored mode/Slack settings untouched.
            if (!EXPERIMENTAL) return;
            TEAM.config.mode = modalBody.querySelector('[data-f="team_mode"]').value === 'realtime' ? 'realtime' : 'regular';
            TEAM.config.realtime = TEAM.config.realtime || {};
            TEAM.config.realtime.summaryEnabled = modalBody.querySelector('[data-f="rt_summary_enabled"]').checked;
            var rtProv = modalBody.querySelector('[data-f="rt_summary_provider"]');
            TEAM.config.realtime.summaryProvider = rtProv ? rtProv.value : '';
            TEAM.config.realtime.summaryModel = modalBody.querySelector('[data-f="rt_summary_model"]').value.trim();
            TEAM.config.slackEnabled = modalBody.querySelector('[data-f="slack_enabled"]').checked;
            var cmd = modalBody.querySelector('[data-f="slash_command"]').value.trim();
            // Send an explicit '' when cleared rather than deleting the key: the
            // save posts the whole config, and the server only clears slashCommand
            // when the key is PRESENT (deleting it makes the server preserve the
            // stored value, so an unset never took effect).
            TEAM.config.slashCommand = cmd || '';
          }, isCreate ? saveTeam : null);
        });
      }

      // ── Save / delete ─────────────────────────────────────────────────
      var errorTimer = null;
      function flashError(msg){
        errEl.textContent = msg;
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = setTimeout(function(){ errEl.textContent = ''; }, 6000);
      }

      var saveBtn = document.getElementById('tm-save');
      async function saveTeam(){
        if (!TEAM.name || !TEAM.name.trim()) { openSettingsModal(); flashError('Name the team before saving.'); return; }
        var isRealtime = TEAM.config && TEAM.config.mode === 'realtime';
        if (!isRealtime && TEAM.phases.length === 0) { flashError('A team needs at least one phase.'); return; }
        var label = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        var payload = {
          name: TEAM.name,
          skipper_prompt: TEAM.skipper_prompt || '',
          hooks: TEAM.hooks || [],
          phases: TEAM.phases,
          agents: TEAM.agents,
          config: TEAM.config || {}
        };
        var url = TEAM.id ? '/api/teams/' + encodeURIComponent(TEAM.id) + '/update' : '/api/teams';
        try {
          var res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          var data = await res.json();
          if (!res.ok) { flashError(data.error || 'Save failed.'); return; }
          dirty = false;
          dirtyEl.hidden = true;
          if (!TEAM.id && data.id) { window.location.href = '/teams/' + encodeURIComponent(data.id); return; }
          saveBtn.textContent = 'Saved';
          setTimeout(function(){ saveBtn.textContent = label; }, 1200);
        } catch (e) {
          flashError('Save failed.');
        } finally {
          saveBtn.disabled = false;
          if (saveBtn.textContent === 'Saving...') saveBtn.textContent = label;
        }
      }
      saveBtn.addEventListener('click', function(){ saveTeam(); });

      var deleteBtn = document.getElementById('tm-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async function(){
          if (!window.confirm('Delete team "' + TEAM.name + '"? This cannot be undone.')) return;
          var res = await fetch('/api/teams/' + encodeURIComponent(TEAM.id), { method: 'DELETE' });
          if (res.ok) { dirty = false; window.location.href = '/teams'; }
          else flashError('Delete failed.');
        });
      }

      document.getElementById('tm-settings').addEventListener('click', function(){ openSettingsModal(); });

      window.addEventListener('beforeunload', function(e){
        if (!dirty) return;
        e.preventDefault();
        e.returnValue = '';
      });

      render();
      if (IS_NEW) openSettingsModal();
    })();
    </script>
  `, "/teams");
}
