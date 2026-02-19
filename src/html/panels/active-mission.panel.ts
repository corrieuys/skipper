import { escapeHtml } from "../atoms/escape-html";
import { badgeFragment } from "../fragments/badge.fragment";
import { phaseStepFragment, type PhaseStepData } from "../fragments/phase-step.fragment";

export const FRAGMENT_ID = "sk-active-mission";

export interface ActiveMissionData {
  taskId: string;
  title: string;
  status: string;
  teamName: string | null;
  currentPhase: number;
  phases: PhaseStepData[];
  needsReview: boolean;
}

/**
 * Active mission card for the command center.
 * Shows the currently running task with phase progress and a link to the execution view.
 */
export function activeMissionPanel(data: ActiveMissionData): string {
  const phases = data.phases.map((p) => phaseStepFragment(p)).join(" ");

  return `<div id="${FRAGMENT_ID}" class="sk-mission">
    <div class="sk-mission__title">${escapeHtml(data.title)}</div>
    <div class="sk-mission__meta">
      ${badgeFragment(data.status)}
      <span>Phase ${data.currentPhase + 1}/${data.phases.length}</span>
      ${data.teamName ? `<span>Team: ${escapeHtml(data.teamName)}</span>` : ""}
      ${data.needsReview ? `<span class="sk-badge sk-badge--waiting">Review needed</span>` : ""}
    </div>
    <div class="sk-mission__phases">${phases}</div>
    <div class="sk-mission__actions">
      <a href="/tasks/${escapeHtml(data.taskId)}" class="sk-btn sk-btn--sm">View Task &rarr;</a>
    </div>
  </div>`;
}
