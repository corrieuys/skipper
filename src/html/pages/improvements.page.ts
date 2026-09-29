import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { improvementCard } from "../fragments/improvement-card.fragment";
import type { Improvement, ImprovementState } from "../../improvements/manager";

export type ImprovementsView = "pending" | "history";

export interface ImprovementsPageViewModel {
  view: ImprovementsView;
  items: Array<{ imp: Improvement; state: ImprovementState }>;
  pendingCount: number;
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

/** Pending-count badge; also pushed OOB by ws/ui-push.ts on improvement:changed. */
export function improvementsPendingCount(count: number, oob = false): string {
  return `<span id="imp-pending-count" class="sk-badge sk-badge--nav"${oob ? ' hx-swap-oob="outerHTML"' : ""}>${count}</span>`;
}

export function improvementsPage(vm: ImprovementsPageViewModel): string {
  const cards = vm.items.map(({ imp, state }) => improvementCard(imp, state)).join("");
  const tab = (view: ImprovementsView, label: string, extra = "") =>
    `<a href="/improvements${view === "history" ? "?view=history" : ""}" class="imp-tab${vm.view === view ? " imp-tab--active" : ""}">${label}${extra}</a>`;
  const empty = vm.view === "pending" ? "No pending improvements." : "No improvements yet.";

  return v2layout("Improvements", `
    ${navbar({ currentPath: "/improvements", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Improvements</h1>
      </div>
      <div class="sk-panel imp-toolbar">
        <div class="imp-tabs">
          ${tab("pending", "Pending ", improvementsPendingCount(vm.pendingCount))}
          ${tab("history", "All")}
        </div>
        <p class="sk-muted imp-intro">Changes Skipper staged for team phases, agent instructions and recurring task descriptions, plus skill suggestions. Nothing changes until you approve it.</p>
      </div>
      <div id="imp-list" class="imp-list" data-imp-view="${vm.view}">${cards}</div>
      <div class="sk-panel sk-panel__empty imp-empty">${empty}</div>
    </div>
  `, "/improvements", ["improvements"]);
}
