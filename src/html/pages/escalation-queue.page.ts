import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escalationCardPanel, type EscalationCardData } from "../panels/escalation-card.panel";

export interface EscalationQueueViewModel {
  open: EscalationCardData[];
  resolved: EscalationCardData[];
  escalationCount: number;
  daemonState: string;
  daemonUptime: number;
}

export function escalationQueuePage(vm: EscalationQueueViewModel): string {
  return v2layout("Escalations", `
    ${navbar({ currentPath: "/escalations", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Escalations</h1>
      </div>

      <div id="sk-escalation-list">
        <h2 class="sk-eyebrow sk-mb-4">Open (${vm.open.length})</h2>
        ${vm.open.length > 0
          ? vm.open.map((e) => escalationCardPanel(e)).join("")
          : `<div class="sk-panel sk-mb-4"><div class="sk-panel__empty">No open escalations</div></div>`
        }

        <h2 class="sk-eyebrow sk-mb-4 sk-mt-4">Resolved (${vm.resolved.length})</h2>
        ${vm.resolved.length > 0
          ? vm.resolved.map((e) => escalationCardPanel(e)).join("")
          : `<div class="sk-panel"><div class="sk-panel__empty">No resolved escalations</div></div>`
        }
      </div>
    </div>
  `, "/escalations", ["escalations"]);
}
