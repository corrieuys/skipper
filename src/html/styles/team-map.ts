/**
 * Styles for the experimental Teams pages: the team index grid (`/teams`) and
 * the interactive team map editor (`/teams/:id`).
 *
 * Prefix: tm-  (team map)
 *
 * The map is two stacked diagrams sharing one canvas:
 *   1. the phase flow  — a horizontal track of phase nodes joined by connectors,
 *      where a connector carrying a review gate renders as a diamond
 *   2. the crew line   — Skipper and the team's agents as peer cards in one
 *      wrapping row (flat: there is no reporting hierarchy)
 */
export function teamMapStyles(): string {
  return `
    /* ── Shared page shell ───────────────────────────────────────────── */
    .tm-shell {
      max-width: 1400px;
      margin: 0 auto;
      padding: var(--sk-space-6) var(--sk-space-4) var(--sk-space-12);
    }
    .tm-topbar {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      flex-wrap: wrap;
      margin-bottom: var(--sk-space-6);
    }
    .tm-topbar__back {
      color: var(--sk-text-muted);
      font-size: var(--sk-text-sm);
      white-space: nowrap;
    }
    .tm-topbar__back:hover { color: var(--sk-text); }
    .tm-topbar__heading { flex: 1; min-width: 12rem; }
    .tm-topbar__title {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-2xl);
      margin: 0;
      line-height: 1.2;
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
    }
    .tm-topbar__sub {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      flex-wrap: wrap;
    }
    .tm-topbar__actions {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      flex-wrap: wrap;
    }
    .tm-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--sk-accent-warning);
      box-shadow: 0 0 5px var(--sk-accent-warning);
      flex: none;
    }
    .tm-dot[hidden] { display: none; }

    /* ── Section bands ───────────────────────────────────────────────── */
    .tm-band { margin-bottom: var(--sk-space-8); }
    .tm-band__head {
      display: flex;
      align-items: baseline;
      gap: var(--sk-space-3);
      margin-bottom: var(--sk-space-4);
      flex-wrap: wrap;
    }
    .tm-band__label {
      font-size: var(--sk-text-xs);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--sk-text-subtle);
      font-family: var(--sk-font-mono);
    }
    .tm-band__hint {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
    }
    /* Each band's diagram sits on a board rather than straight on the page. On
       a wallpaper theme the cards are translucent, so without a surface under
       them a bright patch of photo reads through the card and the text goes
       with it. The board is the same panel surface the dashboard panels use. */
    .tm-board {
      background: var(--sk-panel-bg);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-panel-radius);
    }

    /* ── Phase flow track ────────────────────────────────────────────── */
    /* The track scrolls sideways and routinely runs past the viewport. The
       wrapper carries the overflow affordances: a shaded edge marking the cut,
       plus a scroll button — each shown only on the side that has more track
       (is-overflow-left / is-overflow-right, set from scrollLeft in JS). The
       shading is an overlay rather than a fade-to-background because the page
       sits on a wallpaper with no solid colour to fade into. The crew line wraps
       instead of scrolling, so it needs none of this. */
    .tm-flow-wrap { position: relative; }
    .tm-flow-wrap::before,
    .tm-flow-wrap::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      width: 4rem;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      z-index: 1;
    }
    .tm-flow-wrap::before {
      left: 0;
      background: linear-gradient(90deg, rgba(0, 0, 0, 0.6), transparent);
      border-radius: var(--sk-panel-radius) 0 0 var(--sk-panel-radius);
    }
    .tm-flow-wrap::after {
      right: 0;
      background: linear-gradient(270deg, rgba(0, 0, 0, 0.6), transparent);
      border-radius: 0 var(--sk-panel-radius) var(--sk-panel-radius) 0;
    }
    .tm-flow-wrap.is-overflow-left::before { opacity: 1; }
    .tm-flow-wrap.is-overflow-right::after { opacity: 1; }

    .tm-flow-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid var(--sk-border-subtle);
      background: var(--sk-surface-4);
      color: var(--sk-text);
      font-size: 17px;
      line-height: 1;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2;
      padding: 0;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
      transition: background 0.15s, border-color 0.15s;
    }
    .tm-flow-nav:hover { background: var(--sk-accent-primary); color: var(--on-primary); border-color: var(--sk-accent-primary); }
    .tm-flow-nav--left { left: 0.25rem; }
    .tm-flow-nav--right { right: 0.25rem; }
    .tm-flow-wrap.is-overflow-left .tm-flow-nav--left,
    .tm-flow-wrap.is-overflow-right .tm-flow-nav--right { display: flex; }

    .tm-flow {
      display: flex;
      align-items: stretch;
      gap: 0;
      overflow-x: auto;
      padding: var(--sk-space-4) var(--sk-space-4) var(--sk-space-6);
      scrollbar-width: thin;
    }
    .tm-cap {
      align-self: center;
      flex: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--sk-text-subtle);
    }
    .tm-cap__ring {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1px solid var(--sk-border-subtle);
    }
    .tm-cap--start .tm-cap__ring {
      border-color: color-mix(in srgb, var(--sk-accent-secondary) 45%, transparent);
      background: color-mix(in srgb, var(--sk-accent-secondary) 12%, transparent);
    }
    .tm-cap--end .tm-cap__ring {
      border-color: color-mix(in srgb, var(--sk-accent-tertiary) 45%, transparent);
      background: color-mix(in srgb, var(--sk-accent-tertiary) 12%, transparent);
    }

    /* Connector between two nodes. Holds the insert affordance and, when the
       preceding phase has a review gate, the gate diamond. */
    .tm-conn {
      flex: none;
      align-self: center;
      position: relative;
      min-width: 3.75rem;
      height: 4.5rem;
      padding: 0 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
    }
    .tm-conn::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      height: 1px;
      background: linear-gradient(90deg, var(--sk-border-subtle), var(--sk-border-subtle));
    }
    /* Bare rail: joins two nodes with nothing on it (add button → end cap). */
    .tm-conn--plain { min-width: 2.5rem; }
    /* Wide enough for the gate caption ("Add review gate") to sit under the
       diamond without running under the neighbouring phase cards. The insert
       button is pulled out of the flow so the diamond — and therefore its
       caption, which centres on the diamond — sits centred in the connector. */
    .tm-conn--gate { min-width: 8rem; }
    .tm-conn--gate .tm-conn__insert { position: absolute; left: 0.35rem; }
    /* Same visual language as .sk-btn, shrunk to a circular affordance. */
    .tm-conn__insert {
      position: relative;
      z-index: 1;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 1px solid var(--sk-border-subtle);
      background: var(--sk-surface-3);
      color: var(--sk-text-muted);
      font-size: 12px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, background 0.15s, color 0.15s, border-color 0.15s;
    }
    .tm-conn:hover .tm-conn__insert,
    .tm-conn__insert:focus-visible { opacity: 1; }
    .tm-conn__insert:hover {
      background: var(--sk-surface-4);
      color: var(--sk-text);
      border-color: var(--sk-border-active);
    }

    /* Review gate: a rotated square straddling the connector line. The wrapper
       stays unrotated so the caption below it reads horizontally. */
    .tm-gate-wrap {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tm-gate {
      position: relative;
      z-index: 1;
      width: 34px;
      height: 34px;
      border: 1px solid var(--sk-border-subtle);
      background: var(--sk-surface-3);
      transform: rotate(45deg);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, border-color 0.15s, box-shadow 0.2s;
      padding: 0;
    }
    .tm-gate__glyph {
      transform: rotate(-45deg);
      font-size: 13px;
      line-height: 1;
      color: var(--sk-text-muted);
    }
    .tm-gate:hover {
      background: var(--sk-surface-4);
      border-color: var(--sk-border-active);
    }
    .tm-gate:hover .tm-gate__glyph { color: var(--sk-text); }
    .tm-gate--on {
      border-color: color-mix(in srgb, var(--sk-accent-warning) 40%, transparent);
      background: color-mix(in srgb, var(--sk-accent-warning) 10%, transparent);
    }
    .tm-gate--on:hover {
      background: color-mix(in srgb, var(--sk-accent-warning) 16%, transparent);
      border-color: var(--sk-accent-warning);
      box-shadow: 0 0 16px color-mix(in srgb, var(--sk-accent-warning) 10%, transparent);
    }
    .tm-gate--on .tm-gate__glyph,
    .tm-gate--on:hover .tm-gate__glyph { color: var(--sk-accent-warning); }
    .tm-gate__label {
      position: absolute;
      top: calc(100% + 0.5rem);
      left: 50%;
      transform: translateX(-50%);
      font-family: var(--sk-font-mono);
      font-size: 0.6rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--sk-accent-warning);
      white-space: nowrap;
      pointer-events: none;
    }
    /* Off state: same caption slot, muted, so the toggle reads as an affordance
       rather than an unexplained diamond. */
    .tm-gate__label--off { color: var(--sk-text-subtle); }
    .tm-conn:hover .tm-gate__label--off { color: var(--sk-text-muted); }

    /* ── Phase node ──────────────────────────────────────────────────── */
    /* Card surfaces follow the dashboard: panel tokens, a border-colour hover and
       a low-alpha glow — no lift, no saturated accent outline. */
    .tm-phase {
      flex: none;
      width: 15rem;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
      padding: var(--sk-space-3);
      border-radius: var(--sk-panel-radius);
      border: 1px solid var(--sk-border);
      background: var(--sk-surface-3);
      cursor: pointer;
      text-align: left;
      color: inherit;
      font: inherit;
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .tm-phase:hover {
      border-color: var(--sk-border-active);
      box-shadow: 0 0 20px color-mix(in srgb, var(--sk-accent-primary) 7%, transparent);
    }
    .tm-phase__top {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
    }
    .tm-phase__idx {
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
      color: var(--sk-accent-primary);
      background: color-mix(in srgb, var(--sk-accent-primary) 15%, transparent);
      border-radius: var(--sk-radius-sm);
      padding: 0.15em 0.5em;
      flex: none;
    }
    .tm-phase__name {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-base);
      color: var(--sk-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tm-phase__prompt {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      line-height: 1.45;
      min-height: 2.6em;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .tm-phase__prompt--empty { color: var(--sk-text-subtle); font-style: italic; }
    .tm-phase__chips {
      display: flex;
      gap: var(--sk-space-1);
      flex-wrap: wrap;
    }
    /* Same shape as .sk-badge so chips read as first-class status pills. */
    .tm-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.3em;
      font-size: var(--sk-text-xs);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
      padding: 0.15em 0.5em;
      border-radius: var(--sk-radius-sm);
      background: rgba(173, 170, 170, 0.1);
      color: var(--sk-text-muted);
    }
    .tm-chip--review { background: color-mix(in srgb, var(--sk-accent-warning) 15%, transparent); color: var(--sk-accent-warning); }
    .tm-chip--consensus { background: color-mix(in srgb, var(--sk-accent-secondary) 15%, transparent); color: var(--sk-accent-secondary); }
    .tm-chip--slack { background: color-mix(in srgb, var(--sk-accent-tertiary) 15%, transparent); color: var(--sk-accent-tertiary); }

    /* Node tool rail — appears on hover, sits above the card. */
    .tm-tools {
      position: absolute;
      top: -0.65rem;
      right: var(--sk-space-2);
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .tm-phase:hover .tm-tools,
    .tm-agent:hover .tm-tools,
    .tm-tools:focus-within { opacity: 1; }
    .tm-tools__btn {
      width: 22px;
      height: 22px;
      border-radius: var(--sk-btn-radius);
      border: 1px solid var(--sk-border-subtle);
      background: var(--sk-surface-3);
      color: var(--sk-text-muted);
      font-size: 11px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .tm-tools__btn:hover:not(:disabled) {
      background: var(--sk-surface-4);
      color: var(--sk-text);
      border-color: var(--sk-border-active);
    }
    .tm-tools__btn:disabled { opacity: 0.25; cursor: default; }
    .tm-tools__btn--danger { color: var(--sk-accent-danger); }
    .tm-tools__btn--danger:hover:not(:disabled) {
      background: color-mix(in srgb, var(--sk-accent-danger) 10%, transparent);
      color: var(--sk-accent-danger);
      border-color: var(--sk-accent-danger);
    }

    /* ── Crew line ───────────────────────────────────────────────────── */
    /* A flat roster: Skipper first, then the agents, wrapping when the row runs
       out. There is no reporting hierarchy, so no connectors to draw. */
    /* stretch, not flex-start: cards size to their own content otherwise, so a
       Skipper card with a prompt and an agent card without an instruction end up
       different heights in the same row. */
    .tm-tree {
      display: flex;
      flex-wrap: wrap;
      align-items: stretch;
      gap: 1.25rem;
      padding: var(--sk-space-4);
    }

    /* ── Lead (Skipper) node ─────────────────────────────────────────── */
    /* Tinted like .mc-stat-card--secondary: an accent-coloured border at low
       alpha rather than a full-strength outline or gradient fill. */
    .tm-lead {
      width: 14rem;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: var(--sk-space-3);
      border-radius: var(--sk-panel-radius);
      border: 1px solid color-mix(in srgb, var(--sk-accent-secondary) 22%, transparent);
      background: var(--sk-panel-elevated-bg);
      cursor: pointer;
      text-align: left;
      color: inherit;
      font: inherit;
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .tm-lead:hover {
      border-color: color-mix(in srgb, var(--sk-accent-secondary) 40%, transparent);
      box-shadow: 0 0 20px color-mix(in srgb, var(--sk-accent-secondary) 7%, transparent);
    }
    .tm-lead__name { font-family: var(--sk-font-heading); font-size: var(--sk-text-base); color: var(--sk-text); }
    .tm-lead__role {
      font-family: var(--sk-font-mono);
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--sk-accent-secondary);
    }

    /* ── Agent node ──────────────────────────────────────────────────── */
    .tm-agent {
      position: relative;
      width: 14rem;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: var(--sk-space-3);
      border-radius: var(--sk-panel-radius);
      border: 1px solid var(--sk-border);
      background: var(--sk-surface-3);
      cursor: pointer;
      text-align: left;
      color: inherit;
      font: inherit;
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .tm-agent:hover {
      border-color: var(--sk-border-active);
      box-shadow: 0 0 20px color-mix(in srgb, var(--sk-accent-primary) 7%, transparent);
    }
    .tm-agent__name {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-base);
      color: var(--sk-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tm-agent__meta {
      display: flex;
      gap: var(--sk-space-1);
      flex-wrap: wrap;
      font-family: var(--sk-font-mono);
      font-size: 0.6rem;
      color: var(--sk-text-subtle);
    }
    .tm-agent__instr {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* Dashed "add" node, used for both phases and agents. Dashed border marks it
       as a placeholder; the hover treatment is the .sk-btn one. */
    .tm-add {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 3.25rem;
      padding: var(--sk-space-3);
      border-radius: var(--sk-panel-radius);
      border: 1px dashed var(--sk-border-subtle);
      background: var(--sk-panel-bg);
      color: var(--sk-text-muted);
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .tm-add:hover {
      background: var(--sk-panel-elevated-bg);
      color: var(--sk-text);
      border-color: var(--sk-border-active);
    }
    .tm-add--phase { flex: none; width: 11rem; align-self: center; }
    .tm-add--agent { width: 14rem; }

    /* ── Modal (wider body + stacked field rows) ─────────────────────── */
    .tm-modal__content { max-width: 640px; }
    .tm-modal__title {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-lg);
      margin: 0;
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
    }
    .tm-modal__close {
      background: none;
      border: none;
      color: var(--sk-text-muted);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
    }
    .tm-modal__close:hover { color: var(--sk-text); }
    .tm-modal__footer {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      padding: var(--sk-space-3) var(--sk-space-4);
      border-top: 1px solid var(--sk-border);
    }
    .tm-modal__footer-spacer { flex: 1; }
    .tm-field { margin-bottom: var(--sk-space-3); }
    .tm-field__row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--sk-space-3);
    }
    .tm-field__hint {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-subtle);
      margin: var(--sk-space-1) 0 0;
    }
    /* Model names read as one token; let the line break around them, not
       through them. */
    .tm-field__hint code {
      font-family: var(--sk-font-mono);
      white-space: nowrap;
    }
    .tm-field__prompt { min-height: 11rem; font-family: var(--sk-font-mono); font-size: var(--sk-text-sm); line-height: 1.55; }
    .tm-sub {
      border: 1px solid var(--sk-border);
      border-radius: 6px;
      padding: var(--sk-space-3);
      margin-bottom: var(--sk-space-3);
    }
    .tm-sub__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sk-space-2);
      margin-bottom: var(--sk-space-2);
    }
    .tm-error {
      color: var(--sk-accent-danger);
      font-size: var(--sk-text-xs);
      min-height: 1em;
    }

    /* ── Teams index grid ────────────────────────────────────────────── */
    .tm-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
      gap: var(--sk-space-4);
    }
    .tm-card {
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-3);
      padding: var(--sk-space-4);
      border-radius: var(--sk-panel-radius);
      border: 1px solid var(--sk-border);
      background: var(--sk-surface-3);
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .tm-card:hover {
      border-color: var(--sk-border-active);
      box-shadow: 0 0 20px color-mix(in srgb, var(--sk-accent-primary) 7%, transparent);
    }
    .tm-card__link { display: flex; flex-direction: column; gap: var(--sk-space-2); color: inherit; }
    .tm-card__name {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-lg);
      color: var(--sk-text);
    }
    .tm-card__meta {
      display: flex;
      gap: var(--sk-space-2);
      flex-wrap: wrap;
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
      color: var(--sk-text-subtle);
    }
    /* Mini phase strip: the team's flow at a glance. */
    .tm-mini {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .tm-mini__node {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      background: var(--sk-surface-3);
      border-radius: var(--sk-radius-sm);
      padding: 0.15em 0.5em;
      max-width: 8rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tm-mini__arrow { color: var(--sk-text-subtle); font-size: 10px; }
    .tm-mini__gate { color: var(--sk-accent-warning); font-size: 10px; }
    .tm-card__actions {
      display: flex;
      gap: var(--sk-space-2);
      align-items: center;
      margin-top: auto;
      padding-top: var(--sk-space-2);
      border-top: 1px solid var(--sk-border);
    }
    .tm-card--new {
      align-items: center;
      justify-content: center;
      border-style: dashed;
      border-color: var(--sk-border-subtle);
      color: var(--sk-text-muted);
      min-height: 11rem;
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-sm);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .tm-card--new:hover {
      background: var(--sk-panel-elevated-bg);
      color: var(--sk-text);
      border-color: var(--sk-border-active);
      box-shadow: none;
    }
    .tm-empty {
      text-align: center;
      padding: var(--sk-space-12) var(--sk-space-4);
      color: var(--sk-text-muted);
    }

    @media (max-width: 720px) {
      .tm-field__row { grid-template-columns: 1fr; }
      .tm-shell { padding: var(--sk-space-4) var(--sk-space-3) var(--sk-space-8); }
    }
  `;
}
