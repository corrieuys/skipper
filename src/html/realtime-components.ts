// LEGACY realtime pieces. The standalone detail/new pages were deleted with the
// unified task model (conversational tasks render in the command center); the
// surviving exports are the fragment renderers used by ws/ui-push.ts and the
// /api/realtime-tasks/* routes.
import { formatTimestamp } from "./formatTimestamp";
import { escapeHtml } from "./atoms/escape-html";
import type { RunningAgentInstance, TaskNote, TimelineEntry } from "../contracts/types";
export type { RunningAgentInstance, TaskNote, TimelineEntry, PipelineStatus } from "../contracts/types";

export interface RealtimeTaskConfig {
  summarizer_agent_id?: string;
  assigned_agent_ids?: string[];
}


export interface AvailableAgent {
  id: string;
  name: string;
  type: string;
  capabilities: string;
}

export interface TeamAssignedAgent {
  id: string;
  name: string;
  role: string | null;
}

function timelineEntriesHtml(timeline: TimelineEntry[]): string {
  return `<div style="display:flex;flex-direction:column;gap:0.5rem;">
    ${timeline.map((entry) => {
    const badgeClass = entry.entry_type === "error" ? "danger" : entry.entry_type === "summary" ? "info" : "default";
    const typeLabel = entry.entry_type.toUpperCase();
    const priorityBadge = entry.priority === "high"
      ? ` <span class="badge badge-warning" style="font-size:0.6rem;">HIGH</span>`
      : "";
    return `<div class="rt-timeline-entry" data-type="${escapeHtml(entry.entry_type)}">
        <div class="rt-timeline-entry-header">
          <span class="badge badge-${badgeClass}">${typeLabel}</span>${priorityBadge}
          <span class="muted rt-timeline-entry-meta">${formatTimestamp(entry.created_at)}</span>
        </div>
        <div class="rt-timeline-entry-body">${escapeHtml(entry.content)}</div>
        ${entry.fed_to_skipper ? `<span class="muted rt-timeline-entry-meta" style="margin-top:0.3rem;display:inline-block;">Fed to Skipper</span>` : ""}
      </div>`;
  }).join("\n")}
  </div>`;
}

export function timelineEntriesFragment(timeline: TimelineEntry[]): string {
  if (timeline.length === 0) {
    return `<div class="empty-state"><p class="muted">No timeline entries yet</p></div>`;
  }
  return timelineEntriesHtml(timeline);
}

