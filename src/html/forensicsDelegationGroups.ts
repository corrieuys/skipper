import { type ForensicsDelegationGroup, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";


export function forensicsDelegationGroups(groups: ForensicsDelegationGroup[]): string {
    if (groups.length === 0) return "";

    const cards = groups
        .map((g) => {
            const delegationRows = g.delegations
                .map((d) => {
                    const prompt = d.prompt.length > 80 ? d.prompt.slice(0, 80) + "…" : d.prompt;
                    const statusLabel = g.status === "completed" &&
                        (d.status === "running" || d.status === "pending")
                        ? "stale-running"
                        : d.status;
                    const statusClass = g.status === "completed" &&
                        (d.status === "running" || d.status === "pending")
                        ? "error"
                        : d.status;
                    return `<tr>
        <td><span class="badge badge-${statusClass}">${statusLabel}</span></td>
        <td>${d.parent_agent_name ? escapeHtml(d.parent_agent_name) : "-"}</td>
        <td>${d.child_agent_name ? escapeHtml(d.child_agent_name) : "-"}</td>
        <td><details><summary class="muted">${escapeHtml(prompt)}</summary><pre style="white-space:pre-wrap;margin-top:0.3rem">${escapeHtml(d.prompt)}</pre>${d.result ? `<div style="margin-top:0.3rem"><strong>Result:</strong><pre style="white-space:pre-wrap">${escapeHtml(d.result)}</pre></div>` : ""}</details></td>
        <td>${formatTimestamp(d.created_at)}</td>
        <td>${d.completed_at ? formatTimestamp(d.completed_at) : "-"}</td>
      </tr>`;
                })
                .join("");

            const danglingCount = g.delegations.filter(
                (d) => d.status === "running" || d.status === "pending"
            ).length;
            const statusExplanation = g.status === "completed"
                ? danglingCount > 0
                    ? `<span class="muted">Completed group, but ${danglingCount} child record(s) still marked running/pending.</span>`
                    : `<span class="muted">All child delegations settled.</span>`
                : `<span class="muted">Waiting for ${Math.max(g.expected_count - g.settled_count, 0)} unsettled child result(s).</span>`;

            return `<div class="card" style="margin-bottom:0.5rem">
      <div class="detail-grid">
        <div><strong>Group:</strong> ${escapeHtml(g.id.slice(0, 8))}</div>
        <div><strong>Policy:</strong> ${escapeHtml(g.policy)}</div>
        <div><strong>Progress:</strong> ${g.settled_count}/${g.expected_count} (${g.failed_count} failed)</div>
        <div><strong>Status:</strong> <span class="badge badge-${g.status}">${g.status}</span></div>
        <div><strong>Created:</strong> ${formatTimestamp(g.created_at)}</div>
        <div><strong>Completed:</strong> ${g.completed_at ? formatTimestamp(g.completed_at) : "-"}</div>
      </div>
      <div style="margin-top:0.25rem">${statusExplanation}</div>
      ${g.delegations.length > 0
                    ? `<table class="data-table" style="margin-top:0.5rem">
        <thead><tr><th>Status</th><th>Parent</th><th>Child</th><th>Prompt</th><th>Created</th><th>Completed</th></tr></thead>
        <tbody>${delegationRows}</tbody>
      </table>`
                    : `<p class="muted" style="margin-top:0.4rem">No delegations in this group.</p>`}
    </div>`;
        })
        .join("");

    return `<div class="forensics-section">
    <h3>Delegation Groups</h3>
    ${cards}
  </div>`;
}
