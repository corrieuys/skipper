import type { Database } from "bun:sqlite";
import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { renderInlineMarkdown } from "../atoms/render-inline-markdown";
import { renderMessageBody } from "../atoms/render-message-body";
import { terminalJsonSummary, stripThinking, classifyPlainTerminalLine } from "../terminalJsonSummary";
import { renderAgentText } from "../atoms/render-agent-text";
import { escalationCardPanel, type EscalationCardData } from "../panels/escalation-card.panel";
import { sanitizeColor } from "../atoms/creature";

/**
 * Unified task timeline for the v2 UI: operator messages (task_messages) render
 * as cards, agent prose (assistant text frames from terminal_outputs) renders
 * as quiet uncolored entries alongside the tool groups,
 * consecutive tool/system frames collapse into expandable groups, and
 * escalations sit inline as resolvable cards (the same escalationCardPanel the
 * classic Escalations tab uses, so resolve/dismiss swaps work unchanged).
 * Chronological, oldest first; the client sticks the scroll to the bottom.
 *
 * Shared by the /workspace/task/:id/timeline route and the WS live-push.
 */

interface TerminalRow {
  stream: string;
  data: string;
  agent_name: string;
  agent_color: string | null;
  created_at: string;
}

interface OpMessageRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  agent_color: string | null;
  content: string;
  format: string | null;
  created_at: string;
}

interface TimelineItem {
  t: string;
  html: string;
}

const MAX_ITEMS = 300;
const MAX_GROUP_ROWS = 40;

// Stable small palette index per agent name; colors come from theme tokens.
function avatarIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 4;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const chars = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2);
  return chars.toUpperCase();
}

/** Classify one raw terminal frame; mirrors parseTerminalActivity's rules. */
function classifyRow(stream: string, rawData: string): { kind: "message" | "tool" | "event"; summary: string } {
  const data = rawData.trim();
  let kind: "message" | "tool" | "event" = "event";
  let summary = "";

  if (data.startsWith("{")) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(data);
    } catch {
      const firstLine = data.split("\n").find((l) => l.trim().startsWith("{"));
      if (firstLine) {
        try { parsed = JSON.parse(firstLine.trim()); } catch { /* give up */ }
      }
    }

    if (parsed) {
      // Final `result` frames repeat the last assistant text verbatim; showing
      // both renders every closing message twice. Drop the result frame.
      if (parsed.type === "result") return { kind: "event", summary: "" };
      summary = terminalJsonSummary(parsed);
      const type = typeof parsed.type === "string" ? parsed.type : "";
      const item = parsed.item && typeof parsed.item === "object" ? parsed.item as Record<string, unknown> : null;
      const itemType = item && typeof item.type === "string" ? item.type : "";
      const message = parsed.message && typeof parsed.message === "object" ? parsed.message as Record<string, unknown> : null;
      const content = message?.content;

      if (itemType === "command_execution" || itemType === "tool_call" || itemType === "tool_result" || itemType === "tool_use" || type.includes("tool")) {
        kind = "tool";
      } else if (Array.isArray(content)) {
        const hasToolBlock = content.some((b: any) => b?.type === "tool_use" || b?.type === "tool_result");
        kind = hasToolBlock ? "tool" : "message";
      } else if (type === "assistant" || type === "user" || type === "message" || typeof parsed.result === "string"
        || ((type === "text" || type === "thought") && typeof parsed.data === "string")
        || (type === "text" && !!(parsed.part as Record<string, unknown> | undefined)?.text)) {
        kind = "message";
      }
    } else {
      summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
      kind = classifyPlainTerminalLine(stream, data);
    }
  } else {
    summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
    kind = classifyPlainTerminalLine(stream, data);
  }

  if (kind === "message") summary = stripThinking(summary);
  return { kind, summary };
}

