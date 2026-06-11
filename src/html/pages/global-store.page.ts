import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { globalStoreRowFragment } from "../fragments/global-store-edit.fragment";
import type { GlobalStoreRow } from "../../global-store/manager";

export interface GlobalStorePageViewModel {
  rows: GlobalStoreRow[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

export function globalStorePage(vm: GlobalStorePageViewModel): string {
  const rows = vm.rows.map(globalStoreRowFragment).join("");

  return v2layout("Global Store", `
    ${navbar({ currentPath: "/global-store", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Global Store</h1>
      </div>

      <div class="sk-panel">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Values</span>
          <span class="sk-panel__count">${vm.rows.length}</span>
          <button class="sk-btn sk-btn--sm sk-btn--primary" style="margin-left:auto;"
            hx-get="/fragments/global-store/new"
            hx-target="#gs-table" hx-swap="beforeend">New value</button>
        </div>
        <div class="sk-panel__body--flush">
          <table class="sk-table" id="gs-table">
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Data</th><th>Updated</th><th>By</th><th></th></tr></thead>
            ${rows}
          </table>
          ${vm.rows.length === 0 ? '<div class="sk-panel__empty">No global values yet</div>' : ""}
        </div>
      </div>
    </div>
  `, "/global-store");
}
