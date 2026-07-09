import { type ForensicsTokenUsage, escapeHtml } from "./components";


export function forensicsTokenUsage(usage: ForensicsTokenUsage[]): string {
    if (usage.length === 0) return "";

    function fmt(n: number | null): string {
        if (n == null) return "-";
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
        return String(n);
    }

    function fmtMs(n: number | null): string {
        if (n == null) return "-";
        if (n >= 60000) return `${(n / 60000).toFixed(1)}m`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
        return `${n}ms`;
    }

    const rows = usage
        .map(
            (u) => `<tr>
    <td>${u.agent_name ? escapeHtml(u.agent_name) : "-"}</td>
    <td class="muted">${escapeHtml(u.instance_id.slice(0, 8))}</td>
    <td><span class="badge badge-${u.status}">${u.status}</span></td>
    <td>${fmt(u.input_tokens)}</td>
    <td>${fmt(u.cache_read_input_tokens)}</td>
    <td>${fmt(u.cache_creation_input_tokens)}</td>
    <td>${fmt(u.output_tokens)}</td>
    <td>${u.num_turns ?? "-"}</td>
    <td>${fmtMs(u.duration_ms)}</td>
    <td>${u.context_compact_needed ? `<span class="badge badge-stopped">yes</span>` : "-"}</td>
    <td>${u.nudge_count > 0 ? u.nudge_count : "-"}</td>
  </tr>`
        )
        .join("");

    return `<div class="forensics-section">
    <h3>Token Usage</h3>
    <table class="data-table">
      <thead><tr><th>Agent</th><th>Instance</th><th>State</th><th>Input</th><th>Cache Read</th><th>Cache Write</th><th>Output</th><th>Turns</th><th>Duration</th><th>Compact</th><th>Nudges</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
