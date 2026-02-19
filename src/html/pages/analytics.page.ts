import type { TokenAnalyticsPageData } from "../components";
import { formatTimestamp } from "../formatTimestamp";
import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";

export interface AnalyticsPageViewModel {
  analytics: TokenAnalyticsPageData;
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function metricCard(label: string, value: string): string {
  return `<div class="sk-panel" style="margin:0;">
    <div class="sk-panel__body" style="text-align:center;">
      <div class="sk-text" style="font-size: var(--sk-text-xl); font-weight: 600;">${value}</div>
      <div class="sk-muted sk-text-xs" style="text-transform: uppercase; letter-spacing: 0.05em; margin-top: var(--sk-space-1);">${escapeHtml(label)}</div>
    </div>
  </div>`;
}

export function analyticsPage(vm: AnalyticsPageViewModel): string {
  const { analytics } = vm;
  const rows = analytics.groups.map((g) => `<tr>
    <td>
      <div class="sk-text">${escapeHtml(g.agent_name)}</div>
      <div class="sk-muted sk-text-xs sk-mono">${escapeHtml(g.provider)} · ${escapeHtml(g.model)}</div>
    </td>
    <td class="sk-mono">${fmt(g.input_tokens)}</td>
    <td class="sk-mono">${fmt(g.cache_read_tokens)}</td>
    <td class="sk-mono">${fmt(g.cache_write_tokens)}</td>
    <td class="sk-mono">${fmt(g.output_tokens)}</td>
    <td class="sk-mono"><strong>${fmt(g.total_tokens)}</strong></td>
    <td>${g.instance_count}</td>
    <td>${g.usage_event_count}</td>
  </tr>`).join("");

  const table = analytics.groups.length > 0
    ? `<table class="sk-table">
        <thead><tr><th>Agent</th><th>Input</th><th>Cache Read</th><th>Cache Write</th><th>Output</th><th>Total</th><th>Instances</th><th>Usage Events</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="sk-panel__empty">No token usage events found yet.</div>`;

  return v2layout("Token Analytics", `
    ${navbar({ currentPath: "/analytics", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container sk-container--full">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Token Analytics</h1>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--sk-space-3); margin-bottom: var(--sk-space-6);">
        ${metricCard("Input", fmt(analytics.summary.input_tokens))}
        ${metricCard("Cache Read", fmt(analytics.summary.cache_read_tokens))}
        ${metricCard("Cache Write", fmt(analytics.summary.cache_write_tokens))}
        ${metricCard("Output", fmt(analytics.summary.output_tokens))}
        ${metricCard("Total", fmt(analytics.summary.total_tokens))}
        ${metricCard("Instances", `${analytics.summary.instance_count}`)}
      </div>

      <div class="sk-panel">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Token Usage by Agent</span>
          <span class="sk-panel__count">${analytics.groups.length}</span>
        </div>
        <div class="sk-panel__body--flush">
          ${table}
        </div>
      </div>

      <p class="sk-muted sk-text-xs" style="margin-top: var(--sk-space-3);">
        All-time · Updated ${formatTimestamp(analytics.generated_at)} · ${analytics.groups.length} agents
      </p>
    </div>
  `, "/analytics");
}
