import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";

export interface GrugUsageRow {
  id: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  request_type: string;
  conversation_length: number;
  response_text: string;
  created_at: string;
}

export interface GrugPromptSection {
  title: string;
  body: string;
}

export interface GrugPageViewModel {
  usage: GrugUsageRow[];
  summary: {
    total_requests: number;
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_write: number;
    total_tokens: number;
    total_cost: number;
    tick_count: number;
    reply_count: number;
    avg_conversation_length: number;
  };
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
  sessionId: string | null;
  systemPrompt: string;
  unhinged: boolean;
  persona: string;
  personas: Array<{ id: string; label: string; emoji: string }>;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function metricCard(label: string, value: string, subtitle?: string): string {
  return `<div class="sk-panel" style="margin:0;">
    <div class="sk-panel__body" style="text-align:center;">
      <div class="sk-text" style="font-size: var(--sk-text-xl); font-weight: 600;">${value}</div>
      <div class="sk-muted sk-text-xs" style="text-transform: uppercase; letter-spacing: 0.05em; margin-top: var(--sk-space-1);">${escapeHtml(label)}</div>
      ${subtitle ? `<div class="sk-muted sk-text-xs" style="margin-top:2px;">${escapeHtml(subtitle)}</div>` : ""}
    </div>
  </div>`;
}

function timeAgo(dateStr: string): string {
  const now = new Date();
  const then = new Date(dateStr + "Z");
  const diff = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function renderPromptPanel(raw: string): string {
  const blocks = raw.split("\n\n").filter(b => b.trim());
  const rendered = blocks.map(block => {
    const trimmed = block.trim();

    // JSON schema block
    if (trimmed.startsWith("{")) {
      return `<pre class="sk-mono" style="background:var(--sk-bg-secondary);padding:var(--sk-space-3);border-radius:6px;font-size:12px;overflow-x:auto;margin:var(--sk-space-2) 0;">${escapeHtml(trimmed)}</pre>`;
    }

    // Section header detection: line that looks like a title (short, no period, followed by content)
    const lines = trimmed.split("\n");
    const firstLine = lines[0].trim();
    const isHeader = !firstLine.startsWith("-") && !firstLine.startsWith("RESPOND") && !firstLine.includes("{")
      && lines.length >= 2 && firstLine.length < 60 && !firstLine.endsWith(".");

    if (isHeader && lines.length >= 2) {
      const title = escapeHtml(firstLine);
      const body = lines.slice(1).map(l => escapeHtml(l.trim())).join("<br>");
      return `<div style="margin:var(--sk-space-3) 0;">
        <div class="sk-text" style="font-weight:600;font-size:13px;margin-bottom:var(--sk-space-1);">${title}</div>
        <div class="sk-muted" style="font-size:12px;line-height:1.5;">${body}</div>
      </div>`;
    }

    // Bullet list
    if (trimmed.startsWith("-")) {
      const items = trimmed.split("\n").map(l => {
        const text = l.replace(/^-\s*/, "").trim();
        return `<li style="margin-bottom:2px;">${escapeHtml(text)}</li>`;
      }).join("");
      return `<ul style="margin:var(--sk-space-2) 0;padding-left:var(--sk-space-4);font-size:12px;line-height:1.5;" class="sk-muted">${items}</ul>`;
    }

    // Numbered list
    if (/^\d+\./.test(trimmed)) {
      const items = trimmed.split("\n").map(l => {
        const text = l.replace(/^\d+\.\s*/, "").trim();
        return `<li style="margin-bottom:2px;">${escapeHtml(text)}</li>`;
      }).join("");
      return `<ol style="margin:var(--sk-space-2) 0;padding-left:var(--sk-space-4);font-size:12px;line-height:1.5;" class="sk-muted">${items}</ol>`;
    }

    // Heading-like line (all caps or starts with keyword)
    if (/^[A-Z]{4,}/.test(trimmed) || trimmed.startsWith("RESPOND")) {
      return `<div style="margin:var(--sk-space-3) 0;padding:var(--sk-space-2) var(--sk-space-3);background:var(--sk-bg-secondary);border-radius:4px;">
        <code class="sk-mono" style="font-size:11px;white-space:pre-wrap;">${escapeHtml(trimmed)}</code>
      </div>`;
    }

    // Grug belief block: "Title. rest of text" or "Title: rest"
    const colonOrPeriod = firstLine.match(/^(.+?)[.:]\s+(.+)/);
    if (colonOrPeriod && firstLine.length > 30) {
      const title = escapeHtml(colonOrPeriod[1]);
      const rest = lines.map(l => escapeHtml(l.trim())).join(" ");
      return `<div style="margin:var(--sk-space-2) 0;padding:var(--sk-space-2) var(--sk-space-3);border-left:2px solid var(--sk-border);font-size:12px;line-height:1.5;">
        <span class="sk-text" style="font-weight:600;">${title}.</span>
        <span class="sk-muted">${escapeHtml(rest.slice(title.length + 1).trim())}</span>
      </div>`;
    }

    // Default paragraph
    return `<p class="sk-muted" style="font-size:12px;line-height:1.5;margin:var(--sk-space-2) 0;">${escapeHtml(trimmed).replace(/\n/g, "<br>")}</p>`;
  }).join("");

  return rendered;
}

export function grugPage(vm: GrugPageViewModel): string {
  const { summary, usage, sessionId } = vm;

  const rows = usage.slice(0, 50).map((r) => `<tr>
    <td class="sk-muted sk-text-xs">${timeAgo(r.created_at)}</td>
    <td><span class="sk-badge sk-badge--${r.request_type === "tick" ? "info" : "success"}">${r.request_type}</span></td>
    <td class="sk-text-xs" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.response_text || "—")}</td>
    <td class="sk-mono">${fmt(r.input_tokens)}</td>
    <td class="sk-mono">${fmt(r.output_tokens)}</td>
    <td class="sk-mono">${fmt(r.cache_read_tokens)}</td>
    <td class="sk-mono">${fmt(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)}</td>
    <td class="sk-mono">$${r.cost_usd.toFixed(4)}</td>
  </tr>`).join("");

  const table = usage.length > 0
    ? `<table class="sk-table">
        <thead><tr><th>When</th><th>Type</th><th>Response</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Total</th><th>Cost</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="sk-panel__empty">greg has not spoken yet. Enable greg and wait for ticks.</div>`;

  const activeEmoji = vm.personas.find((p) => p.id === vm.persona)?.emoji ?? "🐒";

  return v2layout("Greg", `
    ${navbar({ currentPath: "/grug", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="sk-container sk-container--full">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">${activeEmoji} Greg Brain Monitor</h1>
        <p class="sk-muted sk-text-xs">token usage, conversation state, and greg vital signs</p>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--sk-space-3); margin-bottom: var(--sk-space-6);">
        ${metricCard("Total Cost", fmtCost(summary.total_cost))}
        ${metricCard("Total Tokens", fmt(summary.total_tokens))}
        ${metricCard("Input", fmt(summary.total_input))}
        ${metricCard("Output", fmt(summary.total_output))}
        ${metricCard("Cache Read", fmt(summary.total_cache_read))}
        ${metricCard("Requests", `${summary.total_requests}`, `${summary.tick_count} ticks · ${summary.reply_count} replies`)}
        ${metricCard("Session", sessionId ? sessionId.slice(0, 8) + "..." : "none")}
      </div>

      <div class="sk-panel">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Greg Activity</span>
          <span class="sk-panel__count">${usage.length}</span>
        </div>
        <div class="sk-panel__body--flush">
          ${table}
        </div>
      </div>

      <div class="sk-panel" style="margin-top: var(--sk-space-4);">
        <div class="sk-panel__header" style="cursor:pointer;" onclick="this.parentElement.querySelector('.sk-panel__body').toggleAttribute('hidden')">
          <span class="sk-panel__title">System Prompt</span>
          <span class="sk-muted sk-text-xs">click to expand</span>
        </div>
        <div class="sk-panel__body" hidden style="max-height:600px;overflow-y:auto;">
          ${renderPromptPanel(vm.systemPrompt)}
        </div>
      </div>

      <div style="margin-top: var(--sk-space-4); display:flex; gap: var(--sk-space-4); align-items:center; flex-wrap:wrap;">
        <button class="sk-btn sk-btn--sm" hx-post="/api/grug/reset" hx-swap="none" hx-confirm="Reset greg's conversation memory?">Reset Conversation</button>
        <label style="display:flex; align-items:center; gap: var(--sk-space-2); cursor:pointer;" class="sk-text-xs">
          <span class="sk-muted">Persona</span>
          <select name="persona" class="sk-select sk-select--sm"
            hx-post="/api/grug/persona" hx-trigger="change" hx-swap="none">
            ${vm.personas.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === vm.persona ? " selected" : ""}>${p.emoji} ${escapeHtml(p.label)}</option>`).join("")}
          </select>
        </label>
        <label style="display:flex; align-items:center; gap: var(--sk-space-2); cursor:pointer;" class="sk-text-xs">
          <input type="checkbox" name="enabled" ${vm.unhinged ? "checked" : ""}
            hx-post="/api/grug/unhinged" hx-trigger="change" hx-swap="none">
          😈 Unhinged mode <span class="sk-muted">(swearing + innuendo)</span>
        </label>
      </div>

      <p class="sk-muted sk-text-xs" style="margin-top: var(--sk-space-3);">
        Model: claude-haiku-4-5 via Claude Code CLI · Tick interval: 10s · Compacts every 20 ticks · Persistent session via --resume
      </p>
    </div>
  `, "/grug");
}
