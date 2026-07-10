import type { ScheduleMatrix } from "../../tasks/scheduled-scheduler";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function countMatrixHours(matrix: ScheduleMatrix): number {
  return matrix.reduce((sum, row) => sum + row.reduce((s, c) => s + (c === 1 ? 1 : 0), 0), 0);
}

function emptyMatrix(): ScheduleMatrix {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
}

function renderGrid(matrix: ScheduleMatrix, interactive: boolean): string {
  const hourHeaders = Array.from({ length: 24 }, (_, h) =>
    interactive
      ? `<button type="button" class="sk-schedmatrix__hcol sk-text-xs" data-col="${h}" title="Toggle ${String(h).padStart(2, "0")}:00 for every day">${h}</button>`
      : `<span class="sk-schedmatrix__hcol sk-text-xs">${h}</span>`,
  ).join("");

  const rows = DAY_LABELS.map((label, day) => {
    const header = interactive
      ? `<button type="button" class="sk-schedmatrix__hrow sk-text-xs" data-row="${day}" title="Toggle all of ${label}">${label}</button>`
      : `<span class="sk-schedmatrix__hrow sk-text-xs">${label}</span>`;
    const cells = Array.from({ length: 24 }, (_, hour) =>
      `<span class="sk-schedmatrix__cell${matrix[day]?.[hour] === 1 ? " is-on" : ""}" data-day="${day}" data-hour="${hour}"></span>`,
    ).join("");
    return header + cells;
  }).join("");

  return `<div class="sk-schedmatrix__grid"><span class="sk-schedmatrix__corner"></span>${hourHeaders}${rows}</div>`;
}

/**
 * Interactive 7x24 weekly schedule editor. Serializes into the hidden
 * scheduleMatrix input (JSON, empty string = no weekly schedule); behavior
 * lives in public/schedule-matrix.js via document-level event delegation.
 * Pass inputDisabled when weekly mode is not the active schedule mode, so
 * the hidden input stays out of the form submission until the mode select
 * enables it (disabled fields do not submit).
 */
export function renderScheduleMatrixEditor(
  matrix: ScheduleMatrix | null,
  opts: { inputDisabled?: boolean } = {},
): string {
  const grid = matrix ?? emptyMatrix();
  const hours = matrix ? countMatrixHours(matrix) : 0;
  return `<div class="sk-schedmatrix" data-schedmatrix>
    <input type="hidden" name="scheduleMatrix" value="${matrix ? JSON.stringify(matrix) : ""}"${opts.inputDisabled ? " disabled" : ""}>
    ${renderGrid(grid, true)}
    <div class="sk-muted sk-text-xs sk-schedmatrix__summary" data-schedmatrix-summary>${hours} hours/week. Click or drag to paint; headers toggle a whole day or hour. Times are server-local.</div>
  </div>`;
}

/** Read-only mini grid for the scheduled-task detail view. */
export function renderScheduleMatrixView(matrix: ScheduleMatrix): string {
  return `<div class="sk-schedmatrix sk-schedmatrix--readonly">${renderGrid(matrix, false)}</div>`;
}
