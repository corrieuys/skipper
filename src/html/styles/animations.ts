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

    /* The agent orb is a transparent slot: the three.js cube (shared WebGL
       canvas, z-index 5) is drawn on top, tracking this element's rect. No CSS
       visuals — the old crystal-ball circle used to flash on every page load
       before the deferred three.js module booted, so it is gone entirely. The
       .zen-orb--active / --inactive classes remain as state flags read by
       zen-orbs-3d.js; they carry no styling here. */
    .zen-orb {
      width: 90px; height: 90px; position: relative;
      background: transparent; border: none;
    }
    .zen-orb__shine { display: none; }
  `;
}
