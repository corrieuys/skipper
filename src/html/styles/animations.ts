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
    .zen-view__orbs { display: flex; gap: var(--sk-space-5); flex-wrap: wrap; justify-content: center; padding: var(--sk-space-4) 0; min-height: 92px; }
    .zen-view__orb-wrapper { display: flex; flex-direction: column; align-items: center; gap: var(--sk-space-2); width: 96px; }
    .zen-view__orb-label {
      font-size: 13px; color: var(--sk-text-muted); width: 120px; text-align: center;
      word-wrap: break-word; overflow-wrap: break-word; line-height: 1.3;
      position: relative;
      text-shadow: 0 1px 3px var(--sk-surface-0), 0 0 6px var(--sk-surface-0);
    }

    /* The agent orb is a 2D cube that spins in-plane while its agent is active
       (zen-cube-2d.js rotates the inner .zen-orb__cube). No WebGL, no canvas.

       The .zen-orb is a RESERVED BOX; the visible square (.zen-orb__cube) is
       sized to ~58% of it, so its rotating corners (diagonal ~0.82x the box)
       never leave the box — nothing paints outside .zen-orb, so a scroll/overflow
       ancestor can't clip the spin. Fill is a diagonal accent gradient with a
       bright hairline border, matching the iOS SpinningCube; both read theme
       accent vars, so the theme picker recolors live. Idle = dimmed + still. */
    .zen-orb {
      width: 58px; height: 58px;
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; overflow: visible;
    }
    .zen-orb__cube {
      width: 58%; height: 58%;
      border-radius: 26%;
      border: 2px solid rgba(255, 255, 255, 0.85);
      background: linear-gradient(135deg,
        var(--sk-accent-primary, #b07cff), var(--sk-accent-tertiary, #7cffd6));
      box-shadow: 0 0 12px color-mix(in srgb, var(--sk-accent-primary, #b07cff), transparent 60%);
      will-change: transform;
      transition: opacity 0.4s ease, box-shadow 0.4s ease, border-color 0.4s ease;
    }
    .zen-orb--inactive .zen-orb__cube {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.25);
      box-shadow: none;
      opacity: 0.5;
    }
    /* Legacy shine highlight node is unused by the 2D cube. */
    .zen-orb__shine { display: none; }
  `;
}
