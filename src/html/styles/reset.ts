/** CSS reset and base element styles */
export function reset(): string {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--sk-font-body);
      background: var(--sk-surface-1);
      color: var(--sk-text-muted);
      line-height: 1.6;
      font-size: var(--sk-text-base);
      min-height: 100vh;
      overflow-x: hidden;
    }

    a { color: var(--sk-accent-primary); text-decoration: none; }
    a:hover { color: var(--sk-text); }

    h1, h2, h3, h4, h5, h6 {
      font-family: var(--sk-font-heading);
      color: var(--sk-text);
      line-height: 1.3;
    }

    code, pre {
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-sm);
    }

    pre {
      background: var(--sk-surface-0);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-panel-radius);
      padding: var(--sk-space-3);
      overflow-x: auto;
    }

    button, input, select, textarea {
      font-family: inherit;
      font-size: inherit;
    }
  `;
}
