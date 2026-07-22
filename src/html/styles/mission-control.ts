/** Mission control — workspace layout. Sidebar + main content area.
 *  Like VS Code: sidebar = task list, main = execution view, bottom = terminal.
 *  Single view, no page navigation. Click task → main updates.
 */
export function missionControlStyles(): string {
  return `
    /* ── Workspace shell: sidebar + main ── */
    /* Desktop: the sidebar column is a permanent 40px rail; the expanded
       sidebar overlays the main area (see the min-width media block below)
       so the dashboard always gets maximum width. Mobile overrides to 1fr. */
    .mc-workspace {
      display: grid;
      grid-template-columns: 40px 1fr;
      grid-template-rows: 1fr;
      height: calc(100vh - 48px);
      overflow: hidden; /* grid children scroll independently */
      background: var(--sk-surface-0);
    }

    /* ── Sidebar ── */
    .mc-sidebar {
      background: var(--sk-surface-1);
      border-right: 1px solid var(--sk-border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .mc-sidebar__header {
      padding: var(--sk-space-3);
      padding-top: var(--sk-space-4);
      border-bottom: 1px solid var(--sk-border);
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
    }
    .mc-sidebar__create {
      flex: 1;
      padding: 6px 10px;
      background: var(--sk-accent-primary);
      color: var(--on-primary);
      border: none;
      border-radius: var(--sk-radius-sm);
      font-weight: 700;
      font-size: var(--sk-text-xs);
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      display: block;
    }
    .mc-sidebar__create:hover { opacity: 0.9; color: var(--on-primary); }

    /* Footer container pinned to the bottom of the sidebar (list above it
       takes flex:1) — holds machine-wide quick settings like the parallel
       task toggle. */
    .mc-sidebar__footer {
      padding: var(--sk-space-2) var(--sk-space-3) var(--sk-space-3);
      border-top: 1px solid var(--sk-border);
      background: var(--sk-surface-1);
      flex-shrink: 0;
    }
    .mc-sidebar__footer .sk-checkbox { margin-top: 0; padding: var(--sk-space-1) 0; }

    .mc-sidebar__filters {
      display: flex;
      gap: 1px;
      background: var(--sk-border);
      border-bottom: 1px solid var(--sk-border);
    }
    .mc-sidebar__filter {
      flex: 1;
      padding: 6px 0;
      background: var(--sk-surface-1);
      border: none;
      color: var(--sk-text-subtle);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      text-align: center;
      transition: color 0.15s, background 0.15s;
    }
    .mc-sidebar__filter:hover { color: var(--sk-text-muted); background: var(--sk-surface-2); }
    .mc-sidebar__filter--active { color: var(--sk-accent-secondary); background: var(--sk-surface-2); }
    .mc-sidebar__filter-count {
      font-weight: 700;
      font-family: var(--sk-font-mono);
    }

    .mc-sidebar__list {
      flex: 1;
      overflow-y: auto;
    }
    .mc-sidebar__group-label {
      padding: 10px 12px 4px;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--sk-text-subtle);
      font-weight: 600;
    }
    .mc-sidebar__item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.1s;
      text-decoration: none;
      color: inherit;
    }
    .mc-sidebar__item:hover { background: var(--sk-surface-2); color: inherit; }
    .mc-sidebar__item--active {
      background: var(--sk-surface-2);
      border-left: 2px solid var(--sk-accent-primary);
    }
    .mc-sidebar__item-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .mc-sidebar__item-dot--running { background: var(--sk-accent-secondary); box-shadow: 0 0 4px var(--sk-accent-secondary); animation: mc-pulse 2s ease-in-out infinite; }
    .mc-sidebar__item-dot--completed { background: var(--sk-accent-tertiary); }
    .mc-sidebar__item-dot--failed { background: var(--sk-accent-danger); }
    .mc-sidebar__item-dot--approved { background: var(--sk-accent-warning); }
    .mc-sidebar__item-dot--paused { background: var(--sk-accent-warning); }
    .mc-sidebar__item-dot--draft { background: var(--sk-surface-4); }
    .mc-sidebar__item-dot--active { background: var(--sk-accent-tertiary); }
    .mc-sidebar__item-dot--archived { background: var(--sk-surface-4); }
    .mc-sidebar__item-title {
      flex: 1;
      font-size: var(--sk-text-sm);
      color: var(--sk-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mc-sidebar__item--active .mc-sidebar__item-title { color: var(--sk-text); }
    .mc-sidebar__item-time {
      font-size: 9px;
      color: var(--sk-text-subtle);
      font-family: var(--sk-font-mono);
      white-space: nowrap;
    }

    /* Attention dot on a task item: an open escalation or a pending phase review
       is waiting on the operator. Yellow so it reads as "needs input", distinct
       from the status dot on the left. */
    .mc-sidebar__item-attention {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: var(--sk-accent-warning);
      box-shadow: 0 0 5px var(--sk-accent-warning);
      animation: mc-pulse 2s ease-in-out infinite;
    }

    #mc-task-escalations:empty {
      display: none;
    }

    /* ── Main content area ── */
    .mc-main {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      overflow-x: hidden;
    }

    /* ── Main: empty / welcome state ── */
    .mc-welcome {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--sk-space-4);
      color: var(--sk-text-subtle);
      padding: var(--sk-space-12) var(--sk-space-8);
    }
    .mc-welcome__title {
      font-family: var(--sk-font-heading);
      font-size: 1.6rem;
      color: var(--sk-text-muted);
    }
    .mc-welcome__hint {
      font-size: var(--sk-text-sm);
      max-width: 440px;
      text-align: center;
      line-height: 1.6;
      margin-bottom: var(--sk-space-4);
    }
    .mc-welcome__stats {
      display: flex;
      gap: var(--sk-space-6);
      margin-top: var(--sk-space-4);
    }
    /* Architecture map backdrop — hidden by default, revealed by the retro
       themes (win95, geocities) via their override CSS. Needs a monospace
       font or the box-drawing alignment falls apart. */
    .mc-welcome__ascii {
      display: none;
      margin: 0;
      font-family: 'Courier New', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      line-height: 1.3;
      white-space: pre;
      user-select: none;
      pointer-events: none;
      max-width: 100%;
      overflow: hidden;
    }
    @media (max-width: 900px) {
      .mc-welcome__ascii { display: none !important; }
    }

    /* ── Main: task execution view ── */
    .mc-task-header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-6);
      padding: var(--sk-space-3) var(--sk-space-6);
      min-height: 78px;
      background: var(--sk-surface-1);
      border-bottom: 1px solid var(--sk-border);
    }
    .mc-task-header__title {
      font-weight: 700;
      color: var(--sk-text);
      font-size: var(--sk-text-base);
      flex: 1;
    }
    .mc-task-header__actions {
      display: flex;
      gap: var(--sk-space-2);
      /* Pinned to the far right; never shrinks, never scrolls out of view. */
      flex: 0 0 auto;
      margin-left: auto;
    }
    /* Middle region holding the phase indicator + agent cubes. Takes the
       remaining space and scrolls horizontally within itself, so a long phase
       stepper or a big agent roster can't push the action buttons (right) or
       the status dot + title (left) off screen. overflow-y is hidden because
       an overflow-x:auto box forces its y axis to a non-visible value anyway;
       the vertical padding gives the orbs' count badge room so it isn't
       clipped. */
    .mc-task-header__scroll {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: var(--sk-space-6);
      overflow-x: auto;
      overflow-y: hidden;
      padding: var(--sk-space-2) 0;
      scrollbar-width: thin;
    }
    .mc-task-header--with-phases .mc-task-header__title {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      /* Extra breathing room between the title and the phase indicator. */
      margin-right: var(--sk-space-3);
    }
    /* Phase indicator sizes to its content (same in running and completed
       states) so the layout is consistent and the orbs can dock next to it. */
    .mc-task-header__phases {
      flex: 0 0 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      overflow: hidden;
      /* Extra breathing room between the phase indicator and the cubes. */
      margin-right: var(--sk-space-3);
    }
    .mc-task-header__phases .mc-phase-stepper {
      padding: 0;
      background: transparent;
      border-bottom: none;
      flex: 0 0 auto;
    }
    .mc-task-header__phases .mc-phase-step__dot {
      width: 18px;
      height: 18px;
      font-size: 10px;
      border-width: 1px;
    }
    .mc-task-header__phases .mc-phase-step__connector {
      width: 12px;
      min-width: 12px;
      margin: 0;
    }
    /* Agent orbs dock directly against the phase indicator (natural gap from the
       header's flex gap), not centered in the bar. */
    .mc-task-header__orbs {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
    }
    /* overflow:visible so the active orb's glow halo isn't clipped (overflow-x
       on a flex row forces overflow-y clipping too). nowrap keeps the bar height
       stable; a large team just extends horizontally within the centered slot. */
    .mc-task-header__orbs .mc-agent-orbs { gap: var(--sk-space-2); padding: 0; min-height: 0; flex-wrap: nowrap; overflow: visible; }
    .mc-task-header__orbs .mc-agent-orb-wrapper { width: 64px; gap: 2px; }
    .mc-task-header__orbs .zen-orb { width: 28px; height: 28px; }
    /* Agent name under the orb. Small; kept compact so the orb stays clear of
       the navbar and running/idle bar heights match. */
    .mc-task-header__orbs .zen-view__orb-label {
      display: block; width: 64px; max-width: 64px; font-size: 9px; line-height: 1.15;
      text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Count badge on the orb's top-right corner (orb is centered in the 64px
       wrapper, so anchor to the wrapper centre rather than its edge). */
    .mc-task-header__orbs .mc-agent-orb__count {
      box-sizing: border-box;
      top: -3px; left: calc(50% + 2px); right: auto;
      min-width: 1.2rem; height: 1.2rem; padding: 0 0.18rem;
      font-size: 0.78rem; font-weight: 800; line-height: 1;
    }
    /* No glow halo on taskbar orbs (removed per design). */
    .mc-task-header__orbs .zen-orb.zen-orb--active { box-shadow: none; }

    /* ── Realtime composer — sits flush under the task bar (realtime tasks) ── */
    .mc-rt-composer {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      flex-wrap: wrap;
      padding: var(--sk-space-2) var(--sk-space-4);
      background: var(--sk-surface-1);
      border-bottom: 1px solid var(--sk-border);
    }
    .mc-rt-composer__form { flex: 1; min-width: 220px; display: flex; gap: var(--sk-space-2); align-items: center; }
    .mc-rt-composer__input {
      flex: 1; padding: 0.5rem 0.75rem; background: var(--sk-surface-0);
      border: 1px solid var(--sk-border); border-radius: var(--sk-radius);
      color: var(--sk-text); outline: none;
    }
    .mc-rt-composer__input:focus {
      border-color: color-mix(in srgb, var(--sk-accent-secondary) 60%, transparent);
      box-shadow: 0 0 10px color-mix(in srgb, var(--sk-accent-secondary) 18%, transparent);
    }
    .mc-rt-composer__audio { display: flex; gap: 0.5rem; align-items: center; flex-shrink: 0; }
    .mc-rt-composer__viz {
      flex-basis: 100%; overflow: hidden; background: var(--sk-surface-0);
      border: 1px solid var(--sk-border-subtle); border-radius: var(--sk-radius);
    }

    /* ── Tabbed content below the graph ── */
    /* Review gate / iterate panel slot between the task bar and the tabs. Equal
       padding all round; the banner's own sk-mb-4 bottom margin is zeroed so the
       slot's padding is the only spacing. */
    .mc-attention-slot {
      padding: var(--sk-space-3);
      background: var(--sk-surface-1);
    }
    .mc-attention-slot > .sk-panel { margin-bottom: 0; }
    .mc-tabs {
      display: flex;
      gap: var(--sk-space-2);
      background: var(--sk-surface-1);
      backdrop-filter: blur(16px) saturate(1.3);
      padding: var(--sk-space-2) var(--sk-space-3);
      margin-top: 0; /* flush against the task bar */
      margin-bottom: 0;
    }
    .mc-tab {
      padding: 6px 14px;
      font-size: var(--sk-text-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--sk-text-subtle);
      cursor: pointer;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--sk-btn-radius);
    }
    .mc-tab:hover {
      color: var(--sk-text-muted);
      border-color: var(--sk-border);
    }
    /* Toggle buttons are multi-active now (each drives one dock panel on/off). */
    .mc-tab--active,
    .mc-tab--active:hover {
      color: var(--sk-accent-secondary);
      border-color: rgba(0, 251, 251, 0.35);
      background: rgba(0, 251, 251, 0.06);
    }
    /* Escalations toggle: attention (pending items) + blocked flash (max-3). */
    .mc-tab--attention { color: var(--sk-warn, #f5a524); border-color: rgba(245, 165, 36, 0.4); }
    .mc-tab__badge {
      display: inline-block;
      margin-left: 6px;
      min-width: 15px;
      padding: 0 4px;
      font-size: 10px;
      line-height: 15px;
      text-align: center;
      border-radius: 8px;
      background: var(--sk-warn, #f5a524);
      color: #111;
    }
    @keyframes mc-tab-blocked { 0%,100% { transform: none; } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
    .mc-tab--blocked { animation: mc-tab-blocked 0.35s; border-color: var(--sk-danger, #e5484d); }
    /* Hide the "nothing needs input" hint once an escalation card
       (id^="escalation-") lands in the Escalations panel. */
    .mc-outputs__col[data-dock-panel="input"]:has([id^="escalation-"]) .mc-userinput__empty { display: none; }
    .mc-tab-panel { display: none; flex: 1; overflow-y: auto; padding: var(--sk-space-3); }
    .mc-tab-panel--active { display: flex; flex-direction: column; }

    /* ── Inline create form (shown in main area) ── */
    .mc-create-form {
      max-width: 560px;
      width: 100%;
    }
    .mc-create-form__field {
      margin-bottom: var(--sk-space-4);
    }
    .mc-create-form__label {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-subtle);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
      display: block;
    }
    .mc-create-form input[type="text"],
    .mc-create-form textarea,
    .mc-create-form select {
      width: 100%;
      padding: 10px 12px;
      background: var(--sk-surface-1);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-md);
      color: var(--sk-text);
      font-size: var(--sk-text-sm);
    }
    .mc-create-form input:focus,
    .mc-create-form textarea:focus,
    .mc-create-form select:focus {
      outline: none;
      border-color: var(--sk-accent-primary);
    }
    .mc-create-form textarea { min-height: 80px; resize: vertical; }
    .mc-create-form__actions {
      display: flex;
      gap: var(--sk-space-3);
      margin-top: var(--sk-space-4);
    }

    /* ── Mission Control: Full viewport, centered, focused ── */
    .mc {
      min-height: calc(100vh - 48px);
      display: flex;
      flex-direction: column;
      background: var(--sk-surface-0);
    }

    /* ── Status strip below navbar ── */
    .mc-status {
      display: flex;
      align-items: center;
      gap: var(--sk-space-4);
      padding: var(--sk-space-2) var(--sk-space-6);
      background: var(--sk-surface-1);
      border-bottom: 1px solid var(--sk-border);
      font-size: var(--sk-text-sm);
    }
    .mc-status__task-title {
      font-weight: 700;
      color: var(--sk-text);
      font-size: var(--sk-text-lg);
    }
    .mc-status__phase {
      display: flex;
      gap: 3px;
      align-items: center;
    }
    .mc-status__phase-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid var(--sk-surface-4);
      transition: all 0.3s;
    }
    .mc-status__phase-dot--done {
      background: var(--sk-accent-tertiary);
      border-color: var(--sk-accent-tertiary);
      box-shadow: 0 0 6px rgba(176, 255, 150, 0.4);
    }
    .mc-status__phase-dot--current {
      background: var(--sk-accent-secondary);
      border-color: var(--sk-accent-secondary);
      box-shadow: 0 0 8px rgba(0, 251, 251, 0.5);
      animation: mc-pulse 2s ease-in-out infinite;
    }
    .mc-status__phase-dot--review {
      background: var(--sk-accent-warning);
      border-color: var(--sk-accent-warning);
      box-shadow: 0 0 8px rgba(255, 208, 128, 0.5);
      animation: mc-pulse 1s ease-in-out infinite;
    }
    .mc-status__right {
      margin-left: auto;
      display: flex;
      gap: var(--sk-space-3);
      align-items: center;
    }

    /* ── Escalation banner — IMPOSSIBLE to miss ── */
    .mc-escalation {
      background: linear-gradient(90deg, rgba(255,70,70,0.15), rgba(255,70,70,0.05));
      border-bottom: 2px solid var(--sk-accent-danger);
      padding: var(--sk-space-3) var(--sk-space-6);
      display: flex;
      align-items: center;
      gap: var(--sk-space-4);
      animation: mc-escalation-glow 2s ease-in-out infinite;
    }
    .mc-escalation__icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--sk-accent-danger);
      color: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 18px;
      flex-shrink: 0;
      animation: mc-pulse 1s ease-in-out infinite;
    }
    .mc-escalation__text {
      font-size: var(--sk-text-base);
      color: var(--sk-accent-danger);
      font-weight: 600;
    }
    .mc-escalation__action {
      margin-left: auto;
      background: var(--sk-accent-danger);
      color: #000;
      font-weight: 700;
      padding: var(--sk-space-2) var(--sk-space-4);
      border-radius: var(--sk-radius-sm);
      text-decoration: none;
      font-size: var(--sk-text-sm);
    }
    .mc-escalation__action:hover { opacity: 0.9; color: #000; }

    @keyframes mc-escalation-glow {
      0%, 100% { box-shadow: inset 0 0 30px rgba(255,70,70,0.05); }
      50% { box-shadow: inset 0 0 60px rgba(255,70,70,0.1); }
    }

    /* ── Phase stepper — labeled steps with connectors ── */
    .mc-phase-stepper {
      display: flex;
      align-items: center;
      padding: var(--sk-space-3) var(--sk-space-6);
      background: var(--sk-surface-1);
      border-bottom: 1px solid var(--sk-border);
      gap: 0;
      overflow-x: auto;
    }
    .mc-phase-step {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .mc-phase-step__dot {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
      border: 2px solid var(--sk-surface-4);
      color: var(--sk-text-subtle);
      background: var(--sk-surface-2);
      transition: all 0.3s;
    }
    .mc-phase-step__name {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-subtle);
      transition: color 0.3s;
    }
    .mc-phase-step--completed .mc-phase-step__dot {
      background: var(--sk-accent-tertiary);
      border-color: var(--sk-accent-tertiary);
      color: #000;
      box-shadow: 0 0 8px rgba(176, 255, 150, 0.3);
    }
    .mc-phase-step--completed .mc-phase-step__name { color: var(--sk-accent-tertiary); }
    .mc-phase-step--current .mc-phase-step__dot {
      background: var(--sk-accent-secondary);
      border-color: var(--sk-accent-secondary);
      color: #000;
      box-shadow: 0 0 10px rgba(0, 251, 251, 0.4);
      animation: mc-pulse 2s ease-in-out infinite;
    }
    .mc-phase-step--current .mc-phase-step__name { color: var(--sk-accent-secondary); font-weight: 600; }
    .mc-phase-step--review .mc-phase-step__dot {
      background: var(--sk-accent-warning);
      border-color: var(--sk-accent-warning);
      color: #000;
      box-shadow: 0 0 10px rgba(255, 208, 128, 0.4);
      animation: mc-pulse 1s ease-in-out infinite;
    }
    .mc-phase-step--review .mc-phase-step__name { color: var(--sk-accent-warning); font-weight: 600; }
    .mc-phase-step--failed .mc-phase-step__dot {
      background: var(--sk-accent-danger);
      border-color: var(--sk-accent-danger);
      color: #000;
      box-shadow: 0 0 8px rgba(255, 107, 107, 0.4);
    }
    .mc-phase-step--failed .mc-phase-step__name { color: var(--sk-accent-danger); font-weight: 600; }
    .mc-phase-step__connector {
      width: 32px;
      height: 2px;
      background: var(--sk-surface-4);
      margin: 0 var(--sk-space-1);
      flex-shrink: 0;
    }
    .mc-phase-step--completed + .mc-phase-step__connector {
      background: var(--sk-accent-tertiary);
    }

    /* ── Compact agent list ── */
    .mc-agents {
      padding: var(--sk-space-2) var(--sk-space-4);
      background: var(--sk-surface-0);
      border-bottom: 1px solid var(--sk-border);
      display: flex;
      flex-wrap: wrap;
      gap: var(--sk-space-2);
    }
    .mc-agent-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-md);
      font-size: var(--sk-text-xs);
    }
    .mc-agent-row--running { border-color: rgba(0, 251, 251, 0.3); }
    .mc-agent-row--completed { opacity: 0.6; }
    .mc-agent-row--failed { border-color: rgba(255, 107, 107, 0.3); }
    .mc-agent-row--waiting { border-color: rgba(255, 137, 171, 0.2); }
    .mc-agent-row__name { font-weight: 600; color: var(--sk-text); }
    .mc-agent-row__status { color: var(--sk-text-subtle); }
    .mc-agent-row__pid { color: var(--sk-text-subtle); font-family: var(--sk-font-mono); font-size: 10px; }
    .mc-agent-row__depth { color: var(--sk-text-subtle); font-family: var(--sk-font-mono); font-size: 10px; opacity: 0.6; }

    /* ── Activity feed — parsed terminal output ── */
    .mc-activity__controls {
      display: flex;
      gap: 1px;
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-1);
      backdrop-filter: blur(16px) saturate(1.3);
      border-bottom: 1px solid var(--sk-border);
      flex-shrink: 0;
    }
    .mc-activity__filter {
      padding: 4px 10px;
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-btn-radius);
      color: var(--sk-text-subtle);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
    }
    .mc-activity__filter:hover { color: var(--sk-text-muted); background: var(--sk-surface-3); }
    .mc-activity__filter--active { color: var(--sk-accent-secondary); border-color: rgba(0,251,251,0.3); }
    .mc-activity__feed {
      flex: 1;
      overflow-y: auto;
      padding: var(--sk-space-1) 0;
    }
    .mc-activity__item {
      display: flex;
      align-items: baseline;
      gap: var(--sk-space-2);
      padding: 3px var(--sk-space-3);
      font-size: var(--sk-text-xs);
      line-height: 1.5;
      transition: background 0.1s;
      cursor: pointer;
    }
    .mc-activity__item:hover { background: var(--sk-surface-1); }
    .mc-activity__kind {
      flex-shrink: 0;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 1px 5px;
      border-radius: var(--sk-radius-xs);
      font-family: var(--sk-font-mono);
    }
    .mc-activity__kind--message { color: var(--sk-accent-secondary); background: rgba(0,251,251,0.08); }
    .mc-activity__kind--tool { color: var(--sk-accent-primary); background: rgba(255,137,171,0.08); }
    .mc-activity__kind--event { color: var(--sk-text-subtle); background: var(--sk-surface-2); }
    .mc-activity__agent {
      flex-shrink: 0;
      font-weight: 600;
      color: var(--sk-text-muted);
      font-size: 10px;
    }
    .mc-steer__pid,
    .mc-activity__pid {
      font-family: var(--sk-font-mono);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: var(--sk-radius-sm);
      background: color-mix(in srgb, var(--sk-surface-3) 60%, transparent);
      color: var(--sk-text-muted);
      flex: 0 0 auto;
    }
    .mc-steer-list { background: transparent; }
    .mc-steer-row + .mc-steer-row { border-top: 1px solid var(--sk-border-subtle); }

    /* --- Steer card stack (per-task command-center embed) --- */
    .mc-steer-stack {
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
      padding: 0;
    }
    .mc-steer-card {
      display: flex;
      flex-direction: column;
      background: color-mix(in srgb, var(--sk-surface-2) 70%, transparent);
      border: 1px solid var(--sk-border-subtle);
      border-radius: 0;
      overflow: hidden;
      transition: border-color 0.12s ease, background 0.12s ease;
    }
    .mc-steer-card:hover {
      border-color: var(--sk-border);
      background: var(--sk-surface-2);
    }
    .mc-steer-card__header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.75rem 0.3rem;
      min-width: 0;
    }
    .mc-steer-card__dot { flex: 0 0 auto; }
    .mc-steer-card__name {
      flex: 0 0 auto;
      white-space: nowrap;
      font-weight: 600;
      font-size: 0.82rem;
      color: var(--sk-text);
      text-decoration: none;
    }
    .mc-steer-card__name:hover { text-decoration: underline; }
    .mc-steer-card__sep {
      flex: 0 0 auto;
      color: var(--sk-text-muted);
      font-size: 0.82rem;
    }
    .mc-steer-card__message {
      flex: 1;
      min-width: 0;
      font-size: 0.82rem;
      line-height: 1.35;
      color: var(--sk-text-muted);
      font-weight: 400;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mc-steer-card__message--empty {
      font-style: italic;
      color: var(--sk-text-subtle);
    }
    .mc-steer-card__footer {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.55rem 0.45rem 0.75rem;
    }
    .mc-steer-card__pid {
      font-family: var(--sk-font-mono);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: var(--sk-radius-sm);
      background: color-mix(in srgb, var(--sk-surface-3) 60%, transparent);
      color: var(--sk-text-muted);
      flex: 0 0 auto;
    }
    .mc-steer-card__input {
      flex: 1;
      min-width: 0;
      resize: vertical;
      min-height: 4rem;
      font-size: 0.78rem;
      padding: 0.3rem 0.5rem;
      background: rgba(0, 0, 0, 0.25);
      color: var(--sk-text);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-sm);
      outline: none;
      font-family: inherit;
    }
    .mc-steer-card__input:focus {
      border-color: var(--sk-accent);
      background: rgba(0, 0, 0, 0.35);
    }
    .mc-steer-card__btn { flex: 0 0 auto; }
    .mc-steer-card__task {
      flex: 0 0 auto;
      max-width: 40%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 0.72rem;
      color: var(--sk-text-subtle);
    }

    /* --- Agent orbs (zen 3D gems on the dashboard; click → instance modal) --- */
    /* Reuses .zen-orb / .zen-view__orb-wrapper / .zen-view__orb-label so the
       zen-orbs-3d.js scanner upgrades these to 3D. Compact sizing for the panel. */
    .mc-agent-orbs {
      gap: var(--sk-space-4);
      padding: var(--sk-space-2) 0;
      min-height: 0;
    }
    .mc-agent-orb-wrapper { width: 92px; position: relative; }
    .mc-agent-orb-wrapper .zen-orb { width: 64px; height: 64px; }
    .mc-agent-orb-wrapper .zen-view__orb-label { width: 92px; font-size: 12px; }
    .mc-agent-orb--clickable { cursor: pointer; }
    /* Count badge — on the wrapper (not the orb, which is overflow:hidden in the
       CSS fallback) and above the z-index:5 WebGL orb canvas. */
    .mc-agent-orb__count {
      position: absolute;
      top: 2px;
      right: 12px;
      z-index: 7;
      min-width: 1.05rem;
      height: 1.05rem;
      padding: 0 0.28rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.62rem;
      font-weight: 700;
      line-height: 1;
      color: var(--sk-surface-0);
      background: var(--sk-accent-primary);
      border-radius: 999px;
      box-shadow: 0 0 6px color-mix(in srgb, var(--sk-accent-primary) 45%, transparent);
    }

    /* --- Agent instance modal --- */
    /* Height is content-driven: the modal grows with the number of cards shown
       (up to 88vh, then the instance list scrolls). No fixed height so a single
       card doesn't render in an oversized box. */
    .mc-agent-modal__content {
      width: min(960px, 94vw);
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .mc-agent-modal__content .sk-modal__body { padding: 0.75rem; overflow: hidden; display: flex; flex: 1; min-height: 0; }
    .mc-agent-instances {
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      width: 100%;
      padding-right: 0.25rem;
    }
    .mc-activity__text {
      color: var(--sk-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .mc-activity__empty {
      padding: var(--sk-space-8);
      text-align: center;
      color: var(--sk-text-subtle);
    }
    /* Activity filter state via JS */
    .mc-activity__feed[data-activity-filter="messages"] .mc-activity__item--tool,
    .mc-activity__feed[data-activity-filter="messages"] .mc-activity__item--event { display: none; }
    .mc-activity__feed[data-activity-filter="tools"] .mc-activity__item--message,
    .mc-activity__feed[data-activity-filter="tools"] .mc-activity__item--event { display: none; }
    .mc-activity__feed[data-activity-filter="timeline"] .mc-activity__item--activity { display: none; }
    .mc-activity__feed[data-activity-filter="activity"] .mc-activity__item--timeline { display: none; }
    .mc-node__indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 6px;
    }
    .mc-node__indicator--running {
      background: var(--sk-accent-secondary);
      box-shadow: 0 0 6px var(--sk-accent-secondary);
      animation: mc-pulse 2s ease-in-out infinite;
    }
    .mc-node__indicator--completed { background: var(--sk-accent-tertiary); }
    .mc-node__indicator--failed { background: var(--sk-accent-danger); }
    .mc-node__indicator--waiting { background: var(--sk-accent-primary); animation: mc-pulse 3s ease-in-out infinite; }
    .mc-node__indicator--pending { background: var(--sk-surface-4); }
    .mc-node__indicator--paused { background: var(--sk-accent-warning); }
    .mc-node__name {
      font-weight: 700;
      color: var(--sk-text);
      font-size: var(--sk-text-base);
    }
    .mc-node__meta {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      font-family: var(--sk-font-mono);
      margin-top: 2px;
    }

    /* ── Connection lines between nodes ── */
    .mc-graph__connectors {
      display: flex;
      justify-content: center;
      height: 24px;
      position: relative;
    }
    .mc-graph__connector-line {
      width: 2px;
      height: 24px;
      background: linear-gradient(to bottom, rgba(0,251,251,0.3), rgba(0,251,251,0.1));
    }
    .mc-graph__connector-branch {
      display: flex;
      align-items: flex-end;
      gap: 0;
      height: 24px;
    }
    .mc-graph__connector-h {
      height: 2px;
      background: rgba(0,251,251,0.2);
      min-width: 40px;
    }
    .mc-graph__connector-v {
      width: 2px;
      height: 12px;
      background: rgba(0,251,251,0.2);
    }

    /* ── Live terminal below selected node ── */
    .mc-terminal {
      width: 100%;
      max-width: 900px;
      background: var(--sk-surface-1);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-md);
      overflow: hidden;
    }
    .mc-terminal__header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-2);
      border-bottom: 1px solid var(--sk-border);
      font-size: var(--sk-text-xs);
    }
    .mc-terminal__header-name {
      color: var(--sk-accent-secondary);
      font-weight: 600;
    }
    .mc-terminal__body {
      height: 240px;
      overflow-y: auto;
      padding: var(--sk-space-2);
      font-family: var(--sk-font-mono);
      font-size: 11px;
      line-height: 1.6;
      color: var(--sk-text-muted);
    }
    .mc-terminal__line--stderr { color: var(--sk-accent-danger); }
    .mc-terminal__line--summary { color: var(--sk-accent-secondary); padding-left: 1rem; }

    /* ── Info strip at bottom ── */
    .mc-info {
      display: flex;
      align-items: center;
      gap: var(--sk-space-6);
      padding: var(--sk-space-3) var(--sk-space-6);
      background: var(--sk-surface-1);
      border-top: 1px solid var(--sk-border);
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
    }
    .mc-info__notes {
      display: flex;
      gap: var(--sk-space-2);
      flex: 1;
      overflow: hidden;
    }
    .mc-info__note {
      background: var(--sk-surface-3);
      padding: 2px 8px;
      border-radius: var(--sk-radius-xs);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    .mc-info__stats {
      display: flex;
      gap: var(--sk-space-4);
      white-space: nowrap;
    }
    .mc-info__actions {
      display: flex;
      gap: var(--sk-space-2);
    }

    /* ── Idle state — command center between missions ── */
    .mc-idle {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: auto 1fr;
      gap: var(--sk-space-6);
      padding: var(--sk-space-6) var(--sk-space-8);
      overflow-y: auto;
      background:
        radial-gradient(ellipse at 20% 50%, rgba(255,137,171,0.03) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 50%, rgba(0,251,251,0.03) 0%, transparent 50%),
        var(--sk-surface-0);
    }

    /* ── Top row: stat cards spanning full width ── */
    .mc-idle__stats {
      grid-column: 1 / -1;
      display: flex;
      gap: var(--sk-space-4);
      justify-content: center;
    }
    .mc-stat-card {
      background: var(--sk-surface-1);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-lg);
      padding: var(--sk-space-4) var(--sk-space-6);
      text-align: center;
      min-width: 140px;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    .mc-stat-card:hover { border-color: var(--sk-border-subtle); }
    .mc-stat-card--primary { border-color: rgba(255,137,171,0.15); }
    .mc-stat-card--primary:hover { box-shadow: 0 0 20px rgba(255,137,171,0.06); }
    .mc-stat-card--secondary { border-color: rgba(0,251,251,0.15); }
    .mc-stat-card--secondary:hover { box-shadow: 0 0 20px rgba(0,251,251,0.06); }
    .mc-stat-card--success { border-color: rgba(176,255,150,0.15); }
    .mc-stat-card--danger { border-color: rgba(255,107,107,0.15); }
    .mc-stat-card__value {
      font-family: var(--sk-font-heading);
      font-size: 2rem;
      font-weight: 700;
      line-height: 1;
      margin-bottom: 4px;
    }
    .mc-stat-card__value--primary { color: var(--sk-accent-primary); }
    .mc-stat-card__value--secondary { color: var(--sk-accent-secondary); }
    .mc-stat-card__value--success { color: var(--sk-accent-tertiary); }
    .mc-stat-card__value--danger { color: var(--sk-accent-danger); }
    .mc-stat-card__value--muted { color: var(--sk-text-muted); }
    .mc-stat-card__label {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-subtle);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    /* ── Left column: command input ── */
    .mc-idle__command {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .mc-idle__command-label {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-xs);
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--sk-accent-primary);
      margin-bottom: var(--sk-space-3);
    }
    .mc-idle__input {
      width: 100%;
      padding: var(--sk-space-4);
      background: var(--sk-surface-1);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-md);
      color: var(--sk-text);
      font-size: var(--sk-text-lg);
      margin-bottom: var(--sk-space-3);
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .mc-idle__input:focus {
      outline: none;
      border-color: var(--sk-accent-primary);
      box-shadow: 0 0 30px rgba(255,137,171,0.08);
    }
    .mc-idle__input::placeholder { color: rgba(173,170,170,0.4); }
    .mc-idle__desc {
      width: 100%;
      padding: var(--sk-space-3);
      background: var(--sk-surface-1);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-md);
      color: var(--sk-text-muted);
      font-size: var(--sk-text-sm);
      resize: vertical;
      min-height: 60px;
      margin-bottom: var(--sk-space-3);
    }
    .mc-idle__desc:focus { outline: none; border-color: var(--sk-border-subtle); }
    .mc-idle__form-row {
      display: flex;
      gap: var(--sk-space-3);
      align-items: center;
    }
    .mc-idle__team-select {
      flex: 1;
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-1);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-md);
      color: var(--sk-text-muted);
      font-size: var(--sk-text-sm);
    }
    .mc-idle__go {
      background: var(--sk-accent-primary);
      color: var(--on-primary);
      border: none;
      padding: var(--sk-space-3) var(--sk-space-6);
      border-radius: var(--sk-radius-md);
      font-weight: 700;
      font-size: var(--sk-text-sm);
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .mc-idle__go:hover {
      box-shadow: 0 0 25px rgba(255,137,171,0.3);
      transform: translateY(-1px);
    }

    /* ── Right column: recent activity feed ── */
    .mc-idle__feed {
      display: flex;
      flex-direction: column;
    }
    .mc-idle__feed-title {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-xs);
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--sk-accent-secondary);
      margin-bottom: var(--sk-space-3);
    }
    .mc-idle__feed-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
      background: var(--sk-border);
      border-radius: var(--sk-radius-md);
      overflow: hidden;
    }
    .mc-idle__feed-item {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      padding: var(--sk-space-3) var(--sk-space-4);
      background: var(--sk-surface-1);
      transition: background 0.15s;
    }
    .mc-idle__feed-item:hover { background: var(--sk-surface-2); }
    .mc-idle__feed-item a { flex: 1; color: var(--sk-text); font-size: var(--sk-text-sm); }
    .mc-idle__feed-item a:hover { color: var(--sk-accent-primary); }
    .mc-idle__feed-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .mc-idle__feed-status--completed { background: var(--sk-accent-tertiary); box-shadow: 0 0 4px rgba(176,255,150,0.4); }
    .mc-idle__feed-status--failed { background: var(--sk-accent-danger); box-shadow: 0 0 4px rgba(255,107,107,0.4); }
    .mc-idle__feed-time {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-subtle);
      font-family: var(--sk-font-mono);
      white-space: nowrap;
    }
    .mc-idle__feed-empty {
      padding: var(--sk-space-8);
      text-align: center;
      color: var(--sk-text-subtle);
      background: var(--sk-surface-1);
      border-radius: var(--sk-radius-md);
    }

    /* ── Counters in navbar ── */
    .mc-nav-stats {
      display: flex;
      gap: var(--sk-space-4);
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
    }
    .mc-nav-stat-value { font-weight: 700; }
    .mc-nav-stat-value--active { color: var(--sk-accent-secondary); }

    @keyframes mc-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Chat toggle button in navbar ── */
    .mc-chat-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: var(--sk-btn-height-sm);
      padding: var(--sk-btn-pad-y-sm) var(--sk-btn-pad-x-sm);
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-btn-radius);
      color: var(--sk-text-muted);
      font-size: var(--sk-btn-font-sm);
      font-weight: 600;
      line-height: 1.1;
      white-space: nowrap;
      cursor: pointer;
    }
    .mc-chat-toggle:hover {
      background: var(--sk-surface-3);
      color: var(--sk-text);
      border-color: var(--sk-border-subtle);
    }
    .mc-chat-toggle--active {
      background: var(--sk-accent-primary);
      color: var(--on-primary);
      border-color: var(--sk-accent-primary);
    }
    .mc-chat-toggle--active:hover {
      opacity: 0.9;
      color: var(--on-primary);
    }

    /* ── Chat bottom panel ── */
    .mc-chat-panel {
      display: none;
      grid-column: 1 / -1;
      height: 300px;
      min-height: 120px;
      max-height: 80vh;
      background: var(--sk-surface-1);
      border-top: 1px solid var(--sk-border);
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }
    .mc-workspace--chat-open {
      grid-template-rows: 1fr auto;
    }
    .mc-workspace--chat-open .mc-chat-panel {
      display: flex;
    }
    /* Blur everything in the workspace except the chat panel itself when chat is open.
       Direct children only so the filter does not propagate down into the chat panel
       (CSS filter applies to all descendants of the element it is on). */
    .mc-workspace--chat-open > *:not(.mc-chat-panel) {
      filter: blur(6px);
      pointer-events: none;
      user-select: none;
      transition: filter 0.18s ease;
    }
    .mc-workspace > *:not(.mc-chat-panel) {
      transition: filter 0.18s ease;
    }
    .mc-chat-panel__resize-handle {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      cursor: ns-resize;
      background: transparent;
      z-index: 10;
      transition: background 0.15s;
    }
    .mc-chat-panel__resize-handle:hover,
    .mc-chat-panel__resize-handle--active {
      background: var(--sk-accent-primary);
    }
    .mc-chat-panel__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-2);
      border-bottom: 1px solid var(--sk-border);
      flex-shrink: 0;
    }
    .mc-chat-panel__title {
      font-size: var(--sk-text-xs);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--sk-text-muted);
    }
    .mc-chat-panel__close {
      background: none;
      border: none;
      color: var(--sk-text-subtle);
      font-size: 16px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      transition: color 0.15s;
    }
    .mc-chat-panel__close:hover {
      color: var(--sk-text);
    }
    .mc-chat-panel--fullscreen {
      height: 100% !important;
      max-height: none;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      /* Above the overlay sidebar (z-index 100), below modals (200): the
         collapsed sidebar rail must not paint over full-height chat. */
      z-index: 150;
    }
    .mc-chat-panel__body {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: row;
    }
    /* Override v1 defaults: show conversation sidebar in v2 chat panel.
       The v1 fragment puts .chat-fullscreen-sidebar + .chat-main as direct
       children of #dashboard-chat-panel. We force them side-by-side. */
    .mc-chat-panel #dashboard-chat-panel {
      display: flex !important;
      flex-direction: row !important;
      height: 100%;
    }
    .mc-chat-panel #dashboard-chat-panel > .chat-fullscreen-sidebar,
    .mc-chat-panel #chat-sidebar {
      display: flex !important;
      width: 240px;
      min-width: 180px;
      flex-shrink: 0;
      flex-direction: column;
      border-right: 1px solid var(--sk-border);
      overflow-y: auto;
      background: var(--sk-surface-2);
    }
    /* Style the + New Chat button to match sk-btn--primary */
    .mc-chat-panel .conversation-list .btn-sm {
      background: var(--sk-accent-primary) !important;
      color: var(--on-primary) !important;
      border: none !important;
      border-radius: var(--sk-radius-sm);
      font-weight: 700;
      font-size: var(--sk-text-xs);
      padding: 6px 10px;
    }
    .mc-chat-panel .conversation-list .btn-sm:hover {
      opacity: 0.9;
    }
    .mc-chat-panel #dashboard-chat-panel > .chat-main {
      flex: 1 !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden;
      min-width: 0;
    }
    .mc-chat-panel .chat-messages {
      flex: 1;
      overflow-y: auto;
    }
    .mc-chat-panel .chat-input-area {
      flex-shrink: 0;
      padding: var(--sk-space-3);
      border-top: 1px solid var(--sk-border);
    }
    .mc-chat-panel .chat-input-area textarea {
      width: 100%;
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-0);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-md);
      color: var(--sk-text);
      font-size: var(--sk-text-sm);
      resize: none;
      margin-bottom: var(--sk-space-2);
    }
    .mc-chat-panel .chat-input-area textarea:focus {
      outline: none;
      border-color: var(--sk-accent-primary);
    }
    .mc-chat-panel .chat-input-row {
      display: flex;
      gap: var(--sk-space-2);
      justify-content: flex-end;
    }
    /* Normalize v1 btn-sm to match v2 sk-btn inside chat panel */
    .mc-chat-panel .btn-sm,
    .mc-chat-panel button[type="submit"] {
      display: inline-flex;
      align-items: center;
      gap: 0.4em;
      padding: 0.35rem 0.65rem;
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-sm);
      background: var(--sk-surface-3);
      color: var(--sk-text-muted);
      cursor: pointer;
      font-size: var(--sk-text-xs);
      font-weight: 600;
      transition: background 0.15s, color 0.15s;
    }
    .mc-chat-panel .btn-sm:hover,
    .mc-chat-panel button[type="submit"]:hover {
      background: var(--sk-surface-4);
      color: var(--sk-text);
    }
    /* Send button — primary style */
    .mc-chat-panel .chat-input-row button[type="submit"] {
      background: var(--sk-accent-primary);
      color: var(--on-primary);
      border-color: var(--sk-accent-primary);
      font-weight: 700;
    }
    .mc-chat-panel .chat-input-row button[type="submit"]:hover {
      opacity: 0.9;
      color: var(--on-primary);
    }
    .mc-chat-panel .cmd-panel-header {
      flex-shrink: 0;
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-2);
      border-bottom: 1px solid var(--sk-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 36px;
    }
    .mc-chat-panel .cmd-panel-title {
      font-size: var(--sk-text-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--sk-text-muted);
    }
    /* Normalize v1 badge styling inside chat */
    .mc-chat-panel .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.15em 0.5em;
      border-radius: var(--sk-radius-sm);
      font-size: var(--sk-text-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mc-chat-panel .badge-running { background: rgba(0,251,251,0.15); color: var(--sk-accent-secondary); border: 1px solid rgba(0,251,251,0.3); }
    .mc-chat-panel .badge-stopped { background: rgba(173,170,170,0.1); color: var(--sk-text-muted); border: 1px solid var(--sk-border-subtle); }

    /* Conversation item action buttons (rename, delete) — absolute so they don't shift layout */
    .conversation-item {
      position: relative;
    }
    .conv-item-actions {
      display: none;
      gap: 2px;
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      background: var(--sk-surface-3);
      padding: 1px 2px;
      border-radius: var(--sk-radius-xs);
    }
    .conversation-item:hover .conv-item-actions {
      display: flex;
    }
    .conv-action-btn {
      background: none;
      border: none;
      color: var(--sk-text-subtle);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 4px;
      border-radius: var(--sk-radius-xs);
      transition: color 0.15s, background 0.15s;
      line-height: 1;
    }
    .conv-action-btn:hover {
      color: var(--sk-text);
      background: var(--sk-surface-4);
    }
    .conv-action-btn--danger:hover {
      color: var(--sk-accent-danger);
      background: rgba(255,107,107,0.1);
    }

    /* ── Chat typing indicator ── */
    .chat-typing-indicator {
      opacity: 0.7;
    }
    /* Server-driven busy slot rendered below the chat messages container.
       Empty (data-busy="0") collapses to nothing; populated (data-busy="1")
       shows the model label + animated dots so the user knows the agent is
       still working between streamed chunks. */
    .chat-busy {
      display: flex;
      padding: 0 0.55rem;
    }
    .chat-busy[data-busy="0"] { display: none; }
    .chat-busy__bubble {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.2rem 0;
      font-size: 0.72rem;
      color: var(--on-surface-variant, #adaaaa);
      background: transparent;
      border: none;
    }
    .chat-busy__label {
      font-family: var(--sk-font-mono, monospace);
      letter-spacing: -0.01em;
    }
    .chat-typing-dots {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      height: 1.2em;
    }
    .chat-typing-dots span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--sk-accent-secondary);
      animation: chat-typing-bounce 1.4s ease-in-out infinite;
    }
    .chat-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .chat-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes chat-typing-bounce {
      0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }

    /* Collapsible conversation sidebar */
    .mc-chat-panel--sidebar-collapsed #dashboard-chat-panel > .chat-fullscreen-sidebar,
    .mc-chat-panel--sidebar-collapsed #chat-sidebar {
      display: none !important;
    }
    .conv-sidebar-toggle {
      background: none;
      border: none;
      color: var(--sk-text-subtle);
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      line-height: 1;
      transition: color 0.15s;
    }
    .conv-sidebar-toggle:hover { color: var(--sk-text); }

    /* ── Desktop sidebar: collapsed rail, hover to overlay, pin to dock ──
       Closed by default: a 40px rail with just the arrow button. Hovering
       the rail slides the full sidebar out OVER the main area (it sits in
       the 40px grid column and overflows it with a higher z-index, so the
       dashboard never reflows). Mouse-out collapses it again. Clicking the
       arrow pins it open as a real 260px grid column instead: the main
       area reflows next to it, no overlay, no shadow (persisted; see
       Skipper.sidebar in skipper.js). */
    @media (min-width: 769px) {
      .mc-sidebar {
        position: relative;
        z-index: 100;
        width: 40px;
        transition: width 0.15s ease;
        overflow: hidden;
      }
      .mc-sidebar:hover,
      .mc-workspace--sidebar-pinned .mc-sidebar {
        width: 260px;
      }
      /* Hover (unpinned) is the temporary overlay: shadow signals floating. */
      .mc-workspace:not(.mc-workspace--sidebar-pinned) .mc-sidebar:hover {
        box-shadow: 4px 0 16px rgba(0, 0, 0, 0.35);
      }
      /* Pinned: widen the grid column so the sidebar is part of the layout. */
      .mc-workspace--sidebar-pinned {
        grid-template-columns: 260px 1fr;
      }
      /* Closed rail: content hidden, arrow centered. */
      .mc-sidebar__create,
      .mc-sidebar__list,
      .mc-sidebar__footer {
        display: none;
      }
      .mc-sidebar__header {
        justify-content: center;
        padding: var(--sk-space-3) var(--sk-space-1);
      }
      /* Open (hovered or pinned): full content at its final 260px width so
         text doesn't reflow while the panel is still sliding. */
      .mc-sidebar:hover .mc-sidebar__create,
      .mc-workspace--sidebar-pinned .mc-sidebar__create { display: block; }
      .mc-sidebar:hover .mc-sidebar__list,
      .mc-workspace--sidebar-pinned .mc-sidebar__list { display: block; }
      .mc-sidebar:hover .mc-sidebar__footer,
      .mc-workspace--sidebar-pinned .mc-sidebar__footer { display: block; }
      .mc-sidebar:hover .mc-sidebar__header,
      .mc-workspace--sidebar-pinned .mc-sidebar__header {
        justify-content: flex-start;
        padding: var(--sk-space-3);
        padding-top: var(--sk-space-4);
      }
      .mc-sidebar:hover .mc-sidebar__header,
      .mc-sidebar:hover .mc-sidebar__list,
      .mc-sidebar:hover .mc-sidebar__footer,
      .mc-workspace--sidebar-pinned .mc-sidebar__header,
      .mc-workspace--sidebar-pinned .mc-sidebar__list,
      .mc-workspace--sidebar-pinned .mc-sidebar__footer {
        min-width: 260px;
      }
      /* Arrow points right (open me) when unpinned, left (unpin) when pinned. */
      .mc-sidebar__collapse-btn { transform: rotate(180deg); }
      .mc-workspace--sidebar-pinned .mc-sidebar__collapse-btn { transform: none; }
    }
    .mc-sidebar__collapse-btn {
      background: none;
      border: none;
      color: var(--sk-text-subtle);
      cursor: pointer;
      font-size: 12px;
      padding: 2px 6px;
      line-height: 1;
      transition: color 0.15s, transform 0.15s;
      flex-shrink: 0;
    }
    .mc-sidebar__collapse-btn:hover { color: var(--sk-text); }

    /* ── Outputs 3-column layout ── */
    .mc-outputs {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .mc-outputs__col {
      flex: 1 1 0;
      min-width: 120px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .mc-outputs__col-header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      padding: var(--sk-space-2) var(--sk-space-3);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--sk-text-subtle);
      font-weight: 600;
      background: var(--sk-surface-1);
      border-bottom: 1px solid var(--sk-border);
      flex-shrink: 0;
      cursor: grab;              /* the whole header is the reorder drag handle */
      user-select: none;
    }
    .mc-outputs__col-header:active { cursor: grabbing; }
    /* Drag affordance drawn in CSS (three lines) rather than the ☰ glyph, whose
       ink sits high in its em box and reads as misaligned with the title. */
    .mc-outputs__col-header::before {
      content: '';
      flex-shrink: 0;
      width: 13px;
      height: 10px;
      opacity: 0.5;
      background:
        linear-gradient(currentColor, currentColor) left top / 100% 2px no-repeat,
        linear-gradient(currentColor, currentColor) left 50% / 100% 2px no-repeat,
        linear-gradient(currentColor, currentColor) left bottom / 100% 2px no-repeat;
    }
    .mc-outputs__col-title { flex: 1; min-width: 0; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mc-outputs__col-close {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      background: transparent;
      border: none;
      color: var(--sk-text-subtle);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      border-radius: var(--sk-btn-radius);
    }
    .mc-outputs__col-close:hover { color: var(--sk-text); background: var(--sk-surface-3); }
    .mc-outputs__col-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--sk-space-2);
    }
    .mc-outputs__divider {
      width: 4px;
      flex-shrink: 0;
      background: var(--sk-border);
      cursor: col-resize;
      transition: background 0.15s;
      position: relative;
    }
    .mc-outputs__divider:hover,
    .mc-outputs__divider--active {
      background: var(--sk-accent-primary);
    }
    .mc-outputs__divider::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: -4px;
      right: -4px;
    }

    /* Sidebar drawer backdrop — fixed-position and hidden at all viewports
     * by default. The mobile media query promotes it to visible only when
     * .mc-workspace--sidebar-open is set. Defining it OUTSIDE the media
     * query is critical: the element is the first child of the mc-workspace
     * grid; without position:fixed it would consume the 260px sidebar
     * column on desktop and push the sidebar/main into the wrong slots. */
    .mc-sidebar__backdrop {
      position: fixed;
      inset: 48px 0 0 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 99;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
      display: none;
    }

    /* ── Mobile (≤ 768px) ─────────────────────────────────────────────
     * Operator monitoring console: keep notes / artifacts / steer /
     * escalations; hide activity feed, task details tab, agent tree,
     * chat panel, resize dividers. Sidebar becomes an off-canvas
     * drawer toggled via the existing data-sk-sidebar-toggle button.
     * The JS branch in Skipper.sidebar.toggle picks the right class
     * (--sidebar-open here vs --sidebar-pinned on desktop) based
     * on window.matchMedia. */
    @media (max-width: 768px) {
      .mc-workspace {
        grid-template-columns: 1fr;
      }
      .mc-sidebar {
        position: fixed;
        top: 48px;
        left: 0;
        bottom: 0;
        width: min(85vw, 320px);
        z-index: 100;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        border-right: 1px solid var(--sk-border);
      }
      .mc-workspace--sidebar-open .mc-sidebar {
        transform: translateX(0);
      }
      /* Backdrop styles are defined outside the media query (kept fixed +
       * display:none by default so the element stays out of the grid flow);
       * here we just enable it for mobile and toggle visibility when the
       * drawer opens. */
      .mc-sidebar__backdrop {
        display: block;
      }
      .mc-workspace--sidebar-open .mc-sidebar__backdrop {
        opacity: 1;
        pointer-events: auto;
      }
      /* Outputs stack: single column, no dividers, no activity feed. */
      .mc-outputs {
        grid-template-columns: 1fr !important;
      }
      .mc-outputs__divider,
      .mc-outputs__col[data-outputs-col="activity"] {
        display: none !important;
      }

      /* Hide the Outputs/Details tab strip (only one tab survives) and
       * the Details tab content itself (agent tree + delegations). */
      .mc-tabs { display: none; }
      #mc-tab-details { display: none !important; }

      /* Hide the Skipper chat panel + its toggle button. */
      .mc-chat-panel,
      [data-sk-chat-toggle] {
        display: none !important;
      }

      /* Phase strip: keep it but allow horizontal scroll for long chains. */
      .mc-phase-stepper {
        font-size: 0.7rem;
        overflow-x: auto;
        flex-wrap: nowrap;
      }

      /* Task header: stack onto multiple rows instead of one cramped line.
       * Desktop puts indicator + title + phases + badge + team + actions on
       * one row separated by gap:var(--sk-space-4) — at 375px there isn't
       * room. Wrap, tighten padding, let the title take its own line, push
       * actions to a full-width row at the bottom. */
      .mc-task-header {
        flex-wrap: wrap;
        gap: var(--sk-space-2);
        padding: var(--sk-space-2) var(--sk-space-3);
        align-items: center;
      }
      /* Title shares row 1 with the status indicator + status badge instead of
       * claiming the whole row. flex:1 1 0 + min-width:0 lets it absorb
       * leftover space and wrap its text rather than overflow. */
      .mc-task-header__title {
        flex: 1 1 0;
        min-width: 0;
        font-size: 0.95rem;
        line-height: 1.25;
        word-break: break-word;
      }
      .mc-task-header--with-phases .mc-task-header__title {
        flex: 1 1 0;
        min-width: 0;
      }
      /* Phases + orbs share a full-width row of their own and scroll
         horizontally within it (they live inside .mc-task-header__scroll now). */
      .mc-task-header__scroll {
        flex: 1 1 100%;
        order: 2;
      }
      .mc-task-header__phases {
        flex: 0 0 auto;
      }
      .mc-task-header__actions {
        flex: 1 1 100%;
        order: 3;
        flex-wrap: wrap;
      }
      .mc-task-header__actions .sk-btn {
        flex: 1 1 auto;
        min-width: 0;
      }
      /* Team name is the lowest-signal field — drop it on mobile to free
       * vertical space. The status badge stays inline with the title. */
      .mc-task-header > .sk-muted.sk-text-xs {
        display: none;
      }

      /* Sidebar toggle visible on mobile (was hidden on desktop when
       * sidebar was already visible — we want the hamburger always on). */
      .mc-sidebar__collapse-btn { display: block; }

      /* Top-bar hamburger surfaces on mobile only. */
      .sk-navbar__hamburger { display: inline-flex !important; }
    }

    /* Hamburger button — hidden on desktop, shown via media query above. */
    .sk-navbar__hamburger {
      display: none;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      margin-right: 0.5rem;
      background: transparent;
      color: var(--sk-text);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-sm);
      font-size: 1rem;
      cursor: pointer;
    }
    .sk-navbar__hamburger:hover {
      background: var(--sk-surface-2);
    }

    .sk-thinking-wave {
      display: inline-flex;
      gap: 0;
      color: var(--sk-accent-secondary);
      font-family: var(--sk-font-mono, monospace);
      font-size: inherit;
    }
    .sk-wave-char {
      display: inline-block;
      animation: sk-wave 1.4s ease-in-out infinite;
    }
    @keyframes sk-wave {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-3px); }
    }
    .mc-steer-card__thinking-rest {
      color: var(--sk-text-subtle, var(--muted));
      margin-left: 0.3em;
    }
  `;
}
