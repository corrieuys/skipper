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
