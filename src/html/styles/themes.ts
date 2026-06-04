/**
 * Named color themes for the Skipper UI.
 *
 * Each theme is a sparse map of CSS custom property overrides. The default theme is
 * the values declared in `:root` by `tokens()` and `baseStyles()` — it carries no
 * overrides here. Other themes emit a `[data-theme="<id>"]` block that gets appended
 * AFTER the base `:root` declarations so attribute-selector specificity ties are
 * resolved by source order (later wins).
 *
 * To switch themes at runtime, set `document.documentElement.dataset.theme = "<id>"`.
 * The boot script in `theme-script.ts` reads `localStorage` and applies it before the
 * page paints to avoid FOUC.
 */

export interface Theme {
  id: string;
  label: string;
  /** Sparse override map. Empty for the default theme. */
  vars: Record<string, string>;
}

export const DEFAULT_THEME_ID = "default";

export const THEMES: Theme[] = [
  {
    id: "default",
    label: "Neon Pink",
    vars: {},
  },
  {
    id: "cyan",
    label: "Cyan Storm",
    vars: {
      "--sk-accent-primary": "#00fbfb",
      "--sk-accent-primary-container": "#00d4d4",
      "--sk-accent-primary-dim": "rgba(0, 251, 251, 0.25)",
      "--sk-accent-secondary": "#ff89ab",
      "--sk-accent-secondary-container": "#3d0018",
      "--sk-accent-secondary-dim": "rgba(255, 137, 171, 0.2)",
      "--sk-glow-primary": "0 0 0.6rem rgba(0, 251, 251, 0.3), 0 0 1.2rem rgba(0, 251, 251, 0.15)",
      "--sk-glow-secondary": "0 0 0.6rem rgba(255, 137, 171, 0.2), 0 0 1.2rem rgba(255, 137, 171, 0.1)",
      "--sk-border-active": "rgba(0, 251, 251, 0.2)",
      "--on-primary": "#001f1f",
      // v1 literals that bypass tokens() aliases
      "--accent-cyan": "#ff89ab",
      "--accent-magenta": "#00fbfb",
      "--glow": "0 0 0.6rem rgba(0, 251, 251, 0.3), 0 0 1.2rem rgba(0, 251, 251, 0.15)",
      "--glow-cyan": "0 0 0.6rem rgba(255, 137, 171, 0.2), 0 0 1.2rem rgba(255, 137, 171, 0.1)",
    },
  },
  {
    id: "matrix",
    label: "Matrix",
    vars: {
      "--sk-accent-primary": "#b0ff96",
      "--sk-accent-primary-container": "#8be074",
      "--sk-accent-primary-dim": "rgba(176, 255, 150, 0.25)",
      "--sk-accent-secondary": "#ffd080",
      "--sk-accent-secondary-container": "#3d2700",
      "--sk-accent-secondary-dim": "rgba(255, 208, 128, 0.2)",
      "--sk-accent-tertiary": "#00fbfb",
      "--sk-accent-tertiary-dim": "rgba(0, 251, 251, 0.2)",
      "--sk-glow-primary": "0 0 0.6rem rgba(176, 255, 150, 0.3), 0 0 1.2rem rgba(176, 255, 150, 0.15)",
      "--sk-glow-secondary": "0 0 0.6rem rgba(255, 208, 128, 0.2), 0 0 1.2rem rgba(255, 208, 128, 0.1)",
      "--sk-border-active": "rgba(176, 255, 150, 0.2)",
      "--on-primary": "#0a2400",
      "--accent-cyan": "#ffd080",
      "--accent-magenta": "#b0ff96",
      "--glow": "0 0 0.6rem rgba(176, 255, 150, 0.3), 0 0 1.2rem rgba(176, 255, 150, 0.15)",
      "--glow-cyan": "0 0 0.6rem rgba(255, 208, 128, 0.2), 0 0 1.2rem rgba(255, 208, 128, 0.1)",
    },
  },
  {
    id: "synthwave",
    label: "Synthwave",
    vars: {
      "--sk-accent-primary": "#b389ff",
      "--sk-accent-primary-container": "#9070ff",
      "--sk-accent-primary-dim": "rgba(179, 137, 255, 0.25)",
      "--sk-accent-secondary": "#ff80c0",
      "--sk-accent-secondary-container": "#3d0024",
      "--sk-accent-secondary-dim": "rgba(255, 128, 192, 0.2)",
      "--sk-glow-primary": "0 0 0.6rem rgba(179, 137, 255, 0.3), 0 0 1.2rem rgba(179, 137, 255, 0.15)",
      "--sk-glow-secondary": "0 0 0.6rem rgba(255, 128, 192, 0.2), 0 0 1.2rem rgba(255, 128, 192, 0.1)",
      "--sk-border-active": "rgba(179, 137, 255, 0.2)",
      "--on-primary": "#180033",
      "--accent-cyan": "#ff80c0",
      "--accent-magenta": "#b389ff",
      "--glow": "0 0 0.6rem rgba(179, 137, 255, 0.3), 0 0 1.2rem rgba(179, 137, 255, 0.15)",
      "--glow-cyan": "0 0 0.6rem rgba(255, 128, 192, 0.2), 0 0 1.2rem rgba(255, 128, 192, 0.1)",
    },
  },
  {
    id: "amber",
    label: "Amber Console",
    vars: {
      "--sk-accent-primary": "#ffb547",
      "--sk-accent-primary-container": "#ff9518",
      "--sk-accent-primary-dim": "rgba(255, 181, 71, 0.25)",
      "--sk-accent-secondary": "#a0e1ff",
      "--sk-accent-secondary-container": "#003047",
      "--sk-accent-secondary-dim": "rgba(160, 225, 255, 0.2)",
      "--sk-glow-primary": "0 0 0.6rem rgba(255, 181, 71, 0.3), 0 0 1.2rem rgba(255, 181, 71, 0.15)",
      "--sk-glow-secondary": "0 0 0.6rem rgba(160, 225, 255, 0.2), 0 0 1.2rem rgba(160, 225, 255, 0.1)",
      "--sk-border-active": "rgba(255, 181, 71, 0.2)",
      "--on-primary": "#2b1500",
      "--accent-cyan": "#a0e1ff",
      "--accent-magenta": "#ffb547",
      "--glow": "0 0 0.6rem rgba(255, 181, 71, 0.3), 0 0 1.2rem rgba(255, 181, 71, 0.15)",
      "--glow-cyan": "0 0 0.6rem rgba(160, 225, 255, 0.2), 0 0 1.2rem rgba(160, 225, 255, 0.1)",
    },
  },
  {
    id: "mono",
    label: "Monochrome",
    vars: {
      // Bright off-white primary, dimmer gray secondary — no chroma anywhere.
      "--sk-accent-primary": "#e5e5e5",
      "--sk-accent-primary-container": "#ffffff",
      "--sk-accent-primary-dim": "rgba(229, 229, 229, 0.2)",
      "--sk-accent-secondary": "#9a9a9a",
      "--sk-accent-secondary-container": "#2a2a2a",
      "--sk-accent-secondary-dim": "rgba(154, 154, 154, 0.18)",
      "--sk-accent-tertiary": "#cccccc",
      "--sk-accent-tertiary-dim": "rgba(204, 204, 204, 0.18)",
      "--sk-accent-warning": "#d0d0d0",
      // Subdue glows so monochrome stays flat rather than glowing white.
      "--sk-glow-primary": "0 0 0.4rem rgba(229, 229, 229, 0.18), 0 0 0.9rem rgba(229, 229, 229, 0.08)",
      "--sk-glow-secondary": "0 0 0.4rem rgba(154, 154, 154, 0.15), 0 0 0.9rem rgba(154, 154, 154, 0.08)",
      "--sk-border-active": "rgba(229, 229, 229, 0.22)",
      "--on-primary": "#000000",
      "--accent-cyan": "#9a9a9a",
      "--accent-magenta": "#e5e5e5",
      "--accent-yellow": "#d0d0d0",
      "--glow": "0 0 0.4rem rgba(229, 229, 229, 0.18), 0 0 0.9rem rgba(229, 229, 229, 0.08)",
      "--glow-cyan": "0 0 0.4rem rgba(154, 154, 154, 0.15), 0 0 0.9rem rgba(154, 154, 154, 0.08)",
    },
  },
  {
    id: "dusk",
    label: "Dusk",
    vars: {
      "--sk-surface-0": "#1a0f0a",
      "--sk-surface-1": "#211510",
      "--sk-surface-2": "#2a1c15",
      "--sk-surface-3": "#362519",
      "--sk-surface-4": "#4a3425",
      "--sk-panel-bg": "#211510",
      "--sk-panel-elevated-bg": "#362519",
      "--sk-text": "#f0e4da",
      "--sk-text-muted": "#b8a08a",
      "--sk-text-subtle": "rgba(184, 160, 138, 0.6)",
      "--sk-accent-primary": "#ff9dae",
      "--sk-accent-primary-container": "#e07888",
      "--sk-accent-primary-dim": "rgba(255, 157, 174, 0.25)",
      "--sk-accent-secondary": "#e8c88a",
      "--sk-accent-secondary-container": "#3d2d10",
      "--sk-accent-secondary-dim": "rgba(232, 200, 138, 0.2)",
      "--sk-accent-tertiary": "#a0d4a0",
      "--sk-accent-tertiary-dim": "rgba(160, 212, 160, 0.2)",
      "--sk-accent-warning": "#e8c88a",
      "--sk-border": "rgba(184, 160, 138, 0.12)",
      "--sk-border-subtle": "rgba(184, 160, 138, 0.2)",
      "--sk-border-active": "rgba(255, 157, 174, 0.25)",
      "--sk-glow-primary": "0 0 0.6rem rgba(255, 157, 174, 0.25), 0 0 1.2rem rgba(255, 157, 174, 0.1)",
      "--sk-glow-secondary": "0 0 0.6rem rgba(232, 200, 138, 0.2), 0 0 1.2rem rgba(232, 200, 138, 0.1)",
      "--on-primary": "#2a0f14",
      "--void": "#1a0f0a",
      "--surface-low": "#211510",
      "--surface-mid": "#2a1c15",
      "--surface-high": "#362519",
      "--surface-bright": "#4a3425",
      "--panel": "rgba(33, 21, 16, 0.95)",
      "--panel-alt": "rgba(26, 15, 10, 0.95)",
      "--text": "#f0e4da",
      "--muted": "#b8a08a",
      "--border": "rgba(184, 160, 138, 0.12)",
      "--accent-cyan": "#e8c88a",
      "--accent-magenta": "#ff9dae",
      "--accent-yellow": "#e8c88a",
      "--glow": "0 0 0.6rem rgba(255, 157, 174, 0.25), 0 0 1.2rem rgba(255, 157, 174, 0.1)",
      "--glow-cyan": "0 0 0.6rem rgba(232, 200, 138, 0.2), 0 0 1.2rem rgba(232, 200, 138, 0.1)",
    },
  },
  {
    id: "artemis",
    label: "Artemis",
    vars: {
      "--sk-surface-0": "rgba(8, 10, 16, 0.6)",
      "--sk-surface-1": "rgba(12, 16, 24, 0.55)",
      "--sk-surface-2": "rgba(16, 20, 30, 0.5)",
      "--sk-surface-3": "rgba(22, 28, 38, 0.55)",
      "--sk-surface-4": "rgba(32, 38, 50, 0.5)",
      "--sk-panel-bg": "rgba(12, 16, 24, 0.55)",
      "--sk-panel-elevated-bg": "rgba(22, 28, 38, 0.55)",
      "--sk-text": "#e8eaef",
      "--sk-text-muted": "#a0a8b8",
      "--sk-text-subtle": "rgba(160, 168, 184, 0.6)",
      "--sk-accent-primary": "#6ec4ff",
      "--sk-accent-primary-container": "#4aa8e8",
      "--sk-accent-primary-dim": "rgba(110, 196, 255, 0.25)",
      "--sk-accent-secondary": "#90d4f0",
      "--sk-accent-secondary-container": "#0a2a3d",
      "--sk-accent-secondary-dim": "rgba(144, 212, 240, 0.2)",
      "--sk-accent-tertiary": "#80d8a0",
      "--sk-accent-tertiary-dim": "rgba(128, 216, 160, 0.2)",
      "--sk-accent-warning": "#ffc880",
      "--sk-panel-radius": "0.75rem",
      "--sk-radius-xs": "4px",
      "--sk-radius-sm": "6px",
      "--sk-radius-md": "10px",
      "--sk-radius-lg": "14px",
      "--sk-border": "rgba(160, 175, 200, 0.15)",
      "--sk-border-subtle": "rgba(160, 175, 200, 0.25)",
      "--sk-border-active": "rgba(110, 196, 255, 0.3)",
      "--sk-glow-primary": "0 0 0.6rem rgba(110, 196, 255, 0.3), 0 0 1.2rem rgba(110, 196, 255, 0.15)",
      "--sk-glow-secondary": "0 0 0.6rem rgba(144, 212, 240, 0.2), 0 0 1.2rem rgba(144, 212, 240, 0.1)",
      "--on-primary": "#001828",
      "--void": "rgba(8, 10, 16, 0.6)",
      "--surface-low": "rgba(12, 16, 24, 0.55)",
      "--surface-mid": "rgba(16, 20, 30, 0.5)",
      "--surface-high": "rgba(22, 28, 38, 0.55)",
      "--surface-bright": "rgba(32, 38, 50, 0.5)",
      "--panel": "rgba(12, 16, 24, 0.55)",
      "--panel-alt": "rgba(8, 10, 16, 0.6)",
      "--text": "#e8eaef",
      "--muted": "#a0a8b8",
      "--border": "rgba(160, 175, 200, 0.15)",
      "--accent-cyan": "#90d4f0",
      "--accent-magenta": "#6ec4ff",
      "--accent-yellow": "#ffc880",
      "--glow": "0 0 0.6rem rgba(110, 196, 255, 0.3), 0 0 1.2rem rgba(110, 196, 255, 0.15)",
      "--glow-cyan": "0 0 0.6rem rgba(144, 212, 240, 0.2), 0 0 1.2rem rgba(144, 212, 240, 0.1)",
    },
  },
];

