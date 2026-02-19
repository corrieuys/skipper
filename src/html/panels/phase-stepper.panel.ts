import { phaseStepFragment, type PhaseStepData } from "../fragments/phase-step.fragment";

export const FRAGMENT_ID = "sk-phase-stepper";

export function phaseStepperPanel(phases: PhaseStepData[]): string {
  if (phases.length === 0) return `<div id="${FRAGMENT_ID}"></div>`;

  const steps = phases.map((p) => phaseStepFragment(p)).join(" ");
  return `<div id="${FRAGMENT_ID}" class="sk-flex sk-items-center sk-gap-1" style="padding: var(--sk-space-3) var(--sk-space-4); background: var(--sk-surface-2); border-bottom: 1px solid var(--sk-border);">
    ${steps}
  </div>`;
}
