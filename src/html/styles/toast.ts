/** Bottom-right snackbar/toast styles (update notices). */
export function toastStyles(): string {
  return `
    .sk-toast-host {
      position: fixed;
      right: var(--sk-space-4);
      bottom: var(--sk-space-4);
      z-index: var(--sk-z-notification);
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
      max-width: min(360px, calc(100vw - 2 * var(--sk-space-4)));
      pointer-events: none; /* let clicks through the empty host; toasts opt back in */
    }
    .sk-toast {
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: var(--sk-space-2);
      padding: var(--sk-space-3);
      border-radius: var(--sk-btn-radius, 8px);
      border: 1px solid var(--sk-border);
      background: var(--sk-surface-2);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      /* No entry animation: the 120s poll re-swaps identical markup, so an
         animation would restart and flicker. */
    }
    .sk-toast__body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 0.8rem;
      line-height: 1.35;
      color: var(--sk-text);
    }
    .sk-toast__title {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--sk-accent-primary);
    }
    .sk-toast__msg { color: var(--sk-text-muted); }
    .sk-toast__msg code {
      font-family: var(--sk-font-mono, monospace);
      font-size: 0.72rem;
      padding: 0.05em 0.3em;
      border-radius: 4px;
      background: var(--sk-surface-3);
      color: var(--sk-text);
    }
    .sk-toast__close {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      line-height: 1;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--sk-text-muted);
      font-size: 1.1rem;
      cursor: pointer;
    }
    .sk-toast__close:hover { color: var(--sk-text); background: var(--sk-surface-3); }
  `;
}
