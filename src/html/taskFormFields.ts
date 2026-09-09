import { type TeamOptionData, type TaskData, escapeHtml } from "./components";
import { isExperimental } from "../config/feature-flags";


export function taskFormFields(
    _teams: TeamOptionData[],
    task?: Partial<TaskData>
): string {
    // The team field is served by the slot endpoint; the passed-in teams list is
    // retained in the signature for backwards compatibility but no longer consumed
    // here.
    void _teams;
    const mode = task?.mode === "conversational" ? "conversational" : "workflow";
    const selectedTeamId = task?.team_id ?? "";
    const slotQs = `context=compact&amp;selectedTeamId=${encodeURIComponent(selectedTeamId)}`;

    return `<div class="task-form-grid">
    <label><span>Title</span><input type="text" name="title" value="${task?.title ? escapeHtml(task.title) : ""}" required placeholder="Summarize the work to be done"></label>
    <label class="task-form-span-2"><span>Description</span><textarea name="description" rows="6" placeholder="Context, acceptance criteria, or specific instructions">${task?.description ? escapeHtml(task.description) : ""}</textarea></label>
    <div id="task-form-team-slot" style="display:contents;"
      hx-get="/fragments/task-form/team?${slotQs}"
      hx-trigger="load"
      hx-swap="outerHTML"></div>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox"${mode === "workflow" ? " checked" : ""}
        onchange="this.parentElement.querySelector('input[name=mode]').value=this.checked?'workflow':'conversational';">
      <span>Autopilot</span>
      <input type="hidden" name="mode" value="${mode}">
    </label>
    ${isExperimental() ? `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;" title="Keep a searchable memory of input, messages, and notes that agents can query.">
      <input type="checkbox" name="memoryEnabled" value="1"${(task as { task_config?: { memory_enabled?: boolean } } | undefined)?.task_config?.memory_enabled ? " checked" : ""}>
      <span>Memory</span>
    </label>` : ""}
  </div>`;
}
