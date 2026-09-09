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

    /* ── Icon identity picker (Lucide icon + color) ─────────────────────────── */
    .ic-picker { --icon-color: #6ea8fe; display: flex; flex-direction: column; gap: var(--sk-space-2); }
    .ic-picker__head { display: flex; align-items: center; gap: var(--sk-space-2); }
    .ic-preview {
      flex: none; width: 34px; height: 34px; border-radius: var(--sk-radius-sm);
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--sk-surface-2); color: var(--icon-color);
    }
    .ic-preview__empty {
      width: 14px; height: 14px; border-radius: 3px;
      border: 2px dashed var(--sk-border); box-sizing: border-box;
    }
    .ic-search { flex: 1; min-width: 0; }
    .ic-clear {
      flex: none; width: 30px; height: 30px; min-height: 0; padding: 0; line-height: 1;
      border-radius: var(--sk-radius-sm); cursor: pointer; font-size: 16px;
      background: var(--sk-surface-2); color: var(--sk-text-subtle);
      border: 1px solid var(--sk-border);
    }
    .ic-clear:hover { background: var(--sk-surface-3); color: var(--sk-text); }
    .ic-swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .ic-swatch {
      flex: none; width: 22px; height: 22px; min-height: 0; line-height: 1;
      border-radius: 50%; cursor: pointer; padding: 0; box-sizing: border-box;
      border: 2px solid transparent; box-shadow: 0 0 0 1px var(--sk-border) inset;
      transition: transform 0.1s ease, border-color 0.1s ease;
    }
    .ic-swatch:hover { transform: scale(1.12); }
    .ic-swatch--on { border-color: var(--sk-text); box-shadow: 0 0 0 2px var(--sk-surface-1), 0 0 0 3px var(--sk-text); }
    .ic-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
      gap: 4px; max-height: 220px; overflow-y: auto;
      padding: var(--sk-space-1); background: var(--sk-surface-1);
      border: 1px solid var(--sk-border); border-radius: var(--sk-radius-sm);
      color: var(--icon-color);
    }
    .ic-icon {
      aspect-ratio: 1; min-height: 0; padding: 7px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--sk-radius-sm); background: transparent;
      border: 2px solid transparent; color: inherit;
      transition: border-color 0.1s ease, background 0.1s ease;
    }
    .ic-icon:hover { background: var(--sk-surface-3); }
    .ic-icon--on { border-color: var(--icon-color); background: var(--sk-surface-3); }
    .ic-icon svg { width: 100%; height: 100%; }
    .ic-grid__empty { grid-column: 1 / -1; padding: var(--sk-space-3); text-align: center; color: var(--sk-text-subtle); font-size: var(--sk-text-xs); }

    /* Collapsible optional form field (e.g. the icon picker on the task form). */
    .sk-collapse-field > summary::-webkit-details-marker { display: none; }
    .sk-collapse-field > summary { display: flex; align-items: center; gap: 6px; }
    .sk-collapse-field__caret { display: inline-block; font-size: 8px; transition: transform 0.12s ease; color: var(--sk-text-subtle); }
    .sk-collapse-field[open] .sk-collapse-field__caret { transform: rotate(90deg); }
  `;
}
