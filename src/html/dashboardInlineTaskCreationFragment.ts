import { dictateButton } from "./fragments/dictate-button.fragment";

export function dashboardInlineTaskCreationFragment(
    _teams: { id: string; name: string; }[]): string {
    // Team + template selects are rendered server-side via the slot endpoint;
    // the passed-in teams list is no longer used (kept in the signature for
    // backwards compatibility with existing callers).
    void _teams;
    return `<div class="cmd-inline-intake">
    <div class="cmd-inline-intake-head">
      <div class="cmd-focus-eyebrow">Create Task</div>
    </div>
    <form
      class="cmd-inline-intake-form"
      hx-post="/api/tasks"
      hx-target="body"
      hx-swap="innerHTML"
      onsubmit="return prepareDashboardInlineTaskSubmit(this)"
    >
      <input type="hidden" name="title" id="dashboard-inline-title" value="">
      <input type="hidden" name="autoApprove" value="1">
      <label class="cmd-inline-intake-description">
        <span class="muted">Task Title</span>
        <input
          type="text"
          id="dashboard-inline-title-input"
          placeholder="Optional — derived from description"
          autocomplete="off"
        >
      </label>
      <div class="cmd-inline-intake-description">
        <span style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span class="muted">Orchestration command</span>
          ${dictateButton("#dashboard-inline-description")}
        </span>
        <textarea
          id="dashboard-inline-description"
          name="description"
          rows="4"
          required
          placeholder="Describe the work to orchestrate..."
          oninput="syncDashboardInlineTaskTitle(this)"
        ></textarea>
      </div>
      <div class="cmd-inline-intake-controls">
        <label for="dashboard-inline-autopilot" class="muted">Autopilot</label>
        <label for="dashboard-inline-team" class="muted">Agent Team</label>
        <label for="dashboard-inline-template" class="muted">Template</label>
        <span></span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;" title="On: the team drives the task to the end of its phases. Off: the task waits for your input between turns.">
          <input type="checkbox" id="dashboard-inline-autopilot" checked
            onchange="document.getElementById('dashboard-inline-mode').value=this.checked?'workflow':'conversational';">
          <input type="hidden" name="mode" id="dashboard-inline-mode" value="workflow">
        </label>
        <div id="task-form-team-slot" style="display:contents;"
          hx-get="/fragments/task-form/team?context=inline"
          hx-trigger="load"
          hx-swap="outerHTML"></div>
        <button type="submit" class="cmd-inline-intake-submit">Start</button>
      </div>
    </form>
  </div>`;
}