function activityDataAttrs(row: { data: string; agent_name?: string; created_at?: string }, kind: string): string {
  return `data-sk-activity-row
    data-sk-activity-data="${escapeHtml(row.data)}"
    data-sk-activity-agent="${escapeHtml(row.agent_name ?? "")}"
    data-sk-activity-pid=""
    data-sk-activity-time="${escapeHtml(row.created_at ?? "")}"
    data-sk-activity-kind="${kind}"`;
}

/** Inline `color:` style for an agent's chosen color, or "" to fall back to the
 *  default (prose) / name-hash bucket (card). */
function whoColorStyle(color: string | null | undefined): string {
  return color ? ` style="color:${sanitizeColor(color)}"` : "";
}

/** Agent prose from terminal frames: quiet inline entry. The agent's chosen color
 *  tints its name; body text stays default for readability. Operator messages
 *  (task_messages) keep the full card via messageCard. */
function proseEntry(agent: string, time: string, bodyHtml: string, attrs = "", color: string | null = null): string {
  return `<div class="tc-prose" ${attrs}>
    <span class="tc-prose__who"${whoColorStyle(color)}>${escapeHtml(agent)}</span>
    <time class="tc-prose__time">${formatTimestamp(time)}</time>
    <span class="tc-prose__body">${bodyHtml}</span>
  </div>`;
}

function messageCard(agent: string, kindLabel: string, time: string, bodyHtml: string, attrs = "", color: string | null = null): string {
  const idx = avatarIndex(agent);
  // Chosen color tints the avatar + name; otherwise fall back to the name-hash bucket.
  const c = color ? sanitizeColor(color) : null;
  const avAttr = c ? ` class="tc-av" style="background:${c}"` : ` class="tc-av tc-av--${idx}"`;
  const whoAttr = c ? ` class="tc-entry__who" style="color:${c}"` : ` class="tc-entry__who tc-who--${idx}"`;
  return `<div class="tc-entry">
    <div class="tc-entry__meta">
      <div${avAttr}>${escapeHtml(initials(agent))}</div>
      <span${whoAttr}>${escapeHtml(agent)}</span>
      ${kindLabel ? `<span class="tc-entry__kind">${escapeHtml(kindLabel)}</span>` : ""}
      <time class="tc-entry__time">${formatTimestamp(time)}</time>
    </div>
    <div class="tc-entry__card" ${attrs}>${bodyHtml}</div>
  </div>`;
}

interface SysBuffer {
  agent: string;
  color: string | null;
  count: number;
  toolCount: number;
  rows: Array<{ summary: string; data: string; time: string }>;
  /** Time of the group's first frame — stable while the group accumulates, so
   *  the client can keep it expanded across live re-renders (data-tc-keep). */
  firstTime: string;
  lastTime: string;
}

function sysGroupHtml(buf: SysBuffer): string {
  const rowsHtml = buf.rows.map((r) =>
    `<div class="tc-sys__row" ${activityDataAttrs({ data: r.data, agent_name: buf.agent, created_at: r.time }, "tool")}>
      <span class="tc-sys__time">${formatTimestamp(r.time)}</span>
      <span class="tc-sys__text">${escapeHtml(r.summary)}</span>
    </div>`,
  ).join("");
  const overflow = buf.count > buf.rows.length
    ? `<div class="tc-sys__row tc-sys__row--overflow">and ${buf.count - buf.rows.length} earlier</div>`
    : "";
  const sysCount = buf.count - buf.toolCount;
  const parts: string[] = [];
  if (buf.toolCount > 0) parts.push(buf.toolCount === 1 ? "1 tool call" : `${buf.toolCount} tool calls`);
  if (sysCount > 0) parts.push(sysCount === 1 ? "1 system event" : `${sysCount} system events`);
  const label = parts.join(", ") || `${buf.count} events`;
  return `<details class="tc-sys" data-tc-keep="sys:${escapeHtml(buf.agent)}:${escapeHtml(buf.firstTime)}">
    <summary><span class="tc-sys__who"${whoColorStyle(buf.color)}>${escapeHtml(buf.agent)}</span><span class="tc-sys__label">${label}</span></summary>
    <div class="tc-sys__rows">${overflow}${rowsHtml}</div>
  </details>`;
}

