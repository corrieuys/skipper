/** Utility classes */
export function utilityStyles(): string {
  return `
    .sk-hidden { display: none !important; }
    .sk-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
    .sk-flex { display: flex; }
    .sk-flex-col { display: flex; flex-direction: column; }
    .sk-items-center { align-items: center; }
    .sk-justify-between { justify-content: space-between; }
    .sk-gap-1 { gap: var(--sk-space-1); }
    .sk-gap-2 { gap: var(--sk-space-2); }
    .sk-gap-3 { gap: var(--sk-space-3); }
    .sk-gap-4 { gap: var(--sk-space-4); }
    .sk-mt-2 { margin-top: var(--sk-space-2); }
    .sk-mt-4 { margin-top: var(--sk-space-4); }
    .sk-mb-2 { margin-bottom: var(--sk-space-2); }
    .sk-mb-4 { margin-bottom: var(--sk-space-4); }
    .sk-w-full { width: 100%; }
    .sk-text-right { text-align: right; }
    .sk-text-center { text-align: center; }
    .sk-scroll-y { overflow-y: auto; }
    .sk-scroll-y::-webkit-scrollbar { width: 4px; }
    .sk-scroll-y::-webkit-scrollbar-track { background: transparent; }
    .sk-scroll-y::-webkit-scrollbar-thumb { background: var(--sk-surface-4); border-radius: 2px; }
  `;
}
