import { ForensicsData, escapeHtml } from "./components";
import { forensicsTerminalTails } from "./forensicsTerminalTails";
import { forensicsTokenUsage } from "./forensicsTokenUsage";
import { forensicsEscalations } from "./forensicsEscalations";
import { forensicsDelegationGroups } from "./forensicsDelegationGroups";
import { forensicsInstanceTree } from "./forensicsInstanceTree";
import { forensicsTimeline } from "./forensicsTimeline";

export function taskForensicsContent(forensics: ForensicsData): string {
    const hasData = forensics.timeline.length > 0 ||
        forensics.instances.length > 0 ||
        forensics.delegationGroups.length > 0 ||
        forensics.escalations.length > 0 ||
        forensics.tokenUsage.length > 0;

    const inconsistencies: string[] = [];
    const instanceById = new Map(forensics.instances.map((i) => [i.id, i]));
    for (const group of forensics.delegationGroups) {
        if (group.status === "completed") {
            const dangling = group.delegations.filter(
                (d) => d.status === "running" || d.status === "pending"
            );
            if (dangling.length > 0) {
                inconsistencies.push(
                    `Delegation group ${group.id.slice(0, 8)} is completed but has ${dangling.length} delegation(s) still marked running/pending.`
                );
            }
        }
    }
    for (const inst of forensics.instances) {
        if (inst.status === "running" &&
            inst.process_pid == null &&
            inst.exit_code != null) {
            inconsistencies.push(
                `Instance ${inst.id.slice(0, 8)} is marked running but has exit code ${inst.exit_code}.`
            );
        }
        if (inst.parent_instance_id && !instanceById.has(inst.parent_instance_id)) {
            inconsistencies.push(
                `Instance ${inst.id.slice(0, 8)} references missing parent instance ${inst.parent_instance_id.slice(0, 8)}.`
            );
        }
    }

    return `<details class="forensics-panel">
    <summary class="forensics-summary">
      <span class="forensics-toggle-icon">&#9654;</span>
      <h2 style="display:inline;margin:0">Forensics</h2>
      <span class="muted">${hasData ? `${forensics.timeline.length} events, ${forensics.instances.length} instances` : "no data"}</span>
    </summary>
    <div class="forensics-body">
      ${inconsistencies.length > 0 ? `<div class="card card-error"><h3 style="margin-top:0">Consistency Warnings</h3><ul>${inconsistencies.map((msg) => `<li>${escapeHtml(msg)}</li>`).join("")}</ul><p class="muted" style="margin-bottom:0">These warnings indicate state drift across task, instance, and delegation records.</p></div>` : ""}
      <details open><summary><h3 style="display:inline">Timeline</h3></summary>${forensicsTimeline(forensics.timeline)}</details>
      <details open><summary><h3 style="display:inline">Agent Instances</h3></summary>${forensicsInstanceTree(forensics.instances)}</details>
      <details><summary><h3 style="display:inline">Delegation Groups</h3> <span class="muted">(${forensics.delegationGroups.length})</span></summary>${forensicsDelegationGroups(forensics.delegationGroups)}</details>
      <details><summary><h3 style="display:inline">Escalations</h3> <span class="muted">(${forensics.escalations.length})</span></summary>${forensicsEscalations(forensics.escalations)}</details>
      <details><summary><h3 style="display:inline">Token Usage</h3></summary>${forensicsTokenUsage(forensics.tokenUsage)}</details>
      <details><summary><h3 style="display:inline">Terminal Output</h3></summary>${forensicsTerminalTails(forensics.terminalTails)}</details>
    </div>
  </details>`;
}
