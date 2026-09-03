import type { Database } from "bun:sqlite";
import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { renderMessageBody } from "../atoms/render-message-body";
import { renderAgentText } from "../atoms/render-agent-text";
import { escalationCardPanel, type EscalationCardData } from "../panels/escalation-card.panel";
import { sanitizeColor } from "../atoms/creature";
import { formatBytes } from "../../orchestrator/artifact-files";
import { fileArtifactIcon } from "./artifact-list.fragment";

/**
 * Task timeline for the v2 UI: the operator-facing channel only.
 *   - operator INPUT (realtime_timeline: typed composer text as "You" cards,
 *     transcribed-audio digests as "Audio" cards, pipeline errors as quiet lines)
 *   - operator messages (task_messages, the `post_message` tool) as cards
 *   - escalations inline as resolvable cards (same escalationCardPanel the
 *     classic Escalations tab uses, so resolve/dismiss swaps work unchanged)
 *   - a transient "live agents" indicator, always the LAST item, showing which
 *     agents are working right now (re-rendered on instance:state_changed)
 * Raw agent output (assistant prose, tool calls, system frames) deliberately
 * does NOT render here — the rail's Activity tab already shows it; keeping it
 * in both made the timeline redundant noise.
 * Chronological, oldest first; the client sticks the scroll to the bottom.
 *
 * Shared by the /workspace/task/:id/timeline route and the WS live-push.
 */

interface OpMessageRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  agent_color: string | null;
  content: string;
  format: string | null;
  created_at: string;
}

interface LiveAgentRow {
  agent_name: string;
  agent_color: string | null;
  status: string;
}

interface InputEntryRow {
  id: string;
  entry_type: string;
  content: string;
  fed_to_skipper: number;
  created_at: string;
  /** File artifact behind an 'image' / 'file' entry (LEFT JOIN task_artifacts). */
  artifact_id: string | null;
  artifact_name: string | null;
  artifact_version: number | null;
  artifact_mime: string | null;
  artifact_bytes: number | null;
  artifact_caption: string | null;
  /** `task_artifacts.source`: 'operator' / 'connect:<id>' for uploads, else the attaching agent's id. */
  artifact_source: string | null;
  /** Display name of the agent behind `artifact_source` (LEFT JOIN agents); null for operator sources. */
  artifact_agent_name: string | null;
  artifact_agent_color: string | null;
}

interface TimelineItem {
  t: string;
  html: string;
}

const MAX_ITEMS = 300;

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

