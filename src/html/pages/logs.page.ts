import type { LogEntryData, LogFilters } from "../components";
import { logsTableFragment } from "../components";
import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";

export interface LogsPageViewModel {
  entries: LogEntryData[];
  filters: LogFilters;
  agents: { id: string; name: string }[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

export function logsPage(vm: LogsPageViewModel): string {
  const query = new URLSearchParams();
  if (vm.filters.agent_id) query.set("agent_id", vm.filters.agent_id);
  if (vm.filters.stream) query.set("stream", vm.filters.stream);
  const hasFilters = query.size > 0;
  const bodyId = hasFilters ? "log-entries-body-filtered" : "log-entries-body";
  const fragmentPath = `/fragments/logs/table${query.size > 0 ? `?${query.toString()}` : ""}`;
  const liveHint = "Live log updates stream in about every 1.5 seconds.";

  const agentOptions = vm.agents
    .map((a) => `<option value="${escapeHtml(a.id)}"${vm.filters.agent_id === a.id ? " selected" : ""}>${escapeHtml(a.name)}</option>`)
    .join("");

  return v2layout("Agent Logs", `
    ${navbar({ currentPath: "/logs", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container sk-container--full">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Agent Logs</h1>
      </div>

      <div class="sk-panel" style="margin-bottom: var(--sk-space-4);">
        <div class="sk-panel__body">
          <form hx-get="/logs" hx-target="body" hx-push-url="true" style="display:flex; align-items:flex-end; gap: var(--sk-space-3); flex-wrap:wrap;">
            <div class="sk-form-group" style="margin:0;">
              <label class="sk-label">Agent</label>
              <select name="agent_id" class="sk-select">
                <option value="">All agents</option>
                ${agentOptions}
              </select>
            </div>
            <div class="sk-form-group" style="margin:0;">
              <label class="sk-label">Stream</label>
              <select name="stream" class="sk-select">
                <option value="">All streams</option>
                <option value="stdout"${vm.filters.stream === "stdout" ? " selected" : ""}>stdout</option>
                <option value="stderr"${vm.filters.stream === "stderr" ? " selected" : ""}>stderr</option>
              </select>
            </div>
            <div style="display:flex; gap: var(--sk-space-2);">
              <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Filter</button>
              <button type="button" class="sk-btn sk-btn--sm" hx-get="/logs" hx-target="body" hx-push-url="true">Clear</button>
            </div>
          </form>
        </div>
      </div>

      <div id="log-entries" class="sk-panel">
        <div class="sk-panel__header" style="display:flex; align-items:center; gap: var(--sk-space-3); flex-wrap:wrap;">
          <span class="sk-muted sk-text-sm" style="flex:1;">${escapeHtml(liveHint)}</span>
          ${hasFilters
            ? `<span class="sk-badge sk-badge--draft">Filtered View</span>
               <span class="sk-muted sk-text-sm">Live feed paused.</span>`
            : `<span id="logs-live-status" class="sk-badge sk-badge--running">Live</span>
               <label class="sk-text-xs" style="display:inline-flex; align-items:center; gap:0.3rem; cursor:pointer;">
                 <input id="logs-live-toggle" type="checkbox" checked> Live updates
               </label>
               <button type="button" class="sk-btn sk-btn--sm" data-logs-action="jump-newest">Jump to newest</button>`}
        </div>
        <div class="sk-panel__body--flush">
          <div id="${bodyId}" style="max-height: 70vh; overflow:auto;" hx-get="${escapeHtml(fragmentPath)}" hx-trigger="load" hx-swap="innerHTML">
            ${logsTableFragment(vm.entries)}
          </div>
        </div>
      </div>
    </div>
    <script>
      (() => {
        const FLAG = "__skipperLogsFeedInit";
        if (window[FLAG]) return;
        window[FLAG] = true;

        const LIVE_UPDATES_ENABLED = ${hasFilters ? "false" : "true"};
        if (!LIVE_UPDATES_ENABLED) return;

        const SWAP_TARGET_ID = "${bodyId}";
        const CONTAINER_ID = "log-entries";
        const TOP_THRESHOLD = 24;
        const EDGE_THRESHOLD = 24;
        const state = {
          paused: false,
          lastTop: 0,
          lastHeight: 0,
          wasNearTop: true,
          wasNearBottom: false,
          hasCapture: false,
        };

        const getContainer = () => document.getElementById(CONTAINER_ID);
        const getLiveToggle = () => document.getElementById("logs-live-toggle");
        const getStatus = () => document.getElementById("logs-live-status");
        const getSwapTarget = (detail) => {
          const candidates = [detail?.target, detail?.elt];
          for (const candidate of candidates) {
            if (candidate && candidate.id === SWAP_TARGET_ID) return candidate;
          }
          return null;
        };
        const updateLiveState = () => {
          const toggle = getLiveToggle();
          if (!(toggle instanceof HTMLInputElement)) return;
          state.paused = !toggle.checked;
          const status = getStatus();
          if (!status) return;
          status.textContent = state.paused ? "Paused" : "Live";
          status.className = state.paused ? "sk-badge sk-badge--draft" : "sk-badge sk-badge--running";
        };

        const capturePosition = (event) => {
          const target = getSwapTarget(event.detail);
          if (!target) return;
          if (state.paused) {
            if (event.detail) event.detail.shouldSwap = false;
            return;
          }
          const container = getContainer();
          if (!container) return;
          state.lastTop = container.scrollTop;
          state.lastHeight = container.scrollHeight;
          state.wasNearTop = container.scrollTop <= TOP_THRESHOLD;
          state.wasNearBottom = (container.scrollHeight - (container.scrollTop + container.clientHeight)) <= EDGE_THRESHOLD;
          state.hasCapture = true;
        };

        const restorePosition = (event) => {
          const target = getSwapTarget(event.detail);
          if (!target || !state.hasCapture) return;
          const container = getContainer();
          if (!container) return;
          requestAnimationFrame(() => {
            if (state.wasNearTop) {
              container.scrollTop = 0;
            } else if (state.wasNearBottom) {
              container.scrollTop = container.scrollHeight;
            } else {
              const delta = container.scrollHeight - state.lastHeight;
              container.scrollTop = Math.max(0, state.lastTop + delta);
            }
            state.hasCapture = false;
          });
        };

        document.addEventListener("htmx:oobBeforeSwap", capturePosition);
        document.addEventListener("htmx:beforeSwap", capturePosition);
        document.addEventListener("htmx:oobAfterSwap", restorePosition);
        document.addEventListener("htmx:afterSwap", restorePosition);

        document.addEventListener("change", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLInputElement)) return;
          if (target.id !== "logs-live-toggle") return;
          updateLiveState();
        });

        document.addEventListener("click", (event) => {
          const element = event.target instanceof Element ? event.target.closest("[data-logs-action]") : null;
          if (!element) return;
          const action = element.getAttribute("data-logs-action");
          if (action !== "jump-newest") return;
          const container = getContainer();
          if (!container) return;
          container.scrollTop = 0;
        });

        updateLiveState();
      })();
    </script>
  `, "/logs");
}
