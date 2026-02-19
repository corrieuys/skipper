/** Panel pattern: header + body sections used across all pages */
export function panelStyles(): string {
  return `
    .sk-panel {
      background: var(--sk-panel-bg);
      border: 1px solid var(--sk-border);
      overflow: hidden;
    }
    .sk-panel__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--sk-space-2) var(--sk-space-3);
      border-bottom: 1px solid var(--sk-border);
      min-height: 2.25rem;
    }
    .sk-panel__title {
      font-size: var(--sk-text-sm);
      font-weight: 600;
      color: var(--sk-text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .sk-panel__count {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      background: var(--sk-surface-3);
      padding: 0.1rem 0.4rem;
      border-radius: var(--sk-radius-xs);
    }
    .sk-panel__body {
      padding: var(--sk-space-3);
    }
    .sk-panel__body--flush {
      padding: 0;
    }
    .sk-panel__body--scroll {
      max-height: 300px;
      overflow-y: auto;
    }
    .sk-panel__empty {
      padding: var(--sk-space-6);
      text-align: center;
      color: var(--sk-text-subtle);
      font-size: var(--sk-text-sm);
    }
  `;
}
