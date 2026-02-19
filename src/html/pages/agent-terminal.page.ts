import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { badgeFragment } from "../fragments/badge.fragment";

export interface AgentTerminalViewModel {
  instanceId: string;
  agentName: string;
  status: string;
  pid: number | null;
  taskId: string;
  taskTitle: string;
  lineCount: number;
  escalationCount: number;
  daemonState: string;
  daemonUptime: number;
}

export function agentTerminalPage(vm: AgentTerminalViewModel): string {
  return v2layout(`Terminal: ${vm.agentName}`, `
    ${navbar({ currentPath: `/tasks/${vm.taskId}/terminal/${vm.instanceId}`, daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div style="display:flex; flex-direction:column; height: calc(100vh - 48px);">
      <!-- Header bar -->
      <div class="sk-flex sk-items-center sk-gap-3" style="padding: var(--sk-space-2) var(--sk-space-4); background: var(--sk-surface-2); border-bottom: 1px solid var(--sk-border);">
        <a href="/?task=${escapeHtml(vm.taskId)}" class="sk-page-header__back">&larr; ${escapeHtml(vm.taskTitle)}</a>
        <strong style="color: var(--sk-text);">${escapeHtml(vm.agentName)}</strong>
        ${badgeFragment(vm.status)}
        ${vm.pid ? `<span class="sk-mono sk-muted sk-text-xs">PID ${vm.pid}</span>` : ""}
        <span class="sk-muted sk-text-xs">${vm.lineCount} lines</span>
      </div>

      <!-- Terminal body -->
      <div id="terminal-lines" class="sk-terminal sk-terminal--fullpage"
           data-sk-terminal-autoscroll
           hx-get="/agents/${escapeHtml(vm.instanceId)}/output"
           hx-trigger="load"
           hx-swap="innerHTML">
        <span class="sk-muted">Loading terminal output...</span>
      </div>

    </div>
  `, `/tasks/${vm.taskId}/terminal/${vm.instanceId}`, [`agent:${vm.instanceId}`]);
}