// Escalation text may be raw or entity-encoded HTML; renderAgentText decodes
// then sniffs so it renders instead of leaking raw tags (shared with the card).
const agentText = renderAgentText;

/** Resolved escalations collapse to one quiet line; expanding shows the
 *  question and the response given. Open ones keep the full resolvable card. */
function resolvedEscalationHtml(e: EscalationCardData): string {
  const agentLabel = e.agent_name ?? e.agent_id.slice(0, 12);
  const dismissed = e.response === "Dismissed by operator.";
  return `<details class="tc-esc-done" data-tc-keep="esc:${escapeHtml(e.id)}">
    <summary>
      <span class="tc-esc-done__tick">&#x2713;</span>
      <span class="tc-esc-done__label">Escalation ${dismissed ? "dismissed" : "resolved"}</span>
      <span class="tc-esc-done__who">${escapeHtml(agentLabel)} &middot; ${escapeHtml(e.type)}</span>
      <time class="tc-esc-done__time">${formatTimestamp(e.resolved_at ?? e.created_at)}</time>
    </summary>
    <div class="tc-esc-done__body">
      <div class="tc-esc-done__q">${agentText(e.question)}</div>
      <div class="tc-esc-done__r">
        <span class="tc-esc-done__rlbl">Response</span>
        ${agentText(e.response ?? "Dismissed")}
      </div>
    </div>
  </details>`;
}

/** An open escalation shows only a compact banner in the timeline (sticky to the
 *  top or bottom edge while its position is off screen); clicking it opens the
 *  full resolvable card in a modal. The card markup rides along in an inert
 *  <template> so no duplicate #escalation-<id> id sits in the live DOM. */
function escalationBanner(e: EscalationCardData): string {
  const agentLabel = e.agent_name ?? e.agent_id.slice(0, 12);
  return `<div class="tc-esc-banner-wrap">
    <button type="button" class="tc-esc-banner" data-esc-open="${escapeHtml(e.id)}">
      <span class="tc-esc-banner__bang">!</span>
      <span class="tc-esc-banner__who">${escapeHtml(agentLabel)}</span>
      <span class="tc-esc-banner__msg">needs your response</span>
      <time class="tc-esc-banner__time">${formatTimestamp(e.created_at)}</time>
    </button>
    <template data-esc-tpl="${escapeHtml(e.id)}">${escalationCardPanel(e)}</template>
  </div>`;
}

