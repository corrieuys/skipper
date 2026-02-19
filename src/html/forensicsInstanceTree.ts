import { ForensicsAgentInstance, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";
import { computeDisplayStatus } from "./computeDisplayStatus";
import { staleBadge } from "./staleBadge";


export function forensicsInstanceTree(instances: ForensicsAgentInstance[]): string {
    if (instances.length === 0) return "";

    const instanceMap = new Map(instances.map((i) => [i.id, i]));

    function getDepth(inst: ForensicsAgentInstance): number {
        let depth = 0;
        let current = inst;
        while (current.parent_instance_id &&
            instanceMap.has(current.parent_instance_id)) {
            depth++;
            current = instanceMap.get(current.parent_instance_id)!;
        }
        return depth;
    }

    const rows = instances
        .map((inst) => {
            const depth = getDepth(inst);
            const name = inst.agent_name ?? inst.template_agent_id.slice(0, 8);
            const shortId = inst.id.slice(0, 8);
            const exitCodeBadge = inst.exit_code != null
                ? inst.exit_code === 0
                    ? `<span class="badge badge-completed">exit 0</span>`
                    : `<span class="badge badge-error">exit ${inst.exit_code}</span>`
                : "";
            const display = computeDisplayStatus(inst);
            const stale = staleBadge(inst.updated_at);
            return `<div class="forensics-instance-node" style="margin-left:${depth * 1.5}rem">
      <span class="badge badge-${inst.status}">${display.workflowState}</span>
      ${exitCodeBadge}
      ${stale}
      <strong>${escapeHtml(name)}</strong>
      <span class="muted">${escapeHtml(shortId)}</span>
      <span class="muted">attempt #${inst.attempt}</span>
      ${inst.session_id ? `<span class="muted">session ${escapeHtml(inst.session_id.slice(0, 8))}</span>` : ""}
      ${inst.process_pid ? `<span class="muted">PID ${inst.process_pid}</span>` : ""}
      <span class="muted">${formatTimestamp(inst.created_at)}</span>
    </div>`;
        })
        .join("");

    return `<div class="forensics-section">
    <h3>Agent Instances</h3>
    ${rows}
  </div>`;
}
