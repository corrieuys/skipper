/** Chat panel styles */
export function chatStyles(): string {
  return `
    .sk-chat {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--sk-panel-bg);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-panel-radius);
      overflow: hidden;
    }
    .sk-chat__header {
      padding: var(--sk-space-2) var(--sk-space-3);
      border-bottom: 1px solid var(--sk-border);
      font-size: var(--sk-text-sm);
      font-weight: 600;
      color: var(--sk-text);
    }
    .sk-chat__messages {
      flex: 1;
      overflow-y: auto;
      padding: var(--sk-space-3);
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
    }
    .sk-chat__message {
      max-width: 85%;
      padding: var(--sk-space-2) var(--sk-space-3);
      border-radius: var(--sk-radius-md);
      font-size: var(--sk-text-sm);
      line-height: 1.5;
    }
    .sk-chat__message--user {
      align-self: flex-end;
      background: var(--sk-accent-primary-dim);
      color: var(--sk-text);
    }
    .sk-chat__message--assistant {
      align-self: flex-start;
      background: var(--sk-surface-3);
      color: var(--sk-text-muted);
    }
    .sk-chat__message--system {
      align-self: center;
      background: none;
      color: var(--sk-text-subtle);
      font-size: var(--sk-text-xs);
      font-style: italic;
    }
    .sk-chat__role {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-subtle);
      margin-bottom: 0.15rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .sk-chat__input-area {
      padding: var(--sk-space-2) var(--sk-space-3);
      border-top: 1px solid var(--sk-border);
      display: flex;
      gap: var(--sk-space-2);
    }
    .sk-chat__input {
      flex: 1;
      padding: var(--sk-space-2);
      background: var(--sk-surface-0);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-md);
      color: var(--sk-text);
      font-size: var(--sk-text-sm);
      resize: none;
      min-height: 2.5rem;
      max-height: 6rem;
    }
    .sk-chat__input:focus { outline: none; border-color: var(--sk-accent-primary); }
  `;
}
