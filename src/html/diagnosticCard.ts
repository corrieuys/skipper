import { escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";


export function diagnosticCard(diagnostic: {
    taskId: string;
    taskStatus: string;
    orchestrationStep: string | null;
    assignedAgent: { id: string; pid: number | null; status: string; } | null;
    liveInstances: Array<{ id: string; status: string; pid: number | null; }>;
    activeDelegations: Array<{
        id: string;
        status: string;
        child_instance_id: string | null;
    }>;
    openEscalations: Array<{ id: string; question: string; }>;
    recentErrors: Array<{
        category: string;
        message: string;
        created_at: string;
    }>;
    likely_reasons: string[];
}): string {
    return `<div class="card diagnostic-card">
    <h3>Task Diagnostic</h3>
    <div class="detail-grid">
      <div><strong>Status:</strong> <span class="badge badge-${diagnostic.taskStatus}">${diagnostic.taskStatus}</span></div>
      <div><strong>Orchestration Step:</strong> ${diagnostic.orchestrationStep ?? "unknown"}</div>
      <div><strong>Assigned Agent:</strong> ${diagnostic.assignedAgent ? `${escapeHtml(diagnostic.assignedAgent.id.slice(0, 8))} (PID: ${diagnostic.assignedAgent.pid ?? "none"})` : "none"}</div>
      <div><strong>Live Instances:</strong> ${diagnostic.liveInstances.length}</div>
      <div><strong>Active Delegations:</strong> ${diagnostic.activeDelegations.length}</div>
      <div><strong>Open Escalations:</strong> ${diagnostic.openEscalations.length}</div>
    </div>
    <h4>Likely Reasons</h4>
    <ul>${diagnostic.likely_reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
    ${diagnostic.recentErrors.length > 0 ? `<h4>Recent Errors</h4><ul>${diagnostic.recentErrors.map((e) => `<li><strong>${escapeHtml(e.category)}:</strong> ${escapeHtml(e.message)} (${formatTimestamp(e.created_at)})</li>`).join("")}</ul>` : ""}
  </div>`;
}
