/** Agent execution tree styles */
export function treeStyles(): string {
  return `
    .sk-tree {
      font-size: var(--sk-text-sm);
    }
    .sk-tree__node {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      padding: var(--sk-space-2) var(--sk-space-3);
      padding-left: calc(var(--depth, 0) * 1.5rem + var(--sk-space-3));
      border-bottom: 1px solid var(--sk-border);
      cursor: pointer;
      transition: background 0.1s;
    }
    .sk-tree__node:hover {
      background: rgba(255, 255, 255, 0.02);
    }
    .sk-tree__node--expanded {
      background: rgba(0, 251, 251, 0.03);
    }
    .sk-tree__connector {
      color: var(--sk-text-subtle);
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
      user-select: none;
      min-width: 2.5em;
    }
    .sk-tree__agent-name {
      font-weight: 600;
      color: var(--sk-text);
    }
    .sk-tree__meta {
      color: var(--sk-text-muted);
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
    }
    .sk-tree__actions {
      margin-left: auto;
      display: flex;
      gap: var(--sk-space-2);
      align-items: center;
    }
    .sk-tree__delegation {
      display: inline-flex;
      align-items: center;
      gap: var(--sk-space-1);
      max-width: 32rem;
      padding: 1px 6px 1px 4px;
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-sm);
      background: color-mix(in srgb, var(--sk-surface-2) 60%, transparent);
      color: var(--sk-text-muted);
      font: inherit;
      font-size: var(--sk-text-xs);
      cursor: pointer;
      overflow: hidden;
    }
    .sk-tree__delegation:hover {
      border-color: var(--sk-border);
      background: var(--sk-surface-2);
      color: var(--sk-text);
    }
    .sk-tree__delegation-badge {
      flex: 0 0 auto;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 1px 5px;
      border-radius: var(--sk-radius-xs);
      font-family: var(--sk-font-mono);
      background: var(--sk-surface-3);
      color: var(--sk-text-subtle);
    }
    .sk-tree__delegation-badge--completed,
    .sk-tree__delegation-badge--success { color: var(--sk-accent-success); background: color-mix(in srgb, var(--sk-accent-success) 18%, transparent); }
    .sk-tree__delegation-badge--running { color: var(--sk-accent-secondary); background: color-mix(in srgb, var(--sk-accent-secondary) 18%, transparent); }
    .sk-tree__delegation-badge--failed { color: var(--sk-accent-danger); background: color-mix(in srgb, var(--sk-accent-danger) 18%, transparent); }
    .sk-tree__delegation-preview {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .sk-tree__terminal {
      margin: 0;
      padding-left: calc(var(--depth, 0) * 1.5rem + var(--sk-space-3));
      background: var(--sk-surface-0);
      border-bottom: 1px solid var(--sk-border);
    }
    .sk-tree__terminal-feed {
      max-height: 320px;
      overflow-y: auto;
      padding: var(--sk-space-1) 0;
    }
  `;
}
