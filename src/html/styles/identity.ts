/**
 * Agent identity picker (color swatches + creature grid). Used in the team-map
 * agent modal and the single/custom agent editors. Theme-token based. The creature
 * SVGs themselves are styled by `.zen-orb__creature` in animations.ts; here we only
 * lay out the widget and its selectable states.
 */
export function identityStyles(): string {
  return `
    .ai-picker { --agent-color: #6ea8fe; --agent-ink: #3f6fc0; }

    .ai-swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .ai-swatch {
      flex: none; width: 22px; height: 22px; min-height: 0; line-height: 1;
      border-radius: 50%; cursor: pointer; padding: 0; box-sizing: border-box;
      border: 2px solid transparent; box-shadow: 0 0 0 1px var(--sk-border) inset;
      transition: transform 0.1s ease, border-color 0.1s ease;
    }
    .ai-swatch:hover { transform: scale(1.12); }
    .ai-swatch--on { border-color: var(--sk-text); box-shadow: 0 0 0 2px var(--sk-surface-1), 0 0 0 3px var(--sk-text); }

    /* Collapsible character section — closed by default. */
    .ai-creatures-wrap { margin-top: var(--sk-space-3); }
    .ai-creatures-wrap > summary {
      list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;
      color: var(--sk-text-subtle); user-select: none;
    }
    .ai-creatures-wrap > summary::-webkit-details-marker { display: none; }
    .ai-creatures-wrap > summary::before {
      content: "\\25B6"; font-size: 8px; transition: transform 0.12s ease; color: var(--sk-text-subtle);
    }
    .ai-creatures-wrap[open] > summary::before { transform: rotate(90deg); }
    .ai-creatures-wrap > summary:hover { color: var(--sk-text-muted); }
    .ai-creatures { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--sk-space-2); }
    .ai-creature {
      width: 40px; height: 40px; padding: 4px; cursor: pointer;
      border-radius: var(--sk-radius-sm); background: var(--sk-surface-2);
      border: 2px solid transparent;
      display: inline-flex; align-items: center; justify-content: center;
      transition: border-color 0.1s ease, background 0.1s ease;
    }
    .ai-creature:hover { background: var(--sk-surface-3); }
    .ai-creature--on { border-color: var(--agent-color); background: var(--sk-surface-3); }
    .ai-creature .zen-orb__creature { width: 100%; height: 100%; animation: none; filter: none; }
    .ai-creature .zen-eye { animation: none; }
    .ai-creature__cube {
      width: 22px; height: 22px; border-radius: 26%;
      background: linear-gradient(135deg, var(--agent-color), var(--agent-ink));
      border: 2px solid rgba(255, 255, 255, 0.7);
    }
    .ai-creature--none { color: var(--sk-text-subtle); }
  `;
}
