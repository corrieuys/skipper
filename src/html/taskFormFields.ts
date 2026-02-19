import { TeamOptionData, TaskData, escapeHtml } from "./components";


export function taskFormFields(
    _teams: TeamOptionData[],
    task?: Partial<TaskData>
): string {
    // Team + template fields are served by the slot endpoint; the passed-in
    // teams list is retained in the signature for backwards compatibility but
    // no longer consumed here.
    void _teams;
    const taskType = task?.task_type;
    const taskConfig = task?.task_config;
    const isRealTime = taskType === "real_time";
    const initialTaskType = isRealTime ? "real_time" : "standard";
    const selectedTeamId = task?.team_id ?? "";
    const slotQs = `taskType=${initialTaskType}&amp;context=compact&amp;selectedTeamId=${encodeURIComponent(selectedTeamId)}`;

    return `<div class="task-form-grid">
    <label><span>Title</span><input type="text" name="title" value="${task?.title ? escapeHtml(task.title) : ""}" required placeholder="Summarize the work to be done"></label>
    <label class="task-form-span-2"><span>Description</span><textarea name="description" rows="6" placeholder="Context, acceptance criteria, or specific instructions">${task?.description ? escapeHtml(task.description) : ""}</textarea></label>
    <div id="task-form-team-template-slot" style="display:contents;"
      hx-get="/fragments/task-form/team-template?${slotQs}"
      hx-trigger="load, change from:[name=taskType]"
      hx-include="[name=taskType]"
      hx-swap="outerHTML"></div>
    <label><span>Task Type</span>
      <select name="taskType" onchange="(function(v){const rt=v==='real_time';const cfg=document.getElementById('rt-config');if(cfg)cfg.style.display=rt?'grid':'none';})(this.value)">
        <option value="standard"${taskType === "standard" || !taskType ? " selected" : ""}>Standard</option>
        <option value="real_time"${isRealTime ? " selected" : ""}>Real-Time</option>
      </select>
    </label>
  </div>
  <div id="rt-config" class="task-form-grid" style="display:${isRealTime ? "grid" : "none"};margin-top:1rem">
    <label><span>Window Duration (sec)</span><input type="number" name="window_seconds" min="5" value="${taskConfig?.window_seconds ?? 60}"></label>
    <label><span>Summary Cadence (sec)</span><input type="number" name="summary_cadence_seconds" min="5" value="${taskConfig?.summary_cadence_seconds ?? 60}"></label>
    <label><span>Trigger Confidence (0-1)</span><input type="number" name="trigger_min_confidence" min="0" max="1" step="0.05" value="${taskConfig?.trigger_min_confidence ?? 0.7}"></label>
    <label><span>Max Pending Windows</span><input type="number" name="max_pending_windows" min="1" value="${taskConfig?.max_pending_windows ?? 3}"></label>
    <label class="task-form-span-2"><span>Transcription Command</span><input type="text" name="transcription_command" value="${taskConfig?.transcription_command ? escapeHtml(String(taskConfig.transcription_command)) : ""}" placeholder="e.g. whisper --model base"></label>
  </div>`;
}
