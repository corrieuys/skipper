/** Layout styles: navbar, container, grid */
export function layoutStyles(): string {
  return `
    .sk-navbar {
      display: flex;
      align-items: center;
      gap: var(--sk-space-4);
      padding: 0 var(--sk-space-4);
      background: var(--sk-surface-2);
      position: sticky;
      top: 0;
      backdrop-filter: blur(12px);
      z-index: var(--sk-z-navbar);
      height: 48px;
      border-bottom: 1px solid var(--sk-border);
    }
    .sk-navbar__left {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
    }
    .sk-navbar__brand {
      font-family: var(--sk-font-heading);
      font-weight: 700;
      letter-spacing: -0.02em;
      font-size: 0.95rem;
      color: var(--sk-accent-primary);
      text-transform: uppercase;
    }
    .sk-navbar__right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
    }
    .sk-navbar__game-btn,
    .sk-navbar__monkey-toggle {
      font-size: 1.25rem;
      line-height: 1;
      cursor: pointer;
      text-decoration: none;
    }

    /* ── Skipper Connect — tinted link icon, status by colour + glow ── */
    .sk-connect {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .sk-connect__status { display: none; }
    .sk-connect__icon {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--sk-text-muted);
      transition: color 300ms ease;
    }
    .sk-connect__icon svg { display: block; width: 18px; height: 18px; position: relative; z-index: 1; }
    /* status driven from the hidden polled carrier via sibling selector */
    .sk-connect__status[data-status="connecting"] ~ .sk-connect__icon,
    .sk-connect__status[data-status="error"] ~ .sk-connect__icon {
      color: var(--accent-yellow);
    }
    .sk-connect__status[data-status="auth_failed"] ~ .sk-connect__icon {
      color: var(--error);
    }
    .sk-connect__status[data-status="connected"] ~ .sk-connect__icon {
      color: var(--success);
    }
    /* radar ping — waves radiating from the exact centre of the icon.
       translate(-50%,-50%) keeps the ring centred on the icon's mid-point
       independent of ring size, so growth is always concentric. */
    .sk-connect__status[data-status="connected"] ~ .sk-connect__icon::before,
    .sk-connect__status[data-status="connected"] ~ .sk-connect__icon::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1.5px solid rgba(176, 255, 150, 0.7);
      pointer-events: none;
      z-index: 0;
      transform: translate(-50%, -50%) scale(0.1);
      opacity: 0;
      animation: sk-connect-ping 2.2s ease-out infinite;
    }
    .sk-connect__status[data-status="connected"] ~ .sk-connect__icon::after {
      animation-delay: 1.1s;
    }
    @keyframes sk-connect-ping {
      0%   { transform: translate(-50%, -50%) scale(0.1); opacity: 0.75; }
      70%  { opacity: 0; }
      100% { transform: translate(-50%, -50%) scale(2.4); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .sk-connect__status[data-status="connected"] ~ .sk-connect__icon::before,
      .sk-connect__status[data-status="connected"] ~ .sk-connect__icon::after { animation: none; }
    }

    .sk-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: var(--sk-space-4);
      padding-bottom: var(--sk-space-12);
    }
    .sk-container--full {
      max-width: none;
    }

    /* ── Two-column layout for task execution ── */
    .sk-layout-split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: var(--sk-space-4);
    }

    /* ── Page header ── */
    .sk-page-header {
      display: flex;
      align-items: baseline;
      gap: var(--sk-space-4);
      padding: var(--sk-space-4) 0;
      border-bottom: 1px solid var(--sk-border);
      margin-bottom: var(--sk-space-6);
    }
    .sk-page-header__back {
      color: var(--sk-text-muted);
      font-size: var(--sk-text-sm);
    }
    .sk-page-header__back:hover { color: var(--sk-text); }
    .sk-page-header__title {
      font-size: var(--sk-text-xl);
      font-weight: 600;
      color: var(--sk-text);
      margin: 0;
      line-height: 1.2;
    }

    /* ── Collapsible section ── */
    .sk-collapsible__toggle {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-panel-radius);
      cursor: pointer;
      color: var(--sk-text-muted);
      font-size: var(--sk-text-sm);
      width: 100%;
      text-align: left;
    }
    .sk-collapsible__toggle:hover { color: var(--sk-text); }
    .sk-collapsible__body {
      display: none;
    }
    .sk-collapsible--open .sk-collapsible__body {
      display: block;
    }

    /* ── Modal ── */
    .sk-modal {
      display: none;
      position: fixed;
      inset: 0;
      z-index: var(--sk-z-modal);
      background: rgba(0, 0, 0, 0.7);
      justify-content: center;
      align-items: center;
      padding: var(--sk-space-8);
    }
    .sk-modal--open { display: flex; }
    .sk-modal__content {
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-panel-radius);
      max-width: 800px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
    }
    .sk-modal__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--sk-space-3) var(--sk-space-4);
      border-bottom: 1px solid var(--sk-border);
    }
    .sk-modal__body {
      padding: var(--sk-space-4);
    }

    /* ── Dropdown ── */
    .sk-dropdown {
      position: relative;
    }
    .sk-dropdown__menu {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      z-index: var(--sk-z-dropdown);
      background: var(--sk-surface-3);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-panel-radius);
      min-width: 180px;
      padding: var(--sk-space-1) 0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    /* When a dropdown lives in the right side of the navbar, anchor its menu to the
       right edge of the trigger so a 180px panel stays inside the viewport instead
       of overflowing off-screen. */
    .sk-navbar__right .sk-dropdown__menu { left: auto; right: 0; }
    .sk-dropdown.open .sk-dropdown__menu { display: block; }
    .sk-dropdown__item {
      display: block;
      padding: var(--sk-space-2) var(--sk-space-3);
      color: var(--sk-text-muted);
      font-size: var(--sk-text-sm);
      white-space: nowrap;
    }
    .sk-dropdown__item:hover { background: var(--sk-surface-4); color: var(--sk-text); }
  `;
}