/**
 * Emit `[data-theme="<id>"] { --var: value; ... }` blocks for every theme that has
 * overrides. The default theme is intentionally skipped — its values are already in
 * `:root` so `<html data-theme="default">` is a no-op.
 */
export function themesCss(): string {
  return THEMES
    .filter((t) => Object.keys(t.vars).length > 0)
    .map((t) => {
      const decls = Object.entries(t.vars).map(([k, v]) => `${k}: ${v};`).join(" ");
      return `[data-theme="${t.id}"] { ${decls} }`;
    })
    .join("\n");
}

/**
 * Inline boot script — included in `<head>` BEFORE the stylesheet so the
 * `data-theme` attribute is set on `<html>` before the first paint.
 *
 * Returns the JS body only; the caller wraps it in a `<script>` tag.
 */
export function themeBootScript(): string {
  return `(function(){try{var t=localStorage.getItem('skipper.theme');if(t===null){t='artemis';localStorage.setItem('skipper.theme',t);}if(t&&t!=='default')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
}

/**
 * Renders the theme picker control for use in any navbar. A `<select>` with one
 * option per theme, plus an inline boot script (idempotent via window flag) that
 * syncs the select to localStorage on load and applies + persists the selection
 * on change. The CSS class hooks into existing `.sk-` styles where available.
 */
export function themePickerFragment(): string {
  const options = THEMES.map(
    (t) => `<option value="${t.id}">${t.label}</option>`,
  ).join("");

  // Idempotent client wiring: guarded with __skipperThemeInit so multiple navbars on
  // one page (impossible today but cheap insurance) don't double-bind.
  const script = `<script>
(function(){
  if (window.__skipperThemeInit) return;
  window.__skipperThemeInit = true;
  function apply(id){
    if (id && id !== 'default') document.documentElement.setAttribute('data-theme', id);
    else document.documentElement.removeAttribute('data-theme');
  }
  var KEY = 'skipper.theme';
  document.addEventListener('change', function(e){
    var el = e.target;
    if (!el || el.getAttribute('data-skipper-theme-select') === null) return;
    var id = el.value || 'default';
    apply(id);
    try { localStorage.setItem(KEY, id); } catch(_){}
    // Mirror to any other theme selectors on the page.
    document.querySelectorAll('[data-skipper-theme-select]').forEach(function(sel){ if (sel !== el) sel.value = id; });
  });
  function sync(){
    var stored = '';
    try { stored = localStorage.getItem(KEY) || ''; } catch(_){}
    var id = stored || 'default';
    document.querySelectorAll('[data-skipper-theme-select]').forEach(function(sel){ sel.value = id; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync); else sync();
  // Re-sync after htmx body swaps so the dropdown reflects the active theme.
  document.addEventListener('htmx:afterSwap', sync);
})();
</script>`;

  // Inline styles use CSS vars that exist in both v1 and v2 layers so the picker
  // looks correct on legacy pages (which don't load skStyles()).
  const labelStyle = "display:inline-flex;align-items:center;gap:0.3rem;font-size:0.7rem;color:var(--muted,#adaaaa);";
  const selectStyle = "padding:0.25rem 0.45rem;font-size:0.7rem;background:var(--surface-mid,#131313);color:var(--text,#fff);border:1px solid var(--border,rgba(173,170,170,0.15));border-radius:0.25rem;cursor:pointer;";
  return `<label class="sk-theme-picker" title="Color theme" style="${labelStyle}">
    <select data-skipper-theme-select class="sk-select sk-select--sm sk-theme-picker__select" style="${selectStyle}">${options}</select>
  </label>${script}`;
}

export function themeOverridesCss(): string { return ""; }

export function glassOverridesCss(): string {
  const G = "[data-theme=\"artemis\"]";
  return `
    /* ── Base ── */
    ${G} body { background: transparent; }

    /* ── Navbar ── */
    ${G} .sk-navbar,
    ${G} .navbar {
      background: rgba(12, 16, 24, 0.5);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    /* ── Panels ── */
    ${G} .sk-panel {
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(160, 175, 200, 0.15);
    }
    ${G} .sk-container { background: transparent; }

    /* ── Dropdown & Modal ── */
    ${G} .sk-dropdown__menu {
      background: #161c28;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }
    ${G} .sk-modal__content {
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    /* ── Buttons ── */
    ${G} .sk-btn {
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: var(--sk-radius-md);
    }

    /* ── Forms ── */
    ${G} .sk-input,
    ${G} .sk-select,
    ${G} .sk-textarea {
      background: rgba(8, 10, 16, 0.4);
      border-radius: var(--sk-radius-md);
    }

    /* ── Tables ── */
    ${G} .sk-table thead th {
      background: rgba(12, 16, 24, 0.4);
    }

    /* ── v1 panels ── */
    ${G} .card,
    ${G} .stat-card,
    ${G} .panel {
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }

    /* ══ Mission Control ══ */

    /* Workspace */
    ${G} .mc-workspace { background: transparent; }

    /* Sidebar */
    ${G} .mc-sidebar {
      background: rgba(12, 16, 24, 0.45);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    ${G} .mc-sidebar__item:hover {
      background: rgba(160, 175, 200, 0.08);
    }
    ${G} .mc-sidebar__item--active {
      background: rgba(110, 196, 255, 0.08);
    }

    /* Task header */
    ${G} .mc-task-header {
      background: rgba(12, 16, 24, 0.4);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }

    /* Steer card */
    ${G} .mc-steer-card {
      background: rgba(16, 20, 30, 0.5);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 0;
      border: 1px solid rgba(160, 175, 200, 0.12);
    }
    ${G} .mc-steer-card:hover {
      background: rgba(16, 20, 30, 0.6);
    }
    ${G} .mc-steer-card__input {
      background: rgba(8, 10, 16, 0.5);
      border-radius: var(--sk-radius-md);
    }

    /* Tabs — pill-shaped */
    ${G} .mc-tab {
      border-radius: var(--sk-radius-lg);
    }
    ${G} .mc-tab--active {
      background: rgba(110, 196, 255, 0.1);
      border-radius: var(--sk-radius-lg);
    }
    ${G} .mc-tabs {
      background: rgba(12, 16, 24, 0.3);
    }

    /* Activity feed */
    ${G} .mc-outputs__col-body {
      background: rgba(12, 16, 24, 0.35);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 0 0 var(--sk-radius-md) var(--sk-radius-md);
    }
    ${G} .mc-activity__controls {
      background: rgba(12, 16, 24, 0.3);
    }
    ${G} .mc-activity__filter {
      border-radius: var(--sk-radius-md);
    }
    ${G} .mc-activity__filter--active {
      border-radius: var(--sk-radius-md);
    }
    ${G} .mc-activity__kind {
      border-radius: var(--sk-radius-sm);
    }

    /* Notes panel */
    ${G} .note-item {
      background: rgba(16, 20, 30, 0.5);
      border-radius: var(--sk-radius-md);
      border: 1px solid rgba(160, 175, 200, 0.1);
    }
    ${G} .note-item-user {
      background: rgba(110, 196, 255, 0.06);
      border-radius: var(--sk-radius-md);
    }

    /* Agent row */
    ${G} .mc-agent-row {
      background: rgba(16, 20, 30, 0.5);
      border-radius: var(--sk-radius-md);
      border: 1px solid rgba(160, 175, 200, 0.1);
    }

    /* Terminal */
    ${G} .mc-terminal {
      background: rgba(8, 10, 16, 0.5);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: var(--sk-radius-lg);
    }
    ${G} .mc-terminal__header {
      background: rgba(16, 20, 30, 0.4);
      border-radius: var(--sk-radius-lg) var(--sk-radius-lg) 0 0;
    }

    /* Phase stepper */
    ${G} .mc-phase-stepper {
      background: rgba(12, 16, 24, 0.3);
    }

    /* Badges — pill-shaped */
    ${G} .sk-badge {
      border-radius: var(--sk-radius-md);
    }

    /* Idle / dashboard cards */
    ${G} .mc-idle {
      background: transparent;
    }
    ${G} .mc-stat-card {
      background: rgba(16, 20, 30, 0.5);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(160, 175, 200, 0.1);
      border-radius: var(--sk-radius-lg);
    }
    ${G} .mc-idle__input,
    ${G} .mc-idle__desc {
      background: rgba(12, 16, 24, 0.5);
      border-radius: var(--sk-radius-md);
    }
    ${G} .mc-idle__feed-item {
      background: rgba(16, 20, 30, 0.4);
      border-radius: var(--sk-radius-md);
      margin-bottom: 2px;
    }
    ${G} .mc-idle__feed-item:hover {
      background: rgba(16, 20, 30, 0.55);
    }

    /* Chat panel */
    ${G} .mc-chat-panel {
      background: rgba(12, 16, 24, 0.45);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    ${G} .mc-chat-panel__header {
      background: rgba(16, 20, 30, 0.4);
    }

    /* Escalation bar */
    ${G} .sk-escalation-bar {
      border-radius: var(--sk-radius-lg);
    }

    /* Mission/create cards */
    ${G} .sk-mission,
    ${G} .sk-create-card {
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(160, 175, 200, 0.1);
    }
  `;
}

export function appearanceBackgroundCss(activeUrl: string): string {
  if (!activeUrl) return "";
  return `
    [data-theme="artemis"] body::before {
      content: '';
      position: fixed;
      inset: 0;
      z-index: -1;
      background: url('${activeUrl}') center / cover no-repeat fixed;
      background-color: #080a10;
    }
  `;
}
