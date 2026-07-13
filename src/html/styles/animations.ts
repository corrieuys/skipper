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

    /* Agent orb wrapper sizes (reused by the dashboard taskbar orbs) */
    .zen-view__orbs { display: flex; gap: var(--sk-space-5); flex-wrap: wrap; justify-content: center; padding: var(--sk-space-4) 0; min-height: 130px; }
    .zen-view__orb-wrapper { display: flex; flex-direction: column; align-items: center; gap: var(--sk-space-2); width: 120px; }
    .zen-view__orb-label {
      font-size: 13px; color: var(--sk-text-muted); width: 120px; text-align: center;
      word-wrap: break-word; overflow-wrap: break-word; line-height: 1.3;
      position: relative; z-index: 6; /* sit above the z-index:5 WebGL orb canvas */
      text-shadow: 0 1px 3px var(--sk-surface-0), 0 0 6px var(--sk-surface-0);
    }

    /* The agent orb is a transparent slot when WebGL is available: the
       three.js cube (shared canvas, z-index 5) draws on top. When WebGL is
       unavailable the CSS fallback renders a glowing sphere using the same
       theme accent vars the 3D renderer reads. zen-orbs-3d.js adds
       .zen-orbs-3d-active on <html> once the WebGL renderer boots; until
       then the CSS visuals are visible. */
    .zen-orb {
      width: 90px; height: 90px; position: relative;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%,
        var(--sk-accent-primary, #b07cff) 0%,
        var(--sk-accent-secondary, #7c93ff) 60%,
        color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 40%) 100%);
      box-shadow:
        0 0 12px 2px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), transparent 50%),
        inset 0 -4px 8px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 60%);
      border: none;
      transition: opacity 0.4s ease, box-shadow 0.4s ease;
    }
    .zen-orb--inactive {
      opacity: 0.35;
      box-shadow: none;
    }
    .zen-orb--active {
      animation: zen-orb-glow 2.5s ease-in-out infinite;
    }
    .zen-orb__shine {
      position: absolute; top: 15%; left: 20%;
      width: 35%; height: 25%; border-radius: 50%;
      background: radial-gradient(ellipse at center,
        rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 100%);
      transform: rotate(-20deg);
      pointer-events: none;
    }
    @keyframes zen-orb-glow {
      0%, 100% { box-shadow: 0 0 12px 2px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), transparent 50%),
                              inset 0 -4px 8px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 60%); }
      50% { box-shadow: 0 0 20px 6px color-mix(in srgb, var(--sk-accent-primary, #b07cff), transparent 40%),
                         inset 0 -4px 8px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 60%); }
    }

    /* When WebGL boots, hide CSS visuals so the 3D canvas takes over */
    .zen-orbs-3d-active .zen-orb {
      background: transparent;
      box-shadow: none;
      animation: none;
    }
    .zen-orbs-3d-active .zen-orb__shine { display: none; }
  `;
}
