/** Terminal output display styles */
export function terminalStyles(): string {
  return `
    .sk-terminal {
      background: var(--sk-surface-0);
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
      line-height: 1.6;
      overflow-y: auto;
      padding: var(--sk-space-2);
    }
    .sk-terminal--fullpage {
      height: calc(100vh - 120px);
    }
    .sk-terminal__line {
      padding: 1px var(--sk-space-2);
      white-space: pre-wrap;
      word-break: break-all;
    }
    .sk-terminal__line--stdout { color: var(--sk-text-muted); }
    .sk-terminal__line--stderr { color: var(--sk-accent-danger); }
    .sk-terminal__line--summary {
      color: var(--sk-accent-secondary);
      padding-left: calc(var(--sk-space-2) + 1rem);
      font-style: italic;
    }
    .sk-terminal__controls {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-2);
      border-top: 1px solid var(--sk-border);
      font-size: var(--sk-text-xs);
    }
    .sk-terminal__filter {
      display: flex;
      gap: var(--sk-space-1);
    }
    .sk-terminal__filter-btn {
      padding: 0.15rem 0.4rem;
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-xs);
      background: none;
      color: var(--sk-text-muted);
      cursor: pointer;
      font-size: var(--sk-text-xs);
    }
    .sk-terminal__filter-btn--active {
      background: var(--sk-accent-secondary-dim);
      color: var(--sk-accent-secondary);
      border-color: var(--sk-accent-secondary);
    }

    /* Filter states via data attribute */
    .sk-terminal[data-filter="stdout"] .sk-terminal__line--stderr { display: none; }
    .sk-terminal[data-filter="stderr"] .sk-terminal__line--stdout { display: none; }
  `;
}
