import { escapeHtml } from "../atoms/escape-html";
import { formatTokenCount, totalTokens, type TokenBreakdown } from "../atoms/format-tokens";
import { badgeFragment } from "./badge.fragment";

export interface AgentTreeNode {
  instanceId: string;
  agentName: string;
  status: string;
  pid: number | null;
  depth: number;
  connector: string; // e.g., "├──", "└──", ""
  taskId: string;
  exitReason?: string | null;
  tokens?: TokenBreakdown;
  delegation?: { id: string; status: string; promptPreview: string } | null;
}

/**
 * Renders a single agent tree node with expandable inline terminal.
 * Click the node row to toggle the terminal accordion.
 */
export function treeNodeFragment(node: AgentTreeNode): string {
  const shortId = node.instanceId.slice(0, 8);
  return `<div class="sk-tree__node" style="--depth: ${node.depth}"
    data-sk-tree-node="${escapeHtml(node.instanceId)}"
    data-sk-tree-toggle="${escapeHtml(node.instanceId)}">
  ${node.depth > 0 ? `<span class="sk-tree__connector">${escapeHtml(node.connector)}</span>` : ""}
  ${badgeFragment(node.status)}
  ${node.exitReason === "escalated" ? `<span class="sk-tree__exit-reason" title="Agent exited via escalation; not a normal completion." style="font-size:10px;padding:1px 6px;border-radius:var(--sk-radius-sm);background:color-mix(in srgb, var(--sk-accent-warning) 25%, transparent);color:var(--sk-accent-warning);">escalated</span>` : ""}
  <span class="sk-tree__agent-name">${escapeHtml(node.agentName)}</span>
  <span class="sk-tree__meta">${shortId}${node.pid ? ` PID ${node.pid}` : ""}</span>
  ${node.tokens && totalTokens(node.tokens) > 0 ? `<span class="sk-tree__meta" title="${escapeHtml(`input ${node.tokens.input.toLocaleString()} · output ${node.tokens.output.toLocaleString()} · cache write ${node.tokens.cache_creation.toLocaleString()} · cache read ${node.tokens.cache_read.toLocaleString()}`)}" style="font-variant-numeric: tabular-nums;">${formatTokenCount(totalTokens(node.tokens))} tok</span>` : ""}
  ${node.delegation ? `<button type="button" class="sk-tree__delegation"
       title="${escapeHtml(node.delegation.promptPreview)}"
       data-sk-delegation-open="${escapeHtml(node.delegation.id)}"
       onclick="event.stopPropagation()">
     <span class="sk-tree__delegation-badge sk-tree__delegation-badge--${escapeHtml(node.delegation.status)}">${escapeHtml(node.delegation.status)}</span>
     <span class="sk-tree__delegation-preview">${escapeHtml(node.delegation.promptPreview)}</span>
   </button>` : ""}
  <span class="sk-tree__actions">
    <a href="/tasks/${escapeHtml(node.taskId)}/terminal/${escapeHtml(node.instanceId)}"
       class="sk-btn--link sk-text-xs" onclick="event.stopPropagation()">Full terminal &rarr;</a>
  </span>
</div>
<div id="tree-terminal-${escapeHtml(node.instanceId)}" class="sk-tree__terminal" style="display:none; --depth: ${node.depth}">
  <div id="tree-terminal-lines-${escapeHtml(node.instanceId)}" class="mc-activity__feed sk-tree__terminal-feed"
       data-sk-terminal-autoscroll
       data-sk-terminal-src="/agents/${escapeHtml(node.instanceId)}/activity?limit=80"
       hx-swap="innerHTML">
    <div class="mc-activity__empty">Loading activity...</div>
  </div>
</div>`;
}
