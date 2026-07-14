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

    /* The agent orb is a transparent slot by default: nothing renders until
       zen-orbs-3d.js decides whether WebGL is available. If the three.js cube
       (shared canvas, z-index 5) can draw, it boots and adds .zen-orbs-3d-active
       on <html>. If WebGL is unavailable or three.js fails to load, it adds
       .zen-orbs-3d-fallback instead, which reveals the CSS glowing sphere below
       (same theme accent vars the 3D renderer reads). Staying blank during the
       undecided window avoids the flash where CSS orbs show then cubes pop in. */
    .zen-orb {
      width: 90px; height: 90px; position: relative;
      border-radius: 50%;
      border: none;
      background: transparent;
      transition: opacity 0.4s ease, box-shadow 0.4s ease;
    }
    /* CSS fallback sphere — only when WebGL/three.js is confirmed unavailable */
    .zen-orbs-3d-fallback .zen-orb {
      background: radial-gradient(circle at 35% 35%,
        var(--sk-accent-primary, #b07cff) 0%,
        var(--sk-accent-secondary, #7c93ff) 60%,
        color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 40%) 100%);
      box-shadow:
        0 0 12px 2px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), transparent 50%),
        inset 0 -4px 8px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 60%);
      transform: scale(0.6); /* shrink CSS fallback sphere */
    }
    .zen-orbs-3d-fallback .zen-orb--inactive {
      opacity: 0.35;
      box-shadow: none;
    }
    .zen-orbs-3d-fallback .zen-orb--active {
      animation: zen-orb-glow 2.5s ease-in-out infinite;
    }
    /* Shine highlight: hidden until fallback confirmed */
    .zen-orb__shine {
      position: absolute; top: 15%; left: 20%;
      width: 35%; height: 25%; border-radius: 50%;
      background: radial-gradient(ellipse at center,
        rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 100%);
      transform: rotate(-20deg);
      pointer-events: none;
      display: none;
    }
    .zen-orbs-3d-fallback .zen-orb__shine { display: block; }
    @keyframes zen-orb-glow {
      0%, 100% { box-shadow: 0 0 12px 2px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), transparent 50%),
                              inset 0 -4px 8px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 60%); }
      50% { box-shadow: 0 0 20px 6px color-mix(in srgb, var(--sk-accent-primary, #b07cff), transparent 40%),
                         inset 0 -4px 8px color-mix(in srgb, var(--sk-accent-secondary, #7c93ff), black 60%); }
    }

    /* .zen-orbs-3d-active: the base .zen-orb is already a transparent slot, so
       the 3D canvas draws over it with nothing to hide. Fallback visuals only
       ever attach under .zen-orbs-3d-fallback, which is mutually exclusive. */
  `;
}
