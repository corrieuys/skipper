import { DelegationData, delegationTableRow } from "./components";


export function taskDelegationsContent(delegations: DelegationData[]): string {
    return `<section class="card">
    <div class="section-heading">
      <div>
        <h2>Delegations</h2>
        <p class="muted">Parent/child handoffs for this task instance.</p>
      </div>
    </div>
    ${delegations.length === 0
            ? `<div class="empty-state"><div class="empty-state-icon">&#128257;</div><p>No delegations</p></div>`
            : `<table class="data-table">
      <thead><tr><th>Status</th><th>Parent Agent</th><th>Child Agent</th><th>Prompt</th><th>Created</th><th>Completed</th></tr></thead>
      <tbody>${delegations.map(delegationTableRow).join("")}</tbody>
    </table>`}
  </section>`;
}