function messageCard(agent: string, kindLabel: string, time: string, bodyHtml: string, color: string | null = null): string {
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
    <div class="tc-entry__card">${bodyHtml}</div>
  </div>`;
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

/**
 * Transient live-agents indicator: which agents have a live instance on this
 * task right now. Not part of the chronological items — always appended as the
 * LAST element, and simply absent when nothing is running.
 */
function liveAgentsIndicator(agents: LiveAgentRow[]): string {
  if (agents.length === 0) return "";
  const chips = agents.map((a) => {
    const c = a.agent_color ? sanitizeColor(a.agent_color) : null;
    const avAttr = c ? ` class="tc-av tc-live__av" style="background:${c}"` : ` class="tc-av tc-av--${avatarIndex(a.agent_name)} tc-live__av"`;
    const verb = a.status === "waiting_delegation" ? "waiting on delegation" : "working";
    return `<span class="tc-live__agent">
      <span${avAttr}>${escapeHtml(initials(a.agent_name))}</span>
      <span class="tc-live__who"${c ? ` style="color:${c}"` : ""}>${escapeHtml(a.agent_name)}</span>
      <span class="tc-live__verb">${verb}</span>
    </span>`;
  }).join("");
  return `<div class="tc-live" data-tc-transient>
    ${chips}
    <span class="tc-live__dots"><i></i><i></i><i></i></span>
  </div>`;
}

/** Operator input entries: typed text renders as a "You" card; a transcribed
 *  audio digest renders as an "Audio" card; pipeline errors as a quiet line.
 *  Undelivered entries carry a "queued" tag until the agent receives them. */
function inputEntryHtml(e: InputEntryRow): string {
  const pending = e.fed_to_skipper ? "" : `<span class="tc-input__pending">queued for agent</span>`;
  if (e.entry_type === "error") {
    return `<div class="tc-input tc-input--error">
      <span class="tc-input__who">Input pipeline</span>
      <time class="tc-input__time">${formatTimestamp(e.created_at)}</time>
      <span class="tc-input__body">${escapeHtml(e.content)}</span>
    </div>`;
  }
  if ((e.entry_type === "image" || e.entry_type === "file") && e.artifact_id) {
    return uploadEntryHtml(e, pending);
  }
  const who = e.entry_type === "summary" ? "Audio" : "You";
  const kind = e.entry_type === "summary" ? "transcript" : "input";
  return `<div class="tc-entry tc-entry--input">
    <div class="tc-entry__meta">
      <div class="tc-av tc-av--you">${who === "Audio" ? "&#127908;" : "Y"}</div>
      <span class="tc-entry__who">${who}</span>
      <span class="tc-entry__kind">${kind}</span>
      <time class="tc-entry__time">${formatTimestamp(e.created_at)}</time>
      ${pending}
    </div>
    <div class="tc-entry__card">${escapeHtml(e.content)}</div>
  </div>`;
}

/** Whether a file artifact's `source` is the operator (web / connect upload) rather than an agent. */
function isOperatorSource(source: string | null): boolean {
  return !source || source === "operator" || source === "user" || source === "web" || source.startsWith("connect:");
}

/** "You · image" / "You · file" card for an operator upload on the timeline,
 *  or "<Agent name> · image" / "<Agent name> · file" (avatar tinted like the
 *  agent's message cards) for a file an agent attached via create_file_artifact.
 *  Images render a lazy thumbnail that opens full size; files a download row. */
function uploadEntryHtml(e: InputEntryRow, pending: string): string {
  const fileUrl = `/api/artifacts/${escapeHtml(e.artifact_id!)}/file`;
  const name = e.artifact_name ?? e.content;
  const caption = e.artifact_caption?.trim() ?? "";
  const isImage = e.entry_type === "image";
  const body = isImage
    ? `<a href="${fileUrl}" target="_blank" rel="noopener" class="tc-upload__img-link" title="Open full size">
        <img class="tc-upload__img" loading="lazy" src="${fileUrl}" alt="${escapeHtml(name)}">
      </a>${caption ? `<div class="tc-upload__caption">${escapeHtml(caption)}</div>` : ""}`
    : `<div class="tc-upload__file">
        <span class="tc-upload__icon" aria-hidden="true">${fileArtifactIcon(e.artifact_mime)}</span>
        <span class="tc-upload__name">${escapeHtml(name)}</span>
        <span class="tc-upload__size">${escapeHtml(formatBytes(e.artifact_bytes))}</span>
        <a href="${fileUrl}" class="tc-upload__dl" download="${escapeHtml(name)}">Download</a>
      </div>${caption ? `<div class="tc-upload__caption">${escapeHtml(caption)}</div>` : ""}`;
  const kindLabel = `${isImage ? "image" : "file"}${e.artifact_version != null ? ` v${e.artifact_version}` : ""}`;
  if (!isOperatorSource(e.artifact_source)) {
    const agent = e.artifact_agent_name ?? e.artifact_source!;
    const idx = avatarIndex(agent);
    const c = e.artifact_agent_color ? sanitizeColor(e.artifact_agent_color) : null;
    const avAttr = c ? ` class="tc-av" style="background:${c}"` : ` class="tc-av tc-av--${idx}"`;
    const whoAttr = c ? ` class="tc-entry__who" style="color:${c}"` : ` class="tc-entry__who tc-who--${idx}"`;
    return `<div class="tc-entry tc-entry--upload tc-entry--agent-upload">
    <div class="tc-entry__meta">
      <div${avAttr}>${escapeHtml(initials(agent))}</div>
      <span${whoAttr}>${escapeHtml(agent)}</span>
      <span class="tc-entry__kind">${escapeHtml(kindLabel)}</span>
      <time class="tc-entry__time">${formatTimestamp(e.created_at)}</time>
    </div>
    <div class="tc-entry__card tc-upload">${body}</div>
  </div>`;
  }
  return `<div class="tc-entry tc-entry--input tc-entry--upload">
    <div class="tc-entry__meta">
      <div class="tc-av tc-av--you">Y</div>
      <span class="tc-entry__who">You</span>
      <span class="tc-entry__kind">${escapeHtml(kindLabel)}</span>
      <time class="tc-entry__time">${formatTimestamp(e.created_at)}</time>
      ${pending}
    </div>
    <div class="tc-entry__card tc-upload">${body}</div>
  </div>`;
}

export function taskTimelineFragment(db: Database, taskId: string): string {
  // Operator input + transcribed audio from the input pipeline. These feed the
  // agent as the INPUT_FEED; showing them here is what makes the timeline a
  // two-way conversation instead of only the agent's side. Upload entries
  // join their file artifact for name/size/caption/source, and the agent
  // behind an agent-sourced artifact for its display name + color.
  const inputEntries = db.prepare(
    `SELECT t.id, t.entry_type, t.content, t.fed_to_skipper, t.created_at, t.artifact_id,
            a.name AS artifact_name, a.version AS artifact_version, a.mime AS artifact_mime,
            a.bytes AS artifact_bytes, a.body AS artifact_caption, a.source AS artifact_source,
            ag.name AS artifact_agent_name, json_extract(ag.config, '$.color') AS artifact_agent_color
     FROM realtime_timeline t
     LEFT JOIN task_artifacts a ON a.id = t.artifact_id
     LEFT JOIN agents ag ON ag.id = a.source
     WHERE t.task_id = ?
     ORDER BY t.created_at ASC
     LIMIT 300`,
  ).all(taskId) as InputEntryRow[];

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

  // Live agents: one row per distinct agent with a live instance on this task.
  // Pending instances count as working (mid-spawn); waiting_delegation gets its
  // own verb so the operator sees why the agent looks quiet.
  const liveAgents = db.prepare(
    `SELECT COALESCE(a.name, ai.template_agent_id) AS agent_name,
            json_extract(a.config, '$.color') AS agent_color,
            MIN(ai.status) AS status
     FROM agent_instances ai
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     WHERE ai.task_id = ? AND ai.status IN ('running', 'waiting_delegation', 'pending')
     GROUP BY agent_name, agent_color
     ORDER BY MIN(ai.created_at) ASC`,
  ).all(taskId) as LiveAgentRow[];

  const items: TimelineItem[] = [];

  for (const e of inputEntries) {
    items.push({ t: e.created_at, html: inputEntryHtml(e) });
  }

  // Operator messages (task_messages): agent-to-human updates. Rendered by the
  // stored format (plain text by default; markdown/html when the agent chose it).
  for (const m of opMessages) {
    const agent = m.agent_name ?? m.agent_id;
    items.push({
      t: m.created_at,
      html: messageCard(agent, "message", m.created_at, renderMessageBody(m.content, m.format), m.agent_color),
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

  const live = liveAgentsIndicator(liveAgents);

  if (items.length === 0) {
    return live || `<div class="tc-empty">No messages yet. Agent activity shows in the Activity tab.</div>`;
  }

  items.sort((a, b) => a.t.localeCompare(b.t));
  const final = items.slice(-MAX_ITEMS);

  // An open escalation must never fall out of the window. If it did, pin its
  // banner to the top so the sticky banner still docks to an edge.
  for (const e of escalations) {
    if (e.status !== "open") continue;
    const html = escalationHtml.get(e.id)!;
    if (!final.some((i) => i.html === html)) final.unshift({ t: e.created_at, html });
  }

  // The live indicator is transient and always last.
  return final.map((i) => i.html).join("") + live;
}
