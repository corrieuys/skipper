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
  `;
}
