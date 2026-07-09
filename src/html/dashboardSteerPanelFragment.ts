import { type DashboardData, escapeHtml } from "./components";

// --- Dashboard: Steer Active Agent Panel ---

export function dashboardSteerPanelFragment(
    steeringOptions: NonNullable<DashboardData["dashboardSteeringOptions"]>
): string {
    const steerableOptions = steeringOptions.filter((option) => option.can_steer);
    const dashboardSteeringReason = steeringOptions.length === 0
        ? "No active runtimes are currently available."
        : (steeringOptions
            .map((option) => option.disabled_reason)
            .find((reason) => !!reason) ??
            "No active runtime is currently steerable.");
    const defaultOption = steerableOptions[0] ?? steeringOptions[0] ?? null;
    const isActive = steerableOptions.length > 0;
    return `<div id="dashboard-steer-panel" class="cmd-panel cmd-layout-steer cmd-col2-panel ${isActive ? "cmd-layout-steer-active" : "cmd-layout-steer-inactive"}">
    <div class="cmd-panel-header cmd-steer-header">
      <span class="cmd-panel-title">Steer Active Agent</span>
      <span class="cmd-panel-count">${isActive ? `${steerableOptions.length} ready` : "inactive"}</span>
    </div>
    <div class="cmd-panel-body cmd-steer-body">
      ${isActive
            ? `<form hx-post="/api/dashboard/steer" hx-swap="none" class="cmd-dashboard-steer-form" hx-on::after-request="const s=this.querySelector('#dashboard-steer-status');if(event.detail.successful){const m=this.querySelector('textarea[name=message]');if(m)m.value='';if(s)s.textContent='Guidance sent.';}else if(s){s.textContent='Steer failed — try again.';}">
          <input type="hidden" id="dashboard-steer-template-agent" name="template_agent_id" value="${escapeHtml(defaultOption?.template_agent_id ?? "")}">
          <div class="cmd-steer-toolbar">
            <label class="cmd-steer-field">
              <span class="cmd-steer-label">Runtime</span>
              <select id="dashboard-steer-runtime" name="runtime_id" required onchange="updateDashboardSteerTarget(this)">
                ${steeringOptions.map((option) => `<option value="${escapeHtml(option.runtime_id)}" data-template-agent-id="${escapeHtml(option.template_agent_id)}"${option.can_steer ? "" : ` disabled data-disabled-reason="${escapeHtml(option.disabled_reason ?? "Runtime is not steerable.")}"`}>${escapeHtml(option.agent_name)}${option.task_title ? ` · ${escapeHtml(option.task_title)}` : ` · ${escapeHtml(option.task_id.slice(0, 8))}`}${option.session_id ? ` · session ${escapeHtml(option.session_id.slice(0, 8))}` : ""}${option.can_steer ? "" : ` · unavailable`}</option>`).join("")}
              </select>
            </label>
            <div class="cmd-steer-actions-row">
              <button type="button" class="btn-sm" onclick="openDashboardActivityModal()">Activity</button>
              <button type="submit" class="btn-sm"${steerableOptions.length === 0 ? " disabled" : ""}>Steer</button>
            </div>
          </div>
          <label class="cmd-steer-field cmd-steer-field-message">
            <span class="cmd-steer-label">Guidance</span>
            <textarea id="dashboard-steer-message" name="message" rows="2" placeholder="Provide updated guidance for the selected active agent..." required${steerableOptions.length === 0 ? " disabled" : ""} hx-preserve="true"></textarea>
          </label>
          <p id="dashboard-steer-status" class="muted cmd-steer-status">${escapeHtml("Select a runtime and send updated guidance.")}</p>
        </form>`
            : `<div class="cmd-steer-empty">
          <p class="muted cmd-steer-empty-text">${escapeHtml(dashboardSteeringReason)}</p>
          <button type="button" class="btn-sm" onclick="openDashboardActivityModal()">See Agent Activity</button>
        </div>`}
    </div>
  </div>`;
}

export function dashboardSteerPanelSlotFragment(
    steeringOptions: NonNullable<DashboardData["dashboardSteeringOptions"]>,
    isVisible: boolean,
): string {
    return `<div id="dashboard-steer-slot">${isVisible ? dashboardSteerPanelFragment(steeringOptions) : ""}</div>`;
}