function agentAssignmentFormHtml(
  taskId: string,
  selectableAgents: AvailableAgent[],
  assignedIds: string[],
  summarizerId: string,
): string {
  return `<style>
      .rt-assign-form label.rt-field-label { display:block; margin-bottom:0.2rem; font-weight:600; font-size:0.75rem; letter-spacing:0.01em; color:var(--muted); }
      .rt-assign-form label.rt-agent-check {
        display:flex !important; align-items:center; gap:0.4rem;
        margin-bottom:0 !important; padding:0.35rem 0.5rem;
        border:1px solid var(--outline-variant); border-radius:0;
        font-size:0.82rem; cursor:pointer; transition:border-color 0.15s, background 0.15s;
      }
      .rt-assign-form label.rt-agent-check:hover { border-color:rgba(0,251,251,0.2); }
      .rt-assign-form label.rt-agent-check.checked { border-color:rgba(0,251,251,0.3); background:rgba(0,251,251,0.04); }
      .rt-assign-form label.rt-agent-check input[type="checkbox"] {
        display:inline-block !important; width:auto !important; margin:0 !important;
        flex-shrink:0; accent-color:var(--secondary);
      }
    </style>
    <form class="rt-assign-form" hx-post="/api/realtime-tasks/${escapeHtml(taskId)}/config"
               hx-target="#rt-agent-assignment" hx-swap="innerHTML"
               style="display:flex;flex-direction:column;gap:0.6rem;">
      <div>
        <label class="rt-field-label">Summarizer Agent</label>
        <select name="summarizer_agent_id">
          <option value="">None (basic concatenation)</option>
          ${selectableAgents.map(a =>
    `<option value="${escapeHtml(a.id)}"${a.id === summarizerId ? " selected" : ""}>${escapeHtml(a.name)} (${escapeHtml(a.type)})</option>`
  ).join("\n")}
        </select>
        <p class="muted" style="font-size:0.72rem;margin-top:0.15rem;">Processes and summarizes incoming segments.</p>
      </div>
      <div>
        <label class="rt-field-label">Delegation Agents</label>
        <div style="display:flex;flex-direction:column;gap:0.25rem;max-height:220px;overflow-y:auto;">
          ${selectableAgents.length === 0
      ? `<p class="muted" style="font-size:0.8rem;">No agents available. Create agents first.</p>`
      : selectableAgents.map(a => {
        const checked = assignedIds.includes(a.id);
        let caps: string[] = [];
        try { caps = JSON.parse(a.capabilities); } catch { }
        const capStr = caps.length > 0 ? caps.join(", ") : "";
        return `<label class="rt-agent-check${checked ? " checked" : ""}">
                <input type="checkbox" name="assigned_agent_ids" value="${escapeHtml(a.id)}"${checked ? " checked" : ""} />
                <strong>${escapeHtml(a.name)}</strong>${capStr ? `<span class="muted" style="font-size:0.75rem;">${escapeHtml(capStr)}</span>` : ""}
              </label>`;
      }).join("\n")}
        </div>
        <p class="muted" style="font-size:0.72rem;margin-top:0.15rem;">Skipper can delegate work to checked agents.</p>
      </div>
      <button type="submit" class="btn-sm" style="align-self:flex-end;">Save</button>
    </form>`;
}

export function agentAssignmentFragment(
  taskId: string,
  selectableAgents: AvailableAgent[],
  assignedIds: string[],
  summarizerId: string,
): string {
  return agentAssignmentFormHtml(taskId, selectableAgents, assignedIds, summarizerId);
}

function agentsListHtml(agents: RunningAgentInstance[]): string {
  if (agents.length === 0) {
    return `<div style="padding:0.75rem 0;text-align:center;">
      <p class="muted" style="font-size:0.85rem;">No agent activity yet</p>
    </div>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:0.4rem;">
    ${agents.map((a) => {
    const isActive = a.status === "running" || a.status === "pending";
    const badgeClass = a.status === "running" ? "running" : a.status === "completed" ? "completed" : a.status === "pending" ? "paused" : "default";
    return `<div class="rt-agent-item ${isActive ? "rt-agent-item-running" : ""}">
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;">
            ${isActive ? '<span class="rt-agent-running-dot"></span>' : ""}
            <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.agent_name)}</strong>
          </div>
          <span class="muted" style="font-size:0.75rem;">${escapeHtml(a.template_agent_id)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
          <span class="badge badge-${badgeClass}" style="font-size:0.7rem;">${escapeHtml(a.status)}</span>
          <span class="muted" style="font-size:0.7rem;">${formatTimestamp(a.created_at)}</span>
        </div>
      </div>`;
  }).join("\n")}
  </div>`;
}

export function runningAgentsFragment(agents: RunningAgentInstance[]): string {
  return agentsListHtml(agents);
}

function notesFragmentHtml(notes: TaskNote[]): string {
  if (notes.length === 0) {
    return `<p class="muted" style="font-size:0.9rem;">No notes yet</p>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:0.6rem;">
    ${notes.map((n) => `<div class="note-item">
      <div class="note-header">
        <span class="note-agent">${escapeHtml(n.agent_name ?? n.agent_id)}</span>
        <span class="note-time">${formatTimestamp(n.created_at)}</span>
      </div>
      <div class="note-body">${escapeHtml(n.content)}</div>
    </div>`).join("\n")}
  </div>`;
}

export function notesFragment(notes: TaskNote[]): string {
  return notesFragmentHtml(notes);
}
