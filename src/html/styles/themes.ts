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

import { isExperimental } from "../../config/feature-flags";

export interface Theme {
  id: string;
  label: string;
  /** Sparse override map. Empty for the default theme. */
  vars: Record<string, string>;
  /** Only selectable/emitted when the experimental flag is on. */
  experimental?: boolean;
}

/** Themes available given the current experimental flag. */
function availableThemes(): Theme[] {
  return isExperimental() ? THEMES : THEMES.filter((t) => !t.experimental);
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
      "--sk-btn-radius": "5px",
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
  {
    id: "win95",
    label: "Windows 95",
    vars: {
      "--sk-surface-0": "#001820",
      "--sk-surface-1": "#002830",
      "--sk-surface-2": "#003040",
      "--sk-surface-3": "#004050",
      "--sk-surface-4": "#005868",
      "--sk-panel-bg": "#002830",
      "--sk-panel-elevated-bg": "#004050",
      "--sk-text": "#ffffff",
      "--sk-text-muted": "#c0c0c0",
      "--sk-text-subtle": "rgba(192, 192, 192, 0.6)",
      "--sk-accent-primary": "#0078d4",
      "--sk-accent-primary-container": "#005a9e",
      "--sk-accent-primary-dim": "rgba(0, 120, 212, 0.3)",
      "--sk-accent-secondary": "#c0c0c0",
      "--sk-accent-secondary-container": "#1a1a2e",
      "--sk-accent-secondary-dim": "rgba(192, 192, 192, 0.2)",
      "--sk-accent-tertiary": "#00a86b",
      "--sk-accent-tertiary-dim": "rgba(0, 168, 107, 0.2)",
      "--sk-accent-warning": "#ffcc00",
      "--sk-accent-danger": "#ff4444",
      "--sk-border": "rgba(192, 192, 192, 0.2)",
      "--sk-border-subtle": "rgba(192, 192, 192, 0.3)",
      "--sk-border-active": "rgba(0, 120, 212, 0.5)",
      "--sk-glow-primary": "0 0 0 transparent",
      "--sk-glow-secondary": "0 0 0 transparent",
      "--sk-font-body": "'MS Sans Serif', Tahoma, Arial, sans-serif",
      "--sk-font-heading": "'MS Sans Serif', Tahoma, Arial, sans-serif",
      "--sk-radius-xs": "0px",
      "--sk-radius-sm": "0px",
      "--sk-radius-md": "1px",
      "--sk-radius-lg": "1px",
      "--sk-panel-radius": "0px",
      "--on-primary": "#ffffff",
      "--void": "#001820",
      "--surface-low": "#002830",
      "--surface-mid": "#003040",
      "--surface-high": "#004050",
      "--surface-bright": "#005868",
      "--panel": "rgba(0, 40, 48, 0.95)",
      "--panel-alt": "rgba(0, 24, 32, 0.95)",
      "--text": "#ffffff",
      "--muted": "#c0c0c0",
      "--border": "rgba(192, 192, 192, 0.2)",
      "--accent-cyan": "#c0c0c0",
      "--accent-magenta": "#0078d4",
      "--accent-yellow": "#ffcc00",
      "--glow": "0 0 0 transparent",
      "--glow-cyan": "0 0 0 transparent",
    },
  },
  {
    id: "geocities",
    label: "VibeCat",
    experimental: true,
    vars: {
      // Retro web 1.0 feel — muted navy/teal surfaces, softened clashing accents, Comic Sans.
      "--sk-surface-0": "#1a1a3d",
      "--sk-surface-1": "#222250",
      "--sk-surface-2": "#2a2a60",
      "--sk-surface-3": "#343472",
      "--sk-surface-4": "#404086",
      "--sk-panel-bg": "#222250",
      "--sk-panel-elevated-bg": "#2a2a60",
      "--sk-text": "#f0e6b0",
      "--sk-text-muted": "#9ad3a0",
      "--sk-text-subtle": "rgba(140, 200, 210, 0.7)",
      "--sk-accent-primary": "#d36fc4",
      "--sk-accent-primary-container": "#a8549a",
      "--sk-accent-primary-dim": "rgba(211, 111, 196, 0.25)",
      "--sk-accent-secondary": "#5fc8c8",
      "--sk-accent-secondary-container": "#173d3d",
      "--sk-accent-secondary-dim": "rgba(95, 200, 200, 0.2)",
      "--sk-accent-tertiary": "#7ec77e",
      "--sk-accent-tertiary-dim": "rgba(126, 199, 126, 0.2)",
      "--sk-accent-warning": "#e0a050",
      "--sk-accent-danger": "#e05555",
      "--sk-border": "rgba(211, 111, 196, 0.3)",
      "--sk-border-subtle": "rgba(95, 200, 200, 0.3)",
      "--sk-border-active": "rgba(224, 198, 110, 0.45)",
      "--sk-glow-primary": "0 0 0.5rem rgba(211, 111, 196, 0.3), 0 0 1rem rgba(95, 200, 200, 0.18)",
      "--sk-glow-secondary": "0 0 0.5rem rgba(95, 200, 200, 0.3), 0 0 1rem rgba(224, 198, 110, 0.18)",
      "--sk-font-body": "'Comic Sans MS', 'Comic Sans', 'Chalkboard SE', cursive",
      "--sk-font-heading": "'Comic Sans MS', 'Comic Sans', 'Chalkboard SE', cursive",
      "--sk-radius-xs": "0px",
      "--sk-radius-sm": "0px",
      "--sk-radius-md": "0px",
      "--sk-radius-lg": "0px",
      "--sk-panel-radius": "0px",
      "--on-primary": "#1a1a3d",
      "--void": "#1a1a3d",
      "--surface-low": "#222250",
      "--surface-mid": "#2a2a60",
      "--surface-high": "#343472",
      "--surface-bright": "#404086",
      "--panel": "rgba(34, 34, 80, 0.97)",
      "--panel-alt": "rgba(26, 26, 61, 0.97)",
      "--text": "#f0e6b0",
      "--muted": "#9ad3a0",
      "--border": "rgba(211, 111, 196, 0.3)",
      "--accent-cyan": "#5fc8c8",
      "--accent-magenta": "#d36fc4",
      "--accent-yellow": "#e0c66e",
      "--glow": "0 0 0.5rem rgba(211, 111, 196, 0.3), 0 0 1rem rgba(95, 200, 200, 0.18)",
      "--glow-cyan": "0 0 0.5rem rgba(95, 200, 200, 0.3), 0 0 1rem rgba(224, 198, 110, 0.18)",
    },
  },
];

