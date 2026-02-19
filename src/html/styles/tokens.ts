/**
 * Design tokens for the Skipper UI.
 * Neon-Noir palette with sk- prefix. Backward-compatible aliases map to old variable names.
 */
export function tokens(): string {
  return `
    :root {
      /* ── Surfaces ── */
      --sk-surface-0: #000000;
      --sk-surface-1: #0e0e0e;
      --sk-surface-2: #131313;
      --sk-surface-3: #1a1919;
      --sk-surface-4: #2c2c2c;

      /* ── Text ── */
      --sk-text: #ffffff;
      --sk-text-muted: #adaaaa;
      --sk-text-subtle: rgba(173, 170, 170, 0.6);

      /* ── Accents ── */
      --sk-accent-primary: #ff89ab;
      --sk-accent-primary-dim: rgba(255, 137, 171, 0.25);
      --sk-accent-primary-container: #ff709e;
      --sk-accent-secondary: #00fbfb;
      --sk-accent-secondary-dim: rgba(0, 251, 251, 0.2);
      --sk-accent-secondary-container: #003f3f;
      --sk-accent-tertiary: #b0ff96;
      --sk-accent-tertiary-dim: rgba(176, 255, 150, 0.2);
      --sk-accent-warning: #ffd080;
      --sk-accent-danger: #ff6b6b;

      /* ── Borders ── */
      --sk-border: rgba(173, 170, 170, 0.08);
      --sk-border-subtle: rgba(173, 170, 170, 0.15);
      --sk-border-active: rgba(255, 137, 171, 0.2);

      /* ── Glows ── */
      --sk-glow-primary: 0 0 0.6rem rgba(255, 137, 171, 0.3), 0 0 1.2rem rgba(255, 112, 158, 0.15);
      --sk-glow-secondary: 0 0 0.6rem rgba(0, 251, 251, 0.2), 0 0 1.2rem rgba(0, 251, 251, 0.1);

      /* ── Spacing (4px base) ── */
      --sk-space-1: 0.25rem;
      --sk-space-2: 0.5rem;
      --sk-space-3: 0.75rem;
      --sk-space-4: 1rem;
      --sk-space-6: 1.5rem;
      --sk-space-8: 2rem;
      --sk-space-12: 3rem;

      /* ── Typography ── */
      --sk-font-body: "Inter", "Segoe UI", sans-serif;
      --sk-font-heading: "Space Grotesk", "Segoe UI", sans-serif;
      --sk-font-mono: "JetBrains Mono", monospace;

      --sk-text-xs: 0.6875rem;
      --sk-text-sm: 0.78rem;
      --sk-text-base: 0.875rem;
      --sk-text-lg: 1rem;
      --sk-text-xl: 1.15rem;
      --sk-text-2xl: 1.55rem;

      /* ── Z-index layers ── */
      --sk-z-navbar: 20;
      --sk-z-dropdown: 100;
      --sk-z-modal: 200;
      --sk-z-notification: 300;

      /* ── Panel system ── */
      --sk-panel-bg: var(--sk-surface-1);
      --sk-panel-elevated-bg: var(--sk-surface-3);
      --sk-panel-radius: 0.5rem;

      /* ── Corner-radius scale (themes override these to shift sharp/medium/soft feel) ── */
      --sk-radius-xs: 2px;
      --sk-radius-sm: 4px;
      --sk-radius-md: 6px;
      --sk-radius-lg: 10px;

      /* ══ Backward-compatible aliases (old variable names → new tokens) ══ */
      --void: var(--sk-surface-0);
      --surface-low: var(--sk-surface-1);
      --surface-mid: var(--sk-surface-2);
      --surface-high: var(--sk-surface-3);
      --surface-bright: var(--sk-surface-4);
      --primary: var(--sk-accent-primary);
      --primary-container: var(--sk-accent-primary-container);
      --primary-dim: var(--sk-accent-primary-dim);
      --on-primary: #3d0018;
      --secondary: var(--sk-accent-secondary);
      --secondary-container: var(--sk-accent-secondary-container);
      --secondary-dim: var(--sk-accent-secondary-dim);
      --tertiary: var(--sk-accent-tertiary);
      --tertiary-dim: var(--sk-accent-tertiary-dim);
      --on-secondary-container: #b0fdfd;
      --on-surface: var(--sk-text);
      --on-surface-variant: var(--sk-text-muted);
      --outline-variant: var(--sk-border-subtle);
      --ghost-border: var(--sk-border);
      --text: var(--sk-text);
      --muted: var(--sk-text-muted);
      --error: var(--sk-accent-danger);
      --success: var(--sk-accent-tertiary);
      --glow: var(--sk-glow-primary);
      --glow-cyan: var(--sk-glow-secondary);
      --bg-0: var(--sk-surface-0);
      --bg-1: var(--sk-surface-1);
      --bg-secondary: var(--sk-surface-2);
      --panel: rgba(14, 14, 14, 0.95);
      --panel-alt: rgba(0, 0, 0, 0.95);
      --accent-cyan: var(--sk-accent-secondary);
      --accent-magenta: var(--sk-accent-primary);
      --accent-yellow: var(--sk-accent-warning);
      --danger: var(--sk-accent-danger);
      --border: var(--sk-border);
    }
  `;
}
