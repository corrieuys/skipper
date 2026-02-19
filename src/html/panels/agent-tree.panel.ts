import { treeNodeFragment, type AgentTreeNode } from "../fragments/tree-node.fragment";

export const FRAGMENT_ID = "sk-agent-tree";

export interface AgentTreeData {
  nodes: AgentTreeNode[];
  delegationSummary: string; // e.g., "1 group, 2/3 settled"
}

/**
 * Hierarchical agent execution tree panel.
 * Shows parent→child delegation structure with expandable inline terminals.
 */
export function agentTreePanel(data: AgentTreeData): string {
  if (data.nodes.length === 0) {
    return `<div id="${FRAGMENT_ID}" class="sk-panel">
      <div class="sk-panel__header">
        <span class="sk-panel__title">Agent Tree</span>
      </div>
      <div class="sk-panel__empty">No agents running</div>
    </div>`;
  }

  const nodeHtml = data.nodes.map((n) => treeNodeFragment(n)).join("");

  return `<div id="${FRAGMENT_ID}" class="sk-panel">
    <div class="sk-panel__header">
      <span class="sk-panel__title">Agent Tree</span>
      <span class="sk-panel__count">${data.nodes.length} agents</span>
    </div>
    <div class="sk-panel__body--flush">
      <div class="sk-tree">${nodeHtml}</div>
    </div>
    ${data.delegationSummary ? `<div class="sk-panel__body" style="padding: var(--sk-space-2) var(--sk-space-3); border-top: 1px solid var(--sk-border); font-size: var(--sk-text-xs); color: var(--sk-text-muted);">${data.delegationSummary}</div>` : ""}
  </div>`;
}
