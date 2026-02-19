
export function terminalJsonSummary(event: Record<string, unknown>): string {
    const trunc = (s: string, n = 160) => s.length > n ? s.slice(0, n) + "…" : s;

    // Claude Code: assistant / user message events
    const message = event.message;
    if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content) && content.length > 0) {
            // Collect text across all content blocks (up to 3) for assistant messages
            const type = (event as Record<string, unknown>).type;
            if (type === "assistant") {
                const parts: string[] = [];
                for (const block of content.slice(0, 3)) {
                    if (!block || typeof block !== "object") continue;
                    const b = block as Record<string, unknown>;
                    if (b.type === "text" &&
                        typeof b.text === "string" &&
                        b.text.trim()) {
                        parts.push(b.text.trim());
                    } else if (b.type === "thinking" && typeof b.thinking === "string") {
                        parts.push(`<thinking> ${b.thinking.slice(0, 60)}…`);
                    }
                }
                if (parts.length > 0) return trunc(parts.join(" | "));
            }

            // user messages: tool_result content
            if (type === "user") {
                const first = content[0] as Record<string, unknown>;
                if (first?.type === "tool_result") {
                    const inner = first.content;
                    if (typeof inner === "string") return trunc(inner);
                    if (Array.isArray(inner) && inner.length > 0) {
                        const t = (inner[0] as Record<string, unknown>).text;
                        if (typeof t === "string") return trunc(t);
                    }
                }
            }
        }
        // Plain string content
        if (typeof content === "string") return trunc(content);
    }

    // Codex: event.item with text / command
    const item = event.item;
    if (item && typeof item === "object") {
        const b = item as Record<string, unknown>;
        const itemType = typeof b.type === "string" ? b.type : "";
        if (itemType === "command_execution" && typeof b.command === "string") {
            return trunc(b.command);
        }
        if (typeof b.text === "string" && b.text) return trunc(b.text);
        if (itemType) return itemType;
    }

    // result string (claude-code "result" event, codex summary)
    if (typeof event.result === "string") return trunc(event.result);

    // error
    const error = event.error;
    if (error && typeof error === "object") {
        const msg = (error as Record<string, unknown>).message;
        if (typeof msg === "string") return trunc(msg);
    }

    return "";
}