export function taskTimelineFragment(db: Database, taskId: string): string {
  // `substr(t.data,1,32768)` caps per-row transfer + render cost. Some legacy
  // rows hold up to 256KB frames (a few tasks emitted giant tool-output dumps,
  // bloating terminal_outputs to ~200MB on one task); reading the full blobs for
  // the whole window took multiple seconds. New frames are already capped at
  // ingest (manager.ts:MAX_TERMINAL_OUTPUT_BYTES); the substr also bounds the
  // pre-existing oversized rows without deleting them. The activity feed already
  // tolerates a truncated/unparseable frame (it drops rows it can't summarise).
  // LIMIT lowered 2400→1000: 1000 entries already exceeds what a human scrolls,
  // and fewer rows means fewer DOM nodes to build client-side.
  const terminalDesc = db.prepare(
    `SELECT t.stream, substr(t.data, 1, 32768) AS data, COALESCE(a.name, ai.template_agent_id) AS agent_name,
            json_extract(a.config, '$.color') AS agent_color, t.created_at
     FROM terminal_outputs t
     JOIN agent_instances ai ON ai.id = t.agent_id
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     WHERE ai.task_id = ?
     ORDER BY t.id DESC LIMIT 1000`,
  ).all(taskId) as TerminalRow[];
  const terminal = terminalDesc.reverse();

  const opMessages = db.prepare(
    `SELECT m.id, m.agent_id, m.content, m.format, m.created_at, a.name AS agent_name,
            json_extract(a.config, '$.color') AS agent_color
     FROM task_messages m
     LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.task_id = ?
     ORDER BY m.created_at ASC, m.rowid ASC
     LIMIT 200`,
  ).all(taskId) as OpMessageRow[];

  const escalations = db.prepare(
    `SELECT e.id, e.agent_id, e.runtime_agent_id, e.task_id, t.title AS task_title,
            e.type, e.question, e.status, e.response, e.created_at, e.resolved_at,
            COALESCE(a.name, e.agent_id) AS agent_name
     FROM escalations e
     LEFT JOIN tasks t ON t.id = e.task_id
     LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.task_id = ?
     ORDER BY e.created_at ASC`,
  ).all(taskId) as EscalationCardData[];

  const items: TimelineItem[] = [];

  // Terminal frames: prose becomes cards, tool/system frames accumulate into
  // per-agent groups that flush on speaker change or when prose interrupts.
  let sysBuf: SysBuffer | null = null;
  const flushSys = () => {
    if (!sysBuf) return;
    items.push({ t: sysBuf.lastTime, html: sysGroupHtml(sysBuf) });
    sysBuf = null;
  };

  for (const row of terminal) {
    const { kind, summary } = classifyRow(row.stream, row.data);
    if (!summary) continue;

    if (kind === "message") {
      flushSys();
      const body = renderInlineMarkdown(summary);
      items.push({
        t: row.created_at,
        html: proseEntry(row.agent_name, row.created_at, body, activityDataAttrs(row, "message"), row.agent_color),
      });
    } else {
      if (sysBuf && sysBuf.agent !== row.agent_name) flushSys();
      if (!sysBuf) sysBuf = { agent: row.agent_name, color: row.agent_color, count: 0, toolCount: 0, rows: [], firstTime: row.created_at, lastTime: row.created_at };
      sysBuf.count++;
      if (kind === "tool") sysBuf.toolCount++;
      sysBuf.lastTime = row.created_at;
      sysBuf.rows.push({ summary, data: row.data, time: row.created_at });
      if (sysBuf.rows.length > MAX_GROUP_ROWS) sysBuf.rows.shift();
    }
  }
  flushSys();

  // Operator messages (task_messages): agent-to-human updates. Rendered by the
  // stored format (plain text by default; markdown/html when the agent chose it).
  for (const m of opMessages) {
    const agent = m.agent_name ?? m.agent_id;
    items.push({
      t: m.created_at,
      html: messageCard(agent, "message", m.created_at, renderMessageBody(m.content, m.format), "", m.agent_color),
    });
  }

  // Escalations: inline resolvable cards. Card ids (#escalation-<id>) match the
  // classic panel, so resolve/dismiss outerHTML swaps land in the timeline.
  const escalationHtml = new Map<string, string>();
  for (const e of escalations) {
    const html = e.status === "open"
      ? escalationBanner(e)
      : resolvedEscalationHtml(e);
    escalationHtml.set(e.id, html);
    items.push({ t: e.created_at, html });
  }

  if (items.length === 0) {
    return `<div class="tc-empty">No activity yet</div>`;
  }

  items.sort((a, b) => a.t.localeCompare(b.t));
  let final = items.slice(-MAX_ITEMS);

  // An open escalation must never fall out of the window. If it did, pin its
  // banner to the top so the sticky banner still docks to an edge.
  for (const e of escalations) {
    if (e.status !== "open") continue;
    const html = escalationHtml.get(e.id)!;
    if (!final.some((i) => i.html === html)) final.unshift({ t: e.created_at, html });
  }

  return final.map((i) => i.html).join("");
}