/**
 * Emit `[data-theme="<id>"] { --var: value; ... }` blocks for every theme that has
 * overrides. The default theme is intentionally skipped — its values are already in
 * `:root` so `<html data-theme="default">` is a no-op.
 */
export function themesCss(): string {
  return availableThemes()
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
  const options = availableThemes().map(
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

export function themeOverridesCss(): string {
  return win95OverridesCss() + (isExperimental() ? geocitiesOverridesCss() : "");
}

function geocitiesOverridesCss(): string {
  const G = '[data-theme="geocities"]';
  return `
    /* ══ GeoCities '96 — maximum cringe, peak web 1.0 ══ */

    @keyframes sk-geo-rainbow {
      0%   { color: #d36fc4; }
      25%  { color: #e0c66e; }
      50%  { color: #7ec77e; }
      75%  { color: #5fc8c8; }
      100% { color: #d36fc4; }
    }

    /* Subtle tiled starfield void behind everything */
    ${G} body {
      background-color: #1a1a3d;
      background-image:
        radial-gradient(1px 1px at 24px 32px, rgba(255,255,255,0.5), transparent),
        radial-gradient(1px 1px at 96px 72px, rgba(224,198,110,0.5), transparent),
        radial-gradient(1px 1px at 132px 124px, rgba(95,200,200,0.5), transparent);
      background-size: 170px 210px;
    }

    /* Pinned mascot gif, bottom-right corner */
    ${G} body::after {
      content: '';
      position: fixed;
      bottom: 0;
      right: 0;
      width: 160px;
      height: 160px;
      z-index: 2147483647;
      pointer-events: none;
      transform: scaleX(-1);
      background: url('https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExdTBmNnA2am5qdm0xNm9oenVtNmh2ZWZ2N2IwcTM5dGs4d2IzeHl2cCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/nWolkCULqLT4oG9dph/giphy.gif') right bottom / contain no-repeat;
    }

    /* Escalation alert — swap the "!" for the VibeCat gif (this theme only, CSS-only) */
    ${G} .esc-alert-bang {
      display: inline-block;
      width: 24px;
      height: 24px;
      font-size: 0;
      line-height: 0;
      color: transparent;
      overflow: hidden;
      vertical-align: middle;
      background: url('https://media.tenor.com/QUSMUwP4DX4AAAAj/plink-cat-blink.gif') center / contain no-repeat;
    }

    /* Everything Comic Sans, no rounding, hard edges */
    ${G},
    ${G} * { font-family: 'Comic Sans MS', 'Comic Sans', 'Chalkboard SE', cursive !important; }

    /* Panel / window title bars — softened gradient + ridge border */
    ${G} .sk-panel,
    ${G} .card,
    ${G} .stat-card,
    ${G} .mc-stat-card,
    ${G} .panel {
      border: 3px ridge rgba(211, 111, 196, 0.55);
      border-radius: 0;
      box-shadow: none;
    }
    ${G} .sk-panel__header,
    ${G} .sk-modal__header,
    ${G} .mc-terminal__header,
    ${G} .mc-chat-panel__header {
      background: linear-gradient(90deg, #d36fc4, #e0c66e, #7ec77e, #5fc8c8);
      color: #1a1a3d;
      font-weight: 700;
      text-shadow: 1px 1px 0 rgba(255,255,255,0.4);
    }
    ${G} .sk-panel__header *,
    ${G} .sk-modal__header *,
    ${G} .mc-terminal__header *,
    ${G} .mc-chat-panel__header * { color: #1a1a3d; }

    /* Headings gently rainbow-cycle like a tasteful <marquee> dream */
    ${G} h1,
    ${G} h2,
    ${G} .sk-navbar__brand {
      animation: sk-geo-rainbow 8s ease-in-out infinite;
      text-shadow: 1px 1px 0 rgba(0,0,0,0.4);
      font-weight: 700;
    }

    /* Buttons — chunky outset bevels, muted */
    ${G} .sk-btn,
    ${G} button,
    ${G} .btn {
      border: 3px outset rgba(95, 200, 200, 0.6);
      border-radius: 0;
      background: #2a2a60;
      color: #f0e6b0;
      box-shadow: none;
      transition: none;
    }
    ${G} .sk-btn:hover,
    ${G} button:hover,
    ${G} .btn:hover {
      background: #d36fc4;
      color: #1a1a3d;
    }
    ${G} .sk-btn:active,
    ${G} button:active,
    ${G} .btn:active { border-style: inset; }
    ${G} .sk-btn--primary { background: #d36fc4; color: #1a1a3d; }

    /* Links — the one true 1996 hyperlink: blue and underlined (softened) */
    ${G} a { color: #7fa8ff; text-decoration: underline; }
    ${G} a:visited { color: #b78fd0; }
    ${G} a:hover { color: #e0a050; }

    /* Button-style links shouldn't inherit the hyperlink color/underline */
    ${G} a.sk-btn,
    ${G} a.btn,
    ${G} a.btn-sm,
    ${G} .mc-sidebar__create {
      color: #1a1a3d;
      text-decoration: none;
    }
    ${G} a.sk-btn:visited,
    ${G} a.btn:visited,
    ${G} .mc-sidebar__create:visited { color: #1a1a3d; }
    ${G} .mc-sidebar__create:hover { color: #1a1a3d; }

    /* Inputs — sunken retro */
    ${G} .sk-input,
    ${G} .sk-select,
    ${G} .sk-textarea,
    ${G} input,
    ${G} textarea,
    ${G} select {
      border: 3px inset rgba(126, 199, 126, 0.55);
      border-radius: 0;
      background: #1a1a3d;
      color: #f0e6b0;
    }

    /* Navbar — retro bar with a hard edge */
    ${G} .sk-navbar {
      background: #2a2a60;
      border-bottom: 3px ridge rgba(224, 198, 110, 0.6);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    /* Badges / pills — flat */
    ${G} .sk-badge { border-radius: 0; border: 2px solid rgba(224, 198, 110, 0.6); }

    /* Escalation bar — hard-edged retro alert (no seizure-inducing blink) */
    ${G} .sk-escalation-bar {
      border-radius: 0;
      border: 3px solid rgba(224, 85, 85, 0.7);
    }
  `;
}

function win95OverridesCss(): string {
  const W = '[data-theme="win95"]';
  return `
    /* ══ Windows 95 Dark — beveled borders & flat chrome ══ */

    /* ── V1 legacy buttons (button, .btn, .btn-sm, .btn-link, variants) ── */
    ${W} button,
    ${W} .btn,
    ${W} .btn-sm,
    ${W} .btn-link {
      background: #004050;
      border: none;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      border-radius: 0;
      box-shadow: none;
      transition: none;
    }
    ${W} button:hover,
    ${W} .btn:hover,
    ${W} .btn-link:hover {
      background: #005060;
      box-shadow: none;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
    }
    ${W} button:active,
    ${W} .btn:active {
      opacity: 1;
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
    }
    ${W} .btn-secondary,
    ${W} .btn-danger,
    ${W} .btn-warning {
      background: #003040;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      box-shadow: none;
    }
    ${W} .btn-secondary:hover,
    ${W} .btn-danger:hover,
    ${W} .btn-warning:hover {
      background: #004050;
      box-shadow: none;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
    }
    ${W} .btn-danger { color: var(--sk-accent-danger); }
    ${W} .toggle-btn {
      border-radius: 0;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
    }
    ${W} .daemon-kill-btn {
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      border-radius: 0;
    }
    ${W} .conv-action-btn {
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      border-radius: 0;
    }

    /* ── Chat panel buttons ── */
    ${W} .mc-chat-panel .btn-sm,
    ${W} .mc-chat-panel button[type="submit"] {
      background: #004050;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      border-radius: 0;
      box-shadow: none;
    }
    ${W} .mc-chat-panel .btn-sm:hover,
    ${W} .mc-chat-panel button[type="submit"]:hover {
      background: #005060;
      box-shadow: none;
    }
    ${W} .mc-chat-panel .chat-input-row button[type="submit"] {
      background: #0078d4;
      color: #ffffff;
    }

    /* ── Sidebar create button ── */
    ${W} .mc-sidebar__create {
      background: #0078d4;
      color: #ffffff;
      border: none;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      border-radius: 0;
    }
    ${W} .mc-sidebar__create:hover { opacity: 1; background: #005a9e; }
    ${W} .mc-sidebar__create:active {
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
    }

    /* ── Remove all glass/blur ── */
    ${W} .sk-navbar,
    ${W} .sk-btn,
    ${W} .sk-panel,
    ${W} .sk-modal__content,
    ${W} .mc-sidebar,
    ${W} .mc-terminal,
    ${W} .mc-steer-card,
    ${W} .mc-stat-card,
    ${W} .mc-chat-panel,
    ${W} .mc-task-header,
    ${W} .card,
    ${W} .stat-card,
    ${W} .panel {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: none;
    }

    /* ── V1 cards/panels — raised look ── */
    ${W} .card,
    ${W} .stat-card,
    ${W} .active-task-card,
    ${W} .phase-stepper,
    ${W} .team-hero,
    ${W} .phase-card,
    ${W} .member-card,
    ${W} .activity-feed {
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      border-radius: 0;
    }

    /* ── V1 inputs/textareas — sunken ── */
    ${W} input[type="text"],
    ${W} input[type="number"],
    ${W} input[type="password"],
    ${W} input[type="email"],
    ${W} input[type="url"],
    ${W} input[type="search"],
    ${W} textarea,
    ${W} select {
      border: none;
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
      border-radius: 0;
      background: #001820;
    }

    /* ── Navbar — flat menu bar ── */
    ${W} .sk-navbar {
      background: #003040;
      border-top: 1px solid #a0a0a0;
      border-bottom: 2px solid #001010;
    }

    /* ── Raised elements (buttons, panels, cards, dropdowns) ── */
    ${W} .sk-btn {
      border: none;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      background: #004050;
      transition: none;
    }
    ${W} .sk-btn:hover {
      background: #005060;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
    }
    ${W} .sk-btn:active {
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
    }
    ${W} .sk-btn--primary {
      background: #0078d4;
      color: #ffffff;
    }
    ${W} .sk-btn--primary:hover { background: #005a9e; }
    ${W} .sk-btn--danger {
      border-top-color: #a0a0a0;
      border-left-color: #a0a0a0;
      border-bottom-color: #001010;
      border-right-color: #001010;
    }

    ${W} .sk-panel {
      border: none;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
    }

    /* ── Panel title bars — Win95 window chrome ── */
    ${W} .sk-panel__header {
      background: linear-gradient(90deg, #00007b, #0078d4);
      color: #ffffff;
      border-bottom: none;
      font-weight: 700;
    }
    ${W} .sk-panel__header * { color: #ffffff; }

    ${W} .sk-modal__header {
      background: linear-gradient(90deg, #00007b, #0078d4);
      color: #ffffff;
      font-weight: 700;
    }
    ${W} .sk-modal__header * { color: #ffffff; }

    /* ── Sunken elements (inputs, selects, textareas) ── */
    ${W} .sk-input,
    ${W} .sk-select,
    ${W} .sk-textarea {
      border: none;
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
      background: #001820;
      border-radius: 0;
    }

    /* ── Tables — sunken data area ── */
    ${W} .sk-table {
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
    }
    ${W} .sk-table thead th {
      background: #003040;
      border-bottom: 2px solid #a0a0a0;
    }

    /* ── Dropdown — raised with hard shadow ── */
    ${W} .sk-dropdown__menu {
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      background: #003040;
      box-shadow: 2px 2px 0 #000000;
    }

    /* ── Checkbox — square Win95 style ── */
    ${W} .sk-checkbox__toggle {
      width: 16px;
      height: 16px;
      border-radius: 0;
      background: #001820;
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
    }
    ${W} .sk-checkbox__toggle::after {
      display: none;
      width: auto;
      height: auto;
      background: transparent;
      border-radius: 0;
      transform: none;
    }
    ${W} .sk-checkbox input:checked + .sk-checkbox__toggle {
      background: #001820;
    }
    ${W} .sk-checkbox input:checked + .sk-checkbox__toggle::after {
      display: block;
      content: "\\2713";
      position: absolute;
      top: -2px;
      left: 1px;
      color: #ffffff;
      font-size: 12px;
      font-weight: bold;
      background: transparent;
      border-radius: 0;
      transform: none;
    }

    /* ── Badges — flat, no glow ── */
    ${W} .sk-badge { border-radius: 0; }

    /* ── Phase card numbers — square ── */
    ${W} .sk-phase-card__number,
    ${W} .sk-phase-edit__number { border-radius: 0; }

    /* ══ Mission Control ══ */

    /* Workspace */
    ${W} .mc-workspace { background: #001820; }

    /* Sidebar */
    ${W} .mc-sidebar {
      background: #002830;
      border-right: 2px solid #001010;
    }
    ${W} .mc-sidebar__item:hover {
      background: #00007b;
      color: #ffffff;
    }
    ${W} .mc-sidebar__item--active {
      background: #0078d4;
      color: #ffffff;
    }

    /* Task header */
    ${W} .mc-task-header {
      background: #003040;
      border-bottom: 2px solid #001010;
    }

    /* Steer card — raised */
    ${W} .mc-steer-card {
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      background: #003040;
      border-radius: 0;
    }
    ${W} .mc-steer-card:hover { background: #004050; }
    ${W} .mc-steer-card__input {
      background: #001820;
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
      border-radius: 0;
    }

    /* Tabs — flat, no pill */
    ${W} .mc-tab { border-radius: 0; }
    ${W} .mc-tab--active {
      background: #003040;
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-right: 2px solid #001010;
      border-bottom: 2px solid #003040;
      border-radius: 0;
    }
    ${W} .mc-tabs { background: #002830; }

    /* Activity feed */
    ${W} .mc-outputs__col-body {
      background: #002830;
      border-radius: 0;
    }
    ${W} .mc-activity__controls { background: #003040; }
    ${W} .mc-activity__filter { border-radius: 0; }
    ${W} .mc-activity__filter--active { border-radius: 0; }
    ${W} .mc-activity__kind { border-radius: 0; }

    /* Notes */
    ${W} .note-item {
      background: #003040;
      border-radius: 0;
      border: 1px solid rgba(192, 192, 192, 0.15);
    }
    ${W} .note-item-user {
      background: rgba(0, 120, 212, 0.1);
      border-radius: 0;
    }

    /* Agent row */
    ${W} .mc-agent-row {
      background: #003040;
      border-radius: 0;
      border: 1px solid rgba(192, 192, 192, 0.15);
    }

    /* Terminal — sunken */
    ${W} .mc-terminal {
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
      background: #001820;
      border-radius: 0;
    }
    ${W} .mc-terminal__header {
      background: linear-gradient(90deg, #00007b, #0078d4);
      color: #ffffff;
      border-radius: 0;
      font-weight: 700;
    }
    ${W} .mc-terminal__header * { color: #ffffff; }

    /* Phase stepper */
    ${W} .mc-phase-stepper { background: #002830; }

    /* Stat cards — raised */
    ${W} .mc-stat-card {
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
      background: #003040;
      border-radius: 0;
    }

    /* Idle dashboard */
    ${W} .mc-idle { background: #001820; }
    ${W} .mc-idle__input,
    ${W} .mc-idle__desc {
      background: #001820;
      border-top: 2px solid #001010;
      border-left: 2px solid #001010;
      border-bottom: 2px solid #a0a0a0;
      border-right: 2px solid #a0a0a0;
      border-radius: 0;
    }
    ${W} .mc-idle__feed-item {
      background: #003040;
      border-radius: 0;
      margin-bottom: 2px;
    }
    ${W} .mc-idle__feed-item:hover { background: #004050; }

    /* Chat panel */
    ${W} .mc-chat-panel {
      background: #002830;
      border-left: 2px solid #a0a0a0;
    }
    ${W} .mc-chat-panel__header {
      background: linear-gradient(90deg, #00007b, #0078d4);
      color: #ffffff;
      font-weight: 700;
    }
    ${W} .mc-chat-panel__header * { color: #ffffff; }

    /* Escalation bar */
    ${W} .sk-escalation-bar { border-radius: 0; }

    /* Mission/create cards */
    ${W} .sk-mission,
    ${W} .sk-create-card {
      border-top: 2px solid #a0a0a0;
      border-left: 2px solid #a0a0a0;
      border-bottom: 2px solid #001010;
      border-right: 2px solid #001010;
    }
  `;
}

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
      border-radius: var(--sk-btn-radius);
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
    /* No backdrop-filter here: it would create a stacking context that traps the
       taskbar agent orbs' count badge below the global 3D cube canvas (which is
       fixed at z-index 5 and must paint over the header for the cubes to show).
       A slightly more opaque solid bg keeps the frosted look without the trap. */
    ${G} .mc-task-header {
      background: rgba(12, 16, 24, 0.72);
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
      border-radius: var(--sk-btn-radius);
    }
    ${G} .mc-tab--active {
      background: rgba(110, 196, 255, 0.1);
      border-radius: var(--sk-btn-radius);
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
      border-radius: var(--sk-btn-radius);
    }
    ${G} .mc-activity__filter--active {
      border-radius: var(--sk-btn-radius);
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
