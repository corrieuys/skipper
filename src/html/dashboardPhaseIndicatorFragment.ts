import { DashboardData, escapeHtml } from "./components";


export function dashboardPhaseIndicatorFragment(
    task: NonNullable<DashboardData["phaseIndicatorTask"]> | null
): string {
    if (!task) {
        return `<div class="cmd-phase-inline cmd-phase-inline-empty">
      <span class="cmd-phase-inline-index">idle</span>
      <span class="cmd-phase-inline-meta">No active regular task</span>
    </div>`;
    }
    const phases = task.phases ?? [];
    if (phases.length === 0) {
        return `<div class="cmd-phase-inline cmd-phase-inline-empty">
      <span class="cmd-phase-inline-index">0/0</span>
      <span class="cmd-phase-inline-meta">No phases configured</span>
    </div>`;
    }
    const totalPhases = phases.length;
    const currentPhaseIndex = Math.min(
        Math.max(task.current_phase, 0),
        totalPhases - 1
    );
    const isReview = !!(task.needs_review);
    return `<div class="cmd-phase-inline">
    <span class="cmd-phase-inline-index">${currentPhaseIndex + 1}/${totalPhases}${isReview ? " &#9998;" : ""}</span>
    <div class="cmd-phase-inline-steps">
      ${phases
            .map((phase, index) => {
                const stateClass = index < currentPhaseIndex
                    ? "done"
                    : index === currentPhaseIndex
                        ? (isReview ? "review" : "active")
                        : "upcoming";
                return `<span class="cmd-phase-pill cmd-phase-pill-${stateClass}">${index + 1}. ${escapeHtml(phase.name)}</span>`;
            })
            .join("")}
    </div>
  </div>`;
}
