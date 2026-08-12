
/**
 * Strip reasoning/thinking from a message summary so the messages view shows
 * only real output. Removes closed `<thinking>…</thinking>` blocks, the
 * `<thinking> …` preview marker emitted below (segments joined by " | "), and
 * any dangling open `<thinking>` run. Empty result → caller drops the row.
 */
export function stripThinking(text: string): string {
    let out = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
    out = out.split(" | ").filter(seg => !seg.trim().toLowerCase().startsWith("<thinking>")).join(" | ");
    out = out.replace(/<thinking>[\s\S]*$/i, "");
    return out.trim();
}

export function terminalJsonSummary(event: Record<string, unknown>): string {
    const trunc = (s: string, n = 160) => s.length > n ? s.slice(0, n) + "…" : s;

    // claude-code "result" event — show result string directly
    if (typeof event.type === "string" && event.type === "result" && typeof event.result === "string") {
        return trunc(event.result);
    }

    // Claude Code: assistant / user message events
    const message = event.message;
    if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content) && content.length > 0) {
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
                    } else if (b.type === "tool_use" && typeof b.name === "string") {
                        const input = b.input;
                        const brief = toolInputBrief(b.name, input);
                        parts.push(brief);
                    }
                }
                if (parts.length > 0) return trunc(parts.join(" | "));
            }

            // user messages: tool_result content
            if (type === "user") {
                const first = content[0] as Record<string, unknown>;
                if (first?.type === "tool_result") {
                    const inner = first.content;
                    const raw = typeof inner === "string"
                        ? inner
                        : Array.isArray(inner) && inner.length > 0
                            ? String((inner[0] as Record<string, unknown>).text ?? "")
                            : "";
                    if (raw) return trunc(prettyToolResult(raw));
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

    // result string (codex summary, other agents)
    if (typeof event.result === "string") return trunc(event.result);

    // system events (hook_started, task_notification, etc.)
    if (typeof event.type === "string" && event.type === "system") {
        const subtype = typeof event.subtype === "string" ? event.subtype : "";
        if (subtype === "hook_started" || subtype === "hook_completed") {
            const hookName = typeof event.hook_name === "string" ? event.hook_name : "";
            return trunc(`${subtype}: ${hookName}`.trim());
        }
        if (subtype === "task_notification") {
            const summary = typeof event.summary === "string" ? event.summary : "";
            const status = typeof event.status === "string" ? event.status : "";
            return trunc(`task ${status}: ${summary}`.trim());
        }
        if (subtype) return trunc(subtype);
    }

    // rate_limit_event — skip noise
    if (typeof event.type === "string" && event.type === "rate_limit_event") {
        return "";
    }

    // Grok's older `--output-format streaming-json`: response text as
    // {type:"text",data:"<chunk>"} chunks, reasoning as {type:"thought",data:"…"}.
    // Skipper now asks grok for `streaming-messages-json`, which lands in the
    // Claude-shaped branches above one WHOLE message at a time — these frames only
    // reach here from an install whose `agent_types.json` predates that switch
    // (config is seeded once and never overwritten). Kept so such an install shows
    // output rather than a blank feed; note a chunk is a few tokens, so a sentence
    // renders as several rows. Gated on a top-level string `data` so OpenCode's own
    // {type:"text",part:{…}} frames fall through to their own handling.
    if (typeof event.data === "string" && typeof event.type === "string") {
        if (event.type === "text") return trunc(event.data);
        // Marked like Claude's thinking blocks so stripThinking() drops it from
        // the Messages filter but leaves it visible in the unfiltered feed.
        if (event.type === "thought") return `<thinking> ${event.data.slice(0, 60)}…`;
    }

    // OpenCode (`--format json`): whole-message text as {type:"text",part:{text}}.
    // Distinct from grok's {type:"text",data} above (part vs top-level data). The
    // step_start / step_finish / tool wrapper frames carry no prose and fall
    // through to "" so the feed drops them, which is what we want.
    if (event.type === "text" && event.part && typeof event.part === "object") {
        const partText = (event.part as Record<string, unknown>).text;
        if (typeof partText === "string" && partText.trim()) return trunc(partText.trim());
    }

    // error. Claude nests it ({error:{message}}); grok puts a plain string at the
    // top level, which the object branch above deliberately skips.
    const error = event.error;
    if (error && typeof error === "object") {
        const msg = (error as Record<string, unknown>).message;
        if (typeof msg === "string") return trunc(msg);
    }
    if (event.type === "error" && typeof event.message === "string") {
        return trunc(event.message);
    }

    return "";
}

function toolInputBrief(name: string, input: unknown): string {
    if (!input || typeof input !== "object") return name;
    const inp = input as Record<string, unknown>;
    // Pick the most informative field from common tool inputs
    const hint = inp.content ?? inp.command ?? inp.message ?? inp.query ?? inp.path ?? inp.url ?? inp.title ?? inp.text;
    if (typeof hint === "string" && hint.trim()) {
        const short = hint.trim().length > 80 ? hint.trim().slice(0, 80) + "…" : hint.trim();
        return `${name}: ${short}`;
    }
    return name;
}

function prettyToolResult(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const keys = Object.keys(parsed);
            return keys.map(k => `${k}: ${String(parsed[k])}`).join(", ");
        }
        return trimmed;
    } catch {
        return trimmed;
    }
}
