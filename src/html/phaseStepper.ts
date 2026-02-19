import { escapeHtml } from "./components";

export function phaseStepper(
    currentPhase: number,
    phases?: { name: string; prompt: string; review?: boolean }[],
    taskStatus?: string,
    needsReview?: boolean | number): string {
    if (!phases || phases.length === 0) {
        return `<div class="task-phase-fallback"><strong>Phase:</strong> ${currentPhase}</div>`;
    }

    const total = phases.length;
    const completedCount = taskStatus === "completed"
        ? total
        : Math.max(0, Math.min(currentPhase, total));
    const progressPct = Math.round((completedCount / total) * 100);

    const isReview = !!(needsReview);

    const steps = phases.map((p, i) => {
        let state: "done" | "active" | "pending" | "failed" | "review";

        if (taskStatus === "completed") {
            state = "done";
        } else if (taskStatus === "failed" && i === currentPhase) {
            state = "failed";
        } else if (i < currentPhase) {
            state = "done";
        } else if (i === currentPhase) {
            state = isReview ? "review" : "active";
        } else {
            state = "pending";
        }

        const icon = state === "done" ? "&#10003;" : state === "failed" ? "!" : state === "review" ? "&#9998;" : `${i + 1}`;

        const reviewMark = p.review && state !== "review" && state !== "done" ? ` <span class="phase-review-dot" title="Review gate">&#9679;</span>` : "";

        return `<div class="phase-step phase-step-${state}">
      <div class="phase-circle">${icon}</div>
      <div class="phase-name">${escapeHtml(p.name)}${reviewMark}</div>
    </div>`;
    });

    return `<div class="phase-stepper">
    <div class="phase-summary">
      <span>${completedCount}/${total} phases complete</span>
      <span>${isReview ? "Review Required" : `${progressPct}%`}</span>
    </div>
    <div class="phase-progress">
      <div class="phase-progress-fill" style="width:${progressPct}%"></div>
    </div>
    <div class="phase-grid" style="--phase-cols:${Math.min(total, 6)}">
      ${steps.join("")}
    </div>
  </div>`;
}
