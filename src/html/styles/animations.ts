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
      width: 58px; height: 58px; position: relative;
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

    /* Per-agent creature character. Replaces the cube when an agent picked one
       (zen-cube-2d.js skips cube injection for orbs with data-zen-character). Tint
       comes from --agent-color/--agent-ink set inline on the SVG (baked from the
       agent's color). The creature does NOT spin: idle it sits still (dimmed), busy
       (its agent is active) it hops — but the hops are driven by zen-cube-2d.js,
       which fires a burst of a RANDOM number of zen-hop-once hops then waits a
       RANDOM interval before the next burst (per creature, so no two share a
       rhythm). Its eyes blink every few seconds in both states. The SVG art sits
       well inside the 100x100 viewBox, so a hop never clips. */
    .zen-orb__creature {
      width: 100%; height: 100%; overflow: visible;
      transform-origin: 50% 80%;
      filter: drop-shadow(0 0 6px color-mix(in srgb, var(--agent-color, #6ea8fe), transparent 55%));
    }
    .zen-orb--inactive .zen-orb__creature { opacity: 0.55; filter: none; }
    /* One hop; zen-cube-2d.js adds .zen-hop and sets --hop-reps for a burst. */
    .zen-orb__creature.zen-hop {
      animation: zen-hop-once 0.42s ease-in-out var(--hop-reps, 1);
    }
    .zen-eye {
      transform-box: fill-box; transform-origin: center;
      animation: zen-blink 4.6s ease-in-out infinite;
    }
    /* Asleep: an inactive creature keeps its eyes shut (no blink). */
    .zen-orb--inactive .zen-eye { animation: none; transform: scaleY(0.12); }
    /* One small hop with a light squash on landing — "not too much". */
    @keyframes zen-hop-once {
      0% { transform: translateY(0) scaleY(1); }
      35% { transform: translateY(-13%) scaleY(1.04); }
      70% { transform: translateY(0) scaleY(0.97); }
      100% { transform: translateY(0) scaleY(1); }
    }
    /* Two quick blinks at uneven points of a ~4.6s cycle. */
    @keyframes zen-blink {
      0%, 45% { transform: scaleY(1); }
      47%, 48% { transform: scaleY(0.1); }
      50%, 88% { transform: scaleY(1); }
      90%, 91% { transform: scaleY(0.1); }
      93%, 100% { transform: scaleY(1); }
    }
    /* Desync neighbours' blinks (hops are JS-driven + already random per creature). */
    .zen-view__orb-wrapper:nth-child(2) .zen-eye { animation-delay: -2.7s; }
    .zen-view__orb-wrapper:nth-child(3) .zen-eye { animation-delay: -1.1s; }
    .zen-view__orb-wrapper:nth-child(4) .zen-eye { animation-delay: -3.6s; }
    .zen-view__orb-wrapper:nth-child(5) .zen-eye { animation-delay: -4.0s; }
    /* Multi-instance crowd: overlapping copies. Each copy's creature is its own
       element, so zen-cube-2d.js hops each on its own random schedule. */
    .zen-orb__stack { position: absolute; inset: 0; }
    .zen-orb__stack-item {
      position: absolute; inset: 0;
      transform: translate(var(--sx, 0), var(--sy, 0)) scale(var(--ss, 1));
      opacity: var(--o, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      .zen-orb__creature.zen-hop,
      .zen-eye { animation: none; }
    }
  `;
}
