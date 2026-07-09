import { type RecentLogEntry, parseJsonLine, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";
import { terminalJsonSummary, stripThinking } from "./terminalJsonSummary";

// --- Dashboard: Recent Activity ---

export function recentActivityFragment(logs: RecentLogEntry[]): string {
    if (logs.length === 0) {
        return `<div style="padding:1.25rem;text-align:center;color:var(--muted);font-size:0.78rem;">No recent activity</div>`;
    }
    const classifyActivityKind = (
        entry: RecentLogEntry
    ): "message" | "tool" | "other" => {
        const parsed = parseJsonLine(entry.data.trim());
        if (!parsed) {
            return entry.stream === "stderr" ? "other" : "message";
        }

        const type = typeof parsed.type === "string" ? parsed.type : "";
        const item = parsed.item && typeof parsed.item === "object"
            ? (parsed.item as Record<string, unknown>)
            : null;
        const itemType = item && typeof item.type === "string" ? item.type : "";
        const message = parsed.message && typeof parsed.message === "object"
            ? (parsed.message as Record<string, unknown>)
            : null;
        const content = message?.content;

        if (itemType === "command_execution" ||
            itemType === "tool_call" ||
            itemType === "tool_result" ||
            itemType === "tool_use" ||
            type.includes("tool")) {
            return "tool";
        }

        if (Array.isArray(content)) {
            const hasToolBlock = content.some((block) => {
                if (!block || typeof block !== "object") return false;
                const blockType = (block as Record<string, unknown>).type;
                return blockType === "tool_use" || blockType === "tool_result";
            });
            if (hasToolBlock) return "tool";
        }

        if (type === "assistant" ||
            type === "user" ||
            type === "message" ||
            itemType === "agent_message" ||
            itemType === "text" ||
            typeof parsed.result === "string" ||
            (item &&
                typeof item.text === "string" &&
                itemType !== "command_execution")) {
            return "message";
        }

        return "other";
    };

    return logs
        .map((entry) => {
            const kind = classifyActivityKind(entry);
            const kindLabel = kind === "tool" ? "tool" : kind === "message" ? "message" : "event";
            const parsed = parseJsonLine(entry.data.trim());
            const summary = parsed ? terminalJsonSummary(parsed) : "";
            const rawDisplay = summary ||
                (entry.data.length > 140
                    ? entry.data.slice(0, 140) + "..."
                    : entry.data);
            // Messages view drops reasoning/thinking noise.
            const display = kind === "message" ? stripThinking(rawDisplay) : rawDisplay;
            if (kind === "message" && !display) return "";
            return `<div class="cmd-feed-item cmd-feed-item-${kind}">
      <span class="cmd-feed-agent"><span class="cmd-feed-kind cmd-feed-kind-${kind}">${kindLabel}</span><a href="/agents/${escapeHtml(entry.agent_id)}" hx-get="/agents/${escapeHtml(entry.agent_id)}" hx-target="body" hx-push-url="true">${escapeHtml(entry.agent_name)}</a></span>
      <span class="cmd-feed-data">${escapeHtml(display)}</span>
      <span class="cmd-feed-time">${formatTimestamp(entry.created_at)}</span>
    </div>`;
        })
        .filter(Boolean)
        .join("");
}
