import { escapeHtml } from "../atoms/escape-html";

export interface PhaseStepData {
  name: string;
  index: number;
  status: "completed" | "current" | "pending" | "review" | "failed";
}

export function phaseStepFragment(step: PhaseStepData): string {
  const icons: Record<string, string> = {
    completed: "&#x2713;",  // ✓
    current: "&#x25CF;",    // ●
    pending: "&#x25CB;",    // ○
    review: "&#x270E;",     // ✎
    failed: "&#x2717;",     // ✗
  };
  const colors: Record<string, string> = {
    completed: "var(--sk-accent-tertiary)",
    current: "var(--sk-accent-secondary)",
    pending: "var(--sk-text-muted)",
    review: "var(--sk-accent-warning)",
    failed: "var(--sk-accent-danger)",
  };

  return `<span class="sk-phase-step" title="${escapeHtml(step.name)}" style="color: ${colors[step.status]}">
    [${step.index + 1} ${icons[step.status]}]
  </span>`;
}
