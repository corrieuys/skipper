/**
 * Command-center styles (`tc-` prefix): team-grouped sidebar, unified task
 * timeline, artifacts/notes rail. Everything derives from the sk- theme tokens
 * so all named themes keep working.
 */
export function teamCenterStyles(): string {
  return `
    /* ── Sidebar: liveness sections (Needs you / Active / Recurring / Teams) ──
       Indentation scale, so carets and text align down the tree:
       level 0 = section heads at 0.75rem (labels land at ~1.75rem);
       level 1 = rows + team/series heads at 1.75rem (their carets under the labels);
       level 2 = tasks/runs inside a group at 3rem. */
    .tc-side { padding: 0.4rem 0 0.7rem; }
    .tc-sec > summary { list-style: none; }
    .tc-sec > summary::-webkit-details-marker { display: none; }
    .tc-sec__head {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.5rem 0.9rem 0.3rem 0.75rem; cursor: pointer;
    }
    .tc-sec__label {
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      font-weight: 600; color: var(--sk-text-subtle);
    }
    .tc-sec__head:hover .tc-sec__label { color: var(--sk-text-muted); }
    .tc-sec[open] > summary .tc-team__caret { transform: rotate(90deg); }
    .tc-sec__count {
      font-family: var(--sk-font-mono); font-size: 10px;
      color: var(--sk-text-subtle);
    }
    .tc-sec__body { padding-bottom: 0.5rem; }
    .tc-sec[open] { margin-bottom: 0.35rem; }
    /* Level-1 plain rows (Needs you / Active) line up with the section labels. */
    .tc-attn .mc-sidebar__item,
    .tc-sec__body > .mc-sidebar__item { padding-left: 1.75rem; }
    .tc-sec__body > .tc-team__empty { padding-left: 1.75rem; }

    .tc-attn { padding-bottom: 0.5rem; }
    .tc-attn__label { display: block; padding: 0.5rem 0.9rem 0.3rem 1.75rem; color: var(--sk-accent-warning); }

    /* Recurring series: run strip + expandable recent runs */
    .tc-runstrip { display: inline-flex; gap: 2px; flex: none; align-items: center; }
    .tc-runsq {
      width: 7px; height: 7px; border-radius: 2px;
      background: var(--sk-surface-4);
    }
    .tc-runsq--completed { background: var(--sk-accent-tertiary); }
    .tc-runsq--failed { background: var(--sk-accent-danger); }
    .tc-runsq--running { background: var(--sk-accent-primary); }
    .tc-runsq--approved, .tc-runsq--paused { background: var(--sk-accent-warning); }
    .tc-rec__badge {
      flex: none; font-family: var(--sk-font-mono); font-size: 9px;
      color: var(--sk-text-subtle);
    }
    .tc-rec__all {
      display: block; padding: 0.25rem 0.9rem 0.25rem 3rem;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle); text-decoration: none;
    }
    .tc-rec__all:hover { color: var(--sk-text); }

    .tc-history {
      display: block; padding: 0.55rem 0.9rem 0.55rem 1.75rem;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle); text-decoration: none;
    }
    .tc-history:hover { color: var(--sk-text); }

    /* ── Sidebar: expandable team groups ── */
    details.tc-team > summary { list-style: none; }
    details.tc-team > summary::-webkit-details-marker { display: none; }
    .tc-team__head {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.35rem 0.9rem 0.35rem 1.75rem; cursor: pointer;
      color: var(--sk-text-muted); font-size: var(--sk-text-sm);
      border-radius: var(--sk-radius-sm);
    }
    .tc-team__head:hover { background: var(--sk-surface-2); color: var(--sk-text); }
    .tc-team__caret {
      flex: none; font-size: 8px; color: var(--sk-text-subtle);
      transition: transform 0.12s ease;
    }
    details.tc-team[open] .tc-team__caret { transform: rotate(90deg); }
    .tc-team__dot {
      width: 7px; height: 7px; border-radius: 50%; flex: none;
      background: var(--sk-surface-4);
    }
    .tc-team__dot--running {
      background: var(--sk-accent-primary);
      box-shadow: 0 0 6px var(--sk-accent-primary-dim);
    }
    .tc-team__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .tc-team--active .tc-team__name { color: var(--sk-text); }
    .tc-team__count {
      font-family: var(--sk-font-mono); font-size: 10px; font-weight: 600;
      color: var(--sk-accent-primary); background: var(--sk-accent-primary-dim);
      border-radius: 9px; padding: 1px 7px; flex: none;
    }
    /* Quick-create "+", revealed on row hover (matches the stylesheet's
       hover-reveal idiom). Opens the create form pre-selected for this team. */
    .tc-team__add {
      flex: none; opacity: 0; text-decoration: none;
      width: 18px; height: 18px; line-height: 16px; text-align: center;
      border-radius: var(--sk-radius-sm); color: var(--sk-text-subtle);
      font-size: 15px; font-weight: 600;
    }
    .tc-team__head:hover .tc-team__add { opacity: 1; }
    .tc-team__add:hover { color: var(--sk-accent-primary); background: var(--sk-surface-3); }
    /* Shimmer placeholder shown in a sidebar row while the daemon generates the
       task title. Replaced by the real title on the next task:state_changed push. */
    .tc-title-skel { flex: 1; min-width: 0; display: flex; align-items: center; }
    .tc-title-skel__bar {
      display: block; height: 0.72em; width: 68%; border-radius: 4px;
      background: linear-gradient(90deg,
        var(--sk-surface-3) 25%, var(--sk-surface-4) 37%, var(--sk-surface-3) 63%);
      background-size: 200% 100%;
      animation: tc-title-shimmer 1.2s ease-in-out infinite;
    }
    @keyframes tc-title-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .tc-title-skel__bar { animation: none; }
    }
    .tc-team__tasks { padding: 0 0 0.3rem; }
    .tc-team__tasks .mc-sidebar__item { padding-left: 3rem; }
    .tc-team__empty {
      padding: 0.2rem 0.9rem 0.2rem 3rem;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle);
    }
    /* Denser rows in the v2 sidebar; classic dock keeps its own spacing. */
    .tc-side .mc-sidebar__item { padding-top: 5px; padding-bottom: 5px; }

    /* ── Task view: header spans full width, then timeline + rail ── */
    .tc-work { display: flex; flex: 1; min-height: 0; }

    .tc-timeline-col {
      flex: 1; min-width: 0; display: flex; flex-direction: column;
      background: var(--sk-surface-1);
    }
    .tc-timeline {
      flex: 1; overflow-y: auto; padding: var(--sk-space-4) var(--sk-space-6) var(--sk-space-8);
      scrollbar-width: thin;
    }
    .tc-timeline__inner { width: 100%; }
    .tc-empty { color: var(--sk-text-subtle); padding: var(--sk-space-4); }

    /* Timeline entries */
    .tc-entry { margin-bottom: 0.65rem; }
    .tc-av {
      flex: none; width: 20px; height: 20px; border-radius: var(--sk-radius-sm);
      display: flex; align-items: center; justify-content: center;
      font-family: var(--sk-font-mono); font-size: 9px; font-weight: 700;
      color: var(--sk-surface-0);
    }
    .tc-av--0 { background: var(--sk-accent-secondary); }
    .tc-av--1 { background: var(--sk-accent-primary); }
    .tc-av--2 { background: var(--sk-accent-tertiary); }
    .tc-av--3 { background: var(--sk-accent-warning); }
    .tc-who--0 { color: var(--sk-accent-secondary); }
    .tc-who--1 { color: var(--sk-accent-primary); }
    .tc-who--2 { color: var(--sk-accent-tertiary); }
    .tc-who--3 { color: var(--sk-accent-warning); }
    .tc-entry__meta {
      display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem;
    }
    .tc-entry__who { font-size: var(--sk-text-sm); font-weight: 650; }
    .tc-entry__kind {
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--sk-text-subtle);
    }
    .tc-entry__time { margin-left: auto; font-size: var(--sk-text-xs); color: var(--sk-text-subtle); }
    .tc-entry__card {
      background: var(--sk-surface-2); border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-lg); padding: 0.65rem 0.9rem;
      font-size: var(--sk-text-base); color: var(--sk-text);
      overflow-wrap: break-word; cursor: pointer;
    }
    .tc-entry__card:hover { border-color: var(--sk-border-subtle); }

    /* Agent prose: quiet uncolored entry, sits with the tool groups.
       Name, time and text run inline and wrap as one block. */
    .tc-prose {
      margin: 0 0 0.6rem 0; cursor: pointer;
      font-size: var(--sk-text-sm); color: var(--sk-text-muted);
      overflow-wrap: break-word; line-height: 1.55;
    }
    .tc-prose__who {
      font-family: var(--sk-font-mono); font-size: var(--sk-text-xs);
      font-weight: 600; color: var(--sk-text-subtle); margin-right: 0.35rem;
    }
    .tc-prose__time { font-size: var(--sk-text-xs); color: var(--sk-text-subtle); margin-right: 0.55rem; }
    .tc-prose:hover .tc-prose__body { color: var(--sk-text); }

    /* Collapsed tool/system groups */
    .tc-sys { margin: 0 0 0.6rem 0; }
    .tc-sys > summary {
      list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 0.45rem;
      font-family: var(--sk-font-mono); font-size: var(--sk-text-xs); color: var(--sk-text-subtle);
      padding: 0.1rem 0;
    }
    .tc-sys > summary::-webkit-details-marker { display: none; }
    .tc-sys > summary::before { content: "\\25B8"; font-size: 8px; }
    .tc-sys[open] > summary::before { content: "\\25BE"; }
    .tc-sys > summary:hover { color: var(--sk-text-muted); }
    .tc-sys__rows {
      margin-top: 0.35rem; padding: 0.45rem 0.75rem;
      background: var(--sk-surface-1); border-radius: var(--sk-radius-md);
      font-family: var(--sk-font-mono); font-size: var(--sk-text-xs);
      color: var(--sk-text-muted); line-height: 1.9;
    }
    .tc-sys__row { display: flex; gap: 0.7rem; cursor: pointer; min-width: 0; }
    .tc-sys__row:hover .tc-sys__text { color: var(--sk-text); }
    .tc-sys__row--overflow { color: var(--sk-text-subtle); cursor: default; }
    .tc-sys__time { flex: none; color: var(--sk-text-subtle); }
    .tc-sys__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Resolved escalations: one quiet line, expandable */
    .tc-esc-done { margin: 0 0 0.6rem 0; }
    .tc-esc-done > summary {
      list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 0.55rem;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle); padding: 0.1rem 0;
    }
    .tc-esc-done > summary::-webkit-details-marker { display: none; }
    .tc-esc-done > summary:hover { color: var(--sk-text-muted); }
    .tc-esc-done__tick { color: var(--sk-accent-tertiary); }
    .tc-esc-done__label { font-weight: 600; color: var(--sk-text-muted); }
    .tc-esc-done > summary:hover .tc-esc-done__label { color: var(--sk-text); }
    .tc-esc-done__time { margin-left: auto; }
    .tc-esc-done__body {
      margin-top: 0.4rem; padding: 0.7rem 0.9rem;
      background: var(--sk-surface-1); border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-md); font-size: var(--sk-text-sm); color: var(--sk-text);
    }
    .tc-esc-done__q { margin-bottom: 0.6rem; }
    .tc-esc-done__r {
      background: var(--sk-surface-0); border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-sm); padding: 0.5rem 0.7rem;
    }
    .tc-esc-done__rlbl {
      display: block; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--sk-text-subtle); margin-bottom: 0.2rem;
    }

    /* Escalation cards inline in the timeline: same card language as the message
       entries (surface-2, rounded, plain full border) so it sits in the flow
       instead of the heavy classic-panel chrome (sharp corners, header divider,
       accent gradient) that clashed. It reads as "needs you" through the "!" bang
       and OPEN badge in its header, not through any border accent. */
    .tc-escwrap { margin: 0 0 0.65rem 0; }
    .tc-escwrap .sk-panel {
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-lg);
      background: var(--sk-surface-2);
    }
    .tc-escwrap .sk-panel__header {
      border-bottom: none; min-height: 0;
      padding: 0.55rem 0.85rem 0.1rem;
    }
    .tc-escwrap .sk-panel__body { padding: 0.35rem 0.85rem 0.7rem; }
    .tc-escwrap .esc-previous { display: contents; }
    .tc-escwrap .esc-previous > summary { display: none; }

    /* ── Draggable divider between timeline and rail ── */
    .tc-divider {
      flex: none; width: 6px; cursor: col-resize; position: relative;
      background: transparent;
    }
    .tc-divider::after {
      content: ""; position: absolute; inset: 0 2px;
      background: var(--sk-border);
    }
    .tc-divider:hover::after, .tc-divider.tc-divider--drag::after {
      background: var(--sk-accent-primary-dim);
    }
    body.tc-resizing { cursor: col-resize; user-select: none; }

    /* ── Right rail: artifacts / notes tabs ── */
    .tc-rail {
      width: 50%; min-width: 280px; max-width: 72%;
      flex: none; display: flex; flex-direction: column;
      background: var(--sk-surface-1);
      min-height: 0;
    }
    .tc-rail input.tc-rt { display: none; }
    .tc-rail__tabs {
      display: flex; gap: 1.2rem; padding: 0.8rem 1rem 0;
      border-bottom: 1px solid var(--sk-border); flex: none;
    }
    .tc-rail__tabs label {
      font-size: var(--sk-text-sm); color: var(--sk-text-subtle); cursor: pointer;
      padding-bottom: 0.55rem;
    }
    .tc-rail__tabs label:hover { color: var(--sk-text-muted); }
    .tc-rt-arts:checked ~ .tc-rail__tabs .tc-tab--arts,
    .tc-rt-notes:checked ~ .tc-rail__tabs .tc-tab--notes,
    .tc-rt-activity:checked ~ .tc-rail__tabs .tc-tab--activity {
      color: var(--sk-text); font-weight: 600;
    }
    .tc-rail__pane { display: none; overflow-y: auto; padding: 0.8rem 0.8rem 1.2rem; min-height: 0; flex: 1; }
    .tc-rt-arts:checked ~ .tc-rail__pane--arts { display: block; }
    .tc-rt-notes:checked ~ .tc-rail__pane--notes { display: block; }
    .tc-rt-activity:checked ~ .tc-rail__pane--activity { display: flex; flex-direction: column; }
    .tc-rail__pane--activity .mc-activity__controls { flex: none; }
    .tc-rail__pane--activity .mc-activity__feed { flex: 1; min-height: 0; overflow-y: auto; }
    .tc-rail__more {
      flex: none; border-top: 1px solid var(--sk-border);
      padding: 0.6rem 1rem 0.8rem;
    }
    .tc-rail__more a {
      display: block; font-size: var(--sk-text-xs); color: var(--sk-text-subtle);
      text-decoration: none; padding: 0.22rem 0; cursor: pointer;
    }
    .tc-rail__more a:hover { color: var(--sk-text-muted); }

    /* Artifact list w/ version sub-lists */
    .tc-art {
      background: var(--sk-surface-2); border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-md); padding: 0.55rem 0.7rem; margin-bottom: 0.5rem;
    }
    .tc-art--deleted { opacity: 0.55; }
    .tc-art__main { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
    .tc-art__name {
      font-family: var(--sk-font-mono); font-size: var(--sk-text-sm); font-weight: 600;
      color: var(--sk-text); text-decoration: none; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; min-width: 0;
    }
    .tc-art__name:hover { text-decoration: underline; text-underline-offset: 3px; }
    .tc-art__badge {
      font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--sk-text-subtle); border: 1px solid var(--sk-border-subtle);
      border-radius: 9px; padding: 0 5px; flex: none;
    }
    .tc-art__badge--deleted { color: var(--sk-accent-danger); border-color: currentColor; }
    .tc-art__action {
      margin-left: auto; flex: none; background: none; border: none; cursor: pointer;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle); padding: 0;
    }
    .tc-art__action:hover { color: var(--sk-text); }
    .tc-art__meta { font-size: var(--sk-text-xs); color: var(--sk-text-subtle); margin-top: 0.15rem; }
    .tc-art__versions { margin-top: 0.3rem; }
    .tc-art__versions > summary {
      list-style: none; cursor: pointer; font-size: var(--sk-text-xs); color: var(--sk-text-subtle);
    }
    .tc-art__versions > summary::-webkit-details-marker { display: none; }
    .tc-art__versions > summary::before { content: "\\25B8 "; font-size: 8px; }
    .tc-art__versions[open] > summary::before { content: "\\25BE "; }
    .tc-art__versions > summary:hover { color: var(--sk-text-muted); }
    .tc-art__verlist { margin-top: 0.25rem; border-left: 1px solid var(--sk-border-subtle); padding-left: 0.6rem; }
    .tc-art__ver {
      display: flex; align-items: baseline; gap: 0.6rem; padding: 0.14rem 0;
      font-family: var(--sk-font-mono); font-size: var(--sk-text-xs);
      color: var(--sk-text-muted); text-decoration: none;
    }
    .tc-art__ver:hover { color: var(--sk-text); }
    .tc-art__ver-n { flex: none; }
    .tc-art__ver-time { color: var(--sk-text-subtle); }
    .tc-art__ver-tag {
      margin-left: auto; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--sk-accent-primary);
    }

    /* Fullscreen artifact overlay (reuses #sk-artifact-detail-window ids) */
    .tc-artifact-overlay {
      position: fixed; inset: 0; z-index: var(--sk-z-modal);
      background: color-mix(in srgb, var(--sk-surface-0) 92%, transparent);
      backdrop-filter: blur(6px);
      display: flex; flex-direction: column;
    }
    .tc-artifact-overlay[hidden] { display: none; }
    .tc-artifact-overlay .artifact-inset__bar {
      display: flex; align-items: center; gap: 0.8rem;
      padding: 0.8rem 1.4rem; border-bottom: 1px solid var(--sk-border-subtle); flex: none;
    }
    .tc-artifact-overlay .artifact-inset__bar-title {
      font-size: var(--sk-text-sm); letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--sk-text-subtle);
    }
    .tc-artifact-overlay .artifact-inset__close {
      margin-left: auto; background: var(--sk-surface-3); border: 1px solid var(--sk-border-subtle);
      color: var(--sk-text); width: 30px; height: 30px; border-radius: var(--sk-radius-md);
      cursor: pointer; font-size: 15px; line-height: 1;
    }
    .tc-artifact-overlay .artifact-inset__body {
      flex: 1; overflow-y: auto; padding: 1.4rem;
    }
    .tc-artifact-overlay .artifact-inset__body > div { max-width: 52rem; margin: 0 auto; }

    @media (max-width: 900px) {
      .tc-work { flex-direction: column; }
      .tc-divider { display: none; }
      .tc-rail { width: 100% !important; min-width: 0; max-width: none; border-top: 1px solid var(--sk-border); max-height: 40vh; }
    }
  `;
}
