/** Keyframes and transitions */
export function animationStyles(): string {
  return `
    @keyframes sk-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    @keyframes sk-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .sk-animate-pulse { animation: sk-pulse 2s ease-in-out infinite; }
    .sk-animate-fade-in { animation: sk-fade-in 0.2s ease-out; }

    /* Zen mode — crystal ball orb animations */
    @keyframes zen-float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-6px); }
    }
    @keyframes zen-glow {
      0%   { filter: hue-rotate(0deg) saturate(1.6) brightness(1.1); }
      33%  { filter: hue-rotate(35deg) saturate(1.8) brightness(1.2); }
      66%  { filter: hue-rotate(-25deg) saturate(1.7) brightness(1.15); }
      100% { filter: hue-rotate(0deg) saturate(1.6) brightness(1.1); }
    }
    @keyframes zen-shimmer {
      0%   { background-position: -200% center; }
      100% { background-position: 200% center; }
    }
    @keyframes zen-inner-swirl {
      0%   { transform: rotate(0deg) scale(1); opacity: 0.7; }
      50%  { transform: rotate(180deg) scale(1.1); opacity: 1; }
      100% { transform: rotate(360deg) scale(1); opacity: 0.7; }
    }

    /* Outer shell: banner at top, centered content fills the rest */
    .zen-view__outer {
      display: flex; flex-direction: column; height: 100%; overflow: hidden;
    }
    .zen-view__outer > .mc-escalation { flex-shrink: 0; }

    /* Zen view layout — fixed sizes prevent layout shift from HTMX polling */
    .zen-view {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: var(--sk-space-6) var(--sk-space-4);
      gap: var(--sk-space-5); flex: 1; min-height: 0; overflow-y: auto; text-align: center;
    }
    .zen-view__header { display: flex; flex-direction: column; align-items: center; gap: var(--sk-space-2); }
    .zen-view__title {
      margin: 0; font-size: 1.5rem; font-weight: 700; color: var(--sk-text);
      text-shadow: 0 0 30px color-mix(in srgb, var(--sk-accent-secondary) 25%, transparent),
                   0 0 60px color-mix(in srgb, var(--sk-accent-primary) 15%, transparent);
    }
    .zen-view__team { font-size: var(--sk-text-xs); color: var(--sk-text-muted); }
    .zen-view__phase { width: 100%; max-width: 600px; display: flex; justify-content: center; margin-bottom: var(--sk-space-3); }
    .zen-view__phase .mc-phase-stepper { background: transparent !important; border: none !important; border-bottom: none !important; }

    /* Crystal ball orbs — fixed wrapper sizes */
    .zen-view__orbs { display: flex; gap: var(--sk-space-5); flex-wrap: wrap; justify-content: center; padding: var(--sk-space-4) 0; min-height: 130px; }
    .zen-view__orb-wrapper { display: flex; flex-direction: column; align-items: center; gap: var(--sk-space-2); width: 120px; }
    .zen-view__orb-label {
      font-size: 11px; color: var(--sk-text-muted); width: 120px; text-align: center;
      word-wrap: break-word; overflow-wrap: break-word; line-height: 1.3;
    }

    .zen-orb {
      width: 90px; height: 90px; border-radius: 50%; position: relative; overflow: hidden;
      background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.35), color-mix(in srgb, var(--sk-accent-secondary) 12%, transparent) 40%, transparent 65%),
                  radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--sk-accent-secondary) 20%, rgba(60,65,80,0.95)), rgba(30,35,50,0.95));
      border: 1.5px solid color-mix(in srgb, var(--sk-accent-secondary) 20%, transparent);
      animation: zen-float 4s ease-in-out infinite;
      transition: filter 0.8s ease, opacity 0.8s ease, border-color 0.8s ease, box-shadow 0.8s ease;
    }
    .zen-orb__shine {
      position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
    }

    .zen-orb--active {
      background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.4), color-mix(in srgb, var(--sk-accent-secondary) 30%, transparent) 40%, transparent 65%),
                  radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--sk-accent-secondary) 25%, rgba(30,40,80,0.95)), rgba(20,25,50,0.98));
      border-color: color-mix(in srgb, var(--sk-accent-secondary) 50%, transparent);
      box-shadow: 0 0 20px color-mix(in srgb, var(--sk-accent-secondary) 30%, transparent),
                  0 0 40px color-mix(in srgb, var(--sk-accent-primary) 15%, transparent);
      animation: zen-float 3s ease-in-out infinite, zen-glow 6s ease-in-out infinite;
    }
    .zen-orb--active .zen-orb__shine {
      background: conic-gradient(from 0deg,
        color-mix(in srgb, var(--sk-accent-secondary) 40%, transparent),
        color-mix(in srgb, var(--sk-accent-primary) 45%, transparent),
        color-mix(in srgb, var(--sk-accent-tertiary) 35%, transparent),
        color-mix(in srgb, var(--sk-accent-secondary) 40%, transparent));
      animation: zen-inner-swirl 8s linear infinite;
    }
    .zen-orb--active::after {
      content: ''; position: absolute; inset: 10%; border-radius: 50%;
      background: linear-gradient(135deg, transparent 20%, color-mix(in srgb, var(--sk-accent-secondary) 40%, transparent) 50%, transparent 80%);
      background-size: 200% 200%;
      animation: zen-shimmer 3s linear infinite;
    }

    .zen-orb--inactive {
      filter: grayscale(0.8) brightness(0.6); opacity: 0.5;
      animation: zen-float 6s ease-in-out infinite;
      border-color: rgba(255,255,255,0.06);
    }

    /* Summary section — fixed min-height */
    .zen-view__summary {
      display: flex; flex-direction: column; align-items: center; gap: var(--sk-space-2);
      font-size: var(--sk-text-sm); color: var(--sk-text-muted); max-width: 500px; min-height: 60px;
    }
    .zen-view__summary-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sk-text-subtle); }

    /* Zen composer — realtime text input + audio record */
    .zen-view__composer {
      width: 100%; max-width: 600px; display: flex; flex-direction: column;
      gap: var(--sk-space-2); align-items: center; margin-bottom: var(--sk-space-2);
    }
    .zen-view__composer-form { width: 100%; display: flex; gap: var(--sk-space-2); align-items: center; }
    .zen-view__composer-input {
      flex: 1; padding: 0.55rem 0.85rem; background: var(--sk-surface-0);
      border: 1px solid color-mix(in srgb, var(--sk-accent-secondary) 25%, var(--sk-border));
      border-radius: var(--sk-radius); color: var(--sk-text); outline: none;
    }
    .zen-view__composer-input:focus {
      border-color: color-mix(in srgb, var(--sk-accent-secondary) 60%, transparent);
      box-shadow: 0 0 12px color-mix(in srgb, var(--sk-accent-secondary) 20%, transparent);
    }
    .zen-view__composer-audio { display: flex; gap: 0.5rem; align-items: center; }
    .zen-view__composer-viz {
      width: 100%; overflow: hidden; background: var(--sk-surface-0);
      border: 1px solid var(--sk-border-subtle); border-radius: var(--sk-radius);
    }

    .zen-view__latest-note { display: flex; flex-direction: column; gap: var(--sk-space-1); }
    .zen-view__latest-note p { margin: 0; font-size: var(--sk-text-sm); color: var(--sk-text); }
    .zen-view__latest-artifact { display: flex; flex-direction: column; gap: var(--sk-space-1); }
  `;
}
