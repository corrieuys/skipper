/**
 * Command-center styles (`tc-` prefix): team-grouped sidebar, unified task
 * timeline, artifacts/notes rail. Everything derives from the sk- theme tokens
 * so all named themes keep working.
 */
export function teamCenterStyles(): string {
  return `
    /* ── Sidebar: tabbed boards (Latest / Teams / Agents) ──
       One indentation scale across every board, so carets and text align:
       level 0 = section heads AND top-level team/series heads at 0.75rem;
       level 1 = their rows (Active/Recent items, team tasks, series runs) at 1.75rem. */
    .tc-side { padding: 0.4rem 0 0.7rem; }

    /* ── Board tabs (segmented): Latest / Teams / Agents ──
       Mirrors the iOS segmented picker. Only one .tc-board panel shows at a
       time; the active tab is a client toggle (data-tc-board / skipper.js). */
    .tc-tabs {
      display: flex; gap: 2px;
      margin: 0.15rem 0.4rem 0.55rem;
      padding: 2px;
      background: var(--sk-surface-2);
      border-radius: var(--sk-radius-sm);
    }
    .tc-tab {
      flex: 1; min-width: 0;
      display: flex; align-items: center; justify-content: center; gap: 3px;
      padding: 4px 1px;
      background: none; border: none; cursor: pointer;
      border-radius: calc(var(--sk-radius-sm) - 1px);
      color: var(--sk-text-subtle);
      font-size: 9.5px; letter-spacing: 0.01em; font-weight: 600;
      transition: background 0.12s, color 0.12s;
    }
    .tc-tab:hover { color: var(--sk-text-muted); }
    .tc-tab--active {
      background: var(--sk-surface-0);
      color: var(--sk-text);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
    }
    .tc-tab__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tc-tab__count {
      font-family: var(--sk-font-mono); font-size: 9px; flex-shrink: 0;
      color: var(--sk-text-subtle);
    }
    .tc-tab--active .tc-tab__count { color: var(--sk-text-muted); }
    .tc-board[hidden] { display: none; }
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
      display: block; padding: 0.25rem 0.9rem 0.25rem 1.75rem;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle); text-decoration: none;
    }
    .tc-rec__all:hover { color: var(--sk-text); }

    .tc-history {
      display: block; padding: 0.55rem 0.9rem 0.55rem 1.75rem;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle); text-decoration: none;
    }
    .tc-history:hover { color: var(--sk-text); }

    /* ── Task header: quiet autopilot pill ──
       Reflects task.mode (workflow = on); clicking flips it via
       POST /api/tasks/:id/autopilot. */
    .tc-autopilot {
      display: inline-flex; align-items: center; gap: 5px;
      height: var(--sk-btn-height-sm, 24px); padding: 0 9px;
      border: 1px solid var(--sk-border); border-radius: 999px;
      background: transparent; cursor: pointer;
      font-size: var(--sk-text-xs); font-weight: 500;
      color: var(--sk-text-subtle);
    }
    .tc-autopilot:hover { color: var(--sk-text-muted); border-color: var(--sk-border-strong, var(--sk-border)); }
    .tc-autopilot__dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--sk-surface-4); flex: none;
    }
    .tc-autopilot--on { color: var(--sk-text-muted); }
    .tc-autopilot--on .tc-autopilot__dot { background: var(--sk-accent-tertiary); }

    /* ── Sidebar: expandable team groups ── */
    details.tc-team > summary { list-style: none; }
    details.tc-team > summary::-webkit-details-marker { display: none; }
    /* Team/recurring groups are top-level within their board (no enclosing
       section head), so they align to the Latest board's section-head column
       (0.75rem), with their rows one level in at 1.75rem. */
    .tc-team__head {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.35rem 0.9rem 0.35rem 0.75rem; cursor: pointer;
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
    .tc-team__tasks .mc-sidebar__item { padding-left: 1.75rem; }
    .tc-team__empty {
      padding: 0.2rem 0.9rem 0.2rem 1.75rem;
      font-size: var(--sk-text-xs); color: var(--sk-text-subtle);
    }
    /* Denser rows in the v2 sidebar; classic dock keeps its own spacing. */
    .tc-side .mc-sidebar__item { padding-top: 5px; padding-bottom: 5px; }

    /* ── Task view: header spans full width, then timeline + rail ── */
    .tc-work { display: flex; flex: 1; min-height: 0; position: relative; }

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

    /* Operator input entries (typed text / audio transcripts) */
    .tc-av--you { background: var(--sk-surface-4); color: var(--sk-text); }
    .tc-entry--input .tc-entry__card { background: var(--sk-surface-2); }
    .tc-input__pending {
      font-size: 0.68rem; color: var(--sk-accent-warning);
      border: 1px solid var(--sk-accent-warning); border-radius: 999px;
      padding: 0 6px;
    }
    .tc-input--error {
      display: flex; align-items: baseline; gap: 0.5rem;
      color: var(--sk-accent-danger); font-size: 0.8rem;
      padding: 0.3rem 0.6rem;
    }
    .tc-input--error .tc-input__time { color: var(--sk-text-subtle); }

    /* Transient live-agents indicator: always the last timeline item */
    .tc-live {
      display: flex; align-items: center; flex-wrap: wrap; gap: 0.6rem;
      padding: 0.45rem 0.6rem; margin-top: 0.4rem;
      color: var(--sk-text-subtle); font-size: 0.82rem;
    }
    .tc-live__agent { display: inline-flex; align-items: center; gap: 0.35rem; }
    .tc-live__av { width: 18px; height: 18px; font-size: 0.55rem; }
    .tc-live__who { font-weight: 600; }
    .tc-live__verb { color: var(--sk-text-subtle); }
    .tc-live__dots { display: inline-flex; gap: 3px; margin-left: 0.1rem; }
    .tc-live__dots i {
      width: 4px; height: 4px; border-radius: 50%;
      background: var(--sk-text-subtle); opacity: 0.4;
      animation: tc-live-pulse 1.2s infinite ease-in-out;
    }
    .tc-live__dots i:nth-child(2) { animation-delay: 0.2s; }
    .tc-live__dots i:nth-child(3) { animation-delay: 0.4s; }
    @keyframes tc-live-pulse {
      0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
      40% { opacity: 1; transform: translateY(-2px); }
    }

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
      position: relative; margin: 0 0 0.6rem 0; cursor: pointer;
      font-size: var(--sk-text-sm); color: var(--sk-text-muted);
      overflow-wrap: break-word; line-height: 1.55;
    }
    /* A leaf dot in the gutter marks a message; tool groups use the expand caret
       instead. Sits on the first line, left of the name (which stays column-aligned
       with the tool-group name). */
    .tc-prose::before {
      content: "\\2022"; position: absolute; left: -0.82rem; top: 0.78em;
      transform: translateY(-50%); font-size: 9px; color: var(--sk-text-subtle);
    }
    .tc-prose__who {
      font-family: var(--sk-font-mono); font-size: var(--sk-text-xs);
      font-weight: 600; color: var(--sk-text-subtle); margin-right: 0.35rem;
    }
    .tc-prose__time { font-size: var(--sk-text-xs); color: var(--sk-text-subtle); margin-right: 0.55rem; }
    .tc-prose:hover .tc-prose__body { color: var(--sk-text); }

    /* Collapsed tool/system groups */
    .tc-sys { margin: 0 0 0.6rem 0; }
    /* The name lines up with the prose rows' name (same left column); the
       disclosure caret hangs in the left gutter so it never shifts the name. */
    .tc-sys > summary {
      list-style: none; cursor: pointer; position: relative;
      display: inline-flex; align-items: center; gap: 0.4rem;
      font-family: var(--sk-font-mono); font-size: var(--sk-text-xs); color: var(--sk-text-subtle);
      padding: 0.1rem 0;
    }
    .tc-sys > summary::-webkit-details-marker { display: none; }
    .tc-sys > summary::before {
      content: "\\25B8"; font-size: 8px;
      position: absolute; left: -0.85rem; top: 50%; transform: translateY(-50%);
    }
    .tc-sys[open] > summary::before { content: "\\25BE"; }
    .tc-sys > summary:hover { color: var(--sk-text-muted); }
    .tc-sys__who { font-weight: 600; }
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
    /* An open escalation is a compact banner. It stays visible while its natural
       position is off screen by sticking to whichever edge (top OR bottom) it is
       being pushed past. Reads as "needs you" through the "!" bang, not a border
       accent stripe. Clicking opens the full card in a modal. */
    .tc-esc-banner-wrap {
      position: sticky; top: 0.35rem; bottom: 0.35rem; z-index: 6;
      margin: 0 0 0.65rem 0;
    }
    .tc-esc-banner {
      display: flex; align-items: center; gap: 0.5rem; width: 100%;
      padding: 0.5rem 0.8rem; text-align: left; cursor: pointer;
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-lg);
      background: var(--sk-surface-2);
      box-shadow: var(--sk-shadow-1, 0 2px 8px rgba(0,0,0,0.18));
      font: inherit; color: var(--sk-text);
    }
    /* Pin colors on hover: a global button:hover sets color:var(--on-primary),
       which reads dark-on-dark here. Keep the banner's own theme text color. */
    .tc-esc-banner:hover { background: var(--sk-surface-3, var(--sk-surface-2)); border-color: var(--sk-border-strong, var(--sk-border)); color: var(--sk-text); box-shadow: none; }
    .tc-esc-banner:hover .tc-esc-banner__who { color: var(--sk-text); }
    .tc-esc-banner:hover .tc-esc-banner__msg { color: var(--sk-text-muted); }
    .tc-esc-banner:hover .tc-esc-banner__time { color: var(--sk-text-subtle); }
    .tc-esc-banner__bang {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 1.15rem; height: 1.15rem; border-radius: 50%;
      background: var(--sk-accent-danger); color: #fff;
      font-weight: 700; font-size: 0.8rem; line-height: 1;
    }
    .tc-esc-banner__who { font-weight: 600; }
    .tc-esc-banner__msg { color: var(--sk-text-muted); }
    .tc-esc-banner__time { margin-left: auto; font-size: var(--sk-text-xs); color: var(--sk-text-subtle); }
    /* Reclaim vertical space so the whole escalation fits without scrolling: thin
       outer padding on the overlay, modal near full-height, a small fixed response
       box, tight inner padding. No flex, no inner scrollbox. Only genuinely huge
       copy makes the whole modal scroll as one surface (max-height cap). */
    #mc-esc-modal { padding: var(--sk-space-3); }
    #mc-esc-modal .sk-modal__content { max-width: 1100px; width: 94vw; max-height: 96vh; }
    #mc-esc-modal .sk-modal__body { padding: 0; }
    #mc-esc-modal .sk-panel__body { padding-top: var(--sk-space-2); padding-bottom: var(--sk-space-2); }
    /* The classic escalations panel caps the question body at 22em with its own
       scrollbar (baseStyles). In the modal the question must flow — the modal is
       the single scroll surface — so lift that cap. THIS was the inner scroll. */
    #mc-esc-modal .esc-q__body { max-height: none; overflow: visible; }
    #mc-esc-modal .sk-textarea { height: 4rem; min-height: 4rem; resize: vertical; }
    #mc-esc-modal .sk-panel { border: none; background: transparent; margin: 0; }

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
    /* Operator uploads on the timeline (image / file cards) */
    .tc-upload { padding: 0.45rem 0.55rem; }
    .tc-upload__img-link { display: inline-block; max-width: 100%; }
    .tc-upload__img {
      display: block; max-height: 320px; max-width: 100%; width: auto; height: auto;
      border-radius: var(--sk-radius-sm); border: 1px solid var(--sk-border-subtle);
      background: var(--sk-surface-1);
    }
    .tc-upload__caption { margin-top: 0.4rem; font-size: var(--sk-text-sm); color: var(--sk-text-muted); white-space: pre-wrap; }
    .tc-upload__file { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
    .tc-upload__icon { flex: none; }
    .tc-upload__name { font-family: var(--sk-font-mono); font-size: var(--sk-text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .tc-upload__size { flex: none; font-size: var(--sk-text-xs); color: var(--sk-text-subtle); }
    .tc-upload__dl { flex: none; margin-left: auto; font-size: var(--sk-text-xs); color: var(--sk-accent-primary); text-decoration: none; }
    .tc-upload__dl:hover { text-decoration: underline; }

    /* Add artifact (upload) form at the top of the artifacts rail */
    .tc-art-upload {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;
      padding: 0.5rem 0.6rem; margin-bottom: 0.6rem;
      border: 1px dashed var(--sk-border); border-radius: var(--sk-radius-md);
      background: color-mix(in srgb, var(--sk-surface-2) 60%, transparent);
    }
    .tc-art-upload--drop { border-color: var(--sk-accent-primary); background: color-mix(in srgb, var(--sk-accent-primary) 10%, transparent); }
    .tc-art-upload__pick { display: inline-flex; align-items: center; gap: 0.4rem; min-width: 0; cursor: pointer; font-size: var(--sk-text-xs); }
    .tc-art-upload__file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
    .tc-art-upload__pick-label {
      border: 1px solid var(--sk-border); border-radius: var(--sk-radius-sm);
      padding: 0.2rem 0.55rem; color: var(--sk-text-muted); white-space: nowrap;
    }
    .tc-art-upload__pick:hover .tc-art-upload__pick-label { color: var(--sk-text); border-color: var(--sk-border-strong, var(--sk-border)); }
    .tc-art-upload__picked { color: var(--sk-text-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 12rem; }
    .tc-art-upload__desc {
      flex: 1 1 10rem; min-width: 0; font-size: var(--sk-text-xs); padding: 0.25rem 0.45rem;
      border: 1px solid var(--sk-border-subtle); border-radius: var(--sk-radius-sm);
      background: color-mix(in srgb, var(--sk-surface-0) 28%, transparent); color: var(--sk-text); outline: none;
    }
    .tc-art-upload__btn { flex: none; font-size: var(--sk-text-xs); padding: 0.25rem 0.7rem; }
    .tc-art-upload__status { flex: 1 0 100%; font-size: var(--sk-text-xs); color: var(--sk-text-subtle); }
    .tc-art-upload__status--error, .tc-art-upload__error { color: var(--sk-accent-danger); font-size: var(--sk-text-xs); }
    .tc-art-upload[data-busy] { opacity: 0.7; pointer-events: none; }
    .tc-work.tc-work--drop::after {
      content: "Drop to attach"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: var(--sk-text-lg); color: var(--sk-accent-primary); pointer-events: none;
      background: color-mix(in srgb, var(--sk-accent-primary) 8%, transparent);
      border: 2px dashed var(--sk-accent-primary); border-radius: var(--sk-radius-md); z-index: 5;
    }

    .tc-art__icon { flex: none; font-size: 0.9rem; }
    .tc-art__thumb { display: block; margin-top: 0.4rem; }
    .tc-art__thumb img {
      display: block; max-height: 96px; max-width: 100%; width: auto; height: auto;
      border-radius: var(--sk-radius-sm); border: 1px solid var(--sk-border-subtle); background: var(--sk-surface-1);
    }
    .tc-art__caption { margin-top: 0.3rem; font-size: var(--sk-text-xs); color: var(--sk-text-muted); }
    .artifact-file__img { max-width: 100%; height: auto; border-radius: var(--sk-radius-sm); border: 1px solid var(--sk-border-subtle); }
    .artifact-file__dl { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0; }
    .artifact-file__caption { white-space: pre-wrap; }

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
