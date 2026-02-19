import { ForensicsTerminalTail, escapeHtml } from "./components";


export function forensicsTerminalTails(tails: ForensicsTerminalTail[]): string {
    if (tails.length === 0) return "";

    const sections = tails
        .map((t) => {
            const lineHtml = t.lines
                .map((l) => {
                    const trimmed = l.data.trim();
                    if (!trimmed) return "";
                    return `<div class="terminal-line terminal-${escapeHtml(l.stream)}">${escapeHtml(trimmed)}</div>`;
                })
                .filter(Boolean)
                .join("");

            return `<div style="margin-bottom:0.5rem">
      <div class="muted" style="font-size:0.78rem;margin-bottom:0.2rem">Instance ${escapeHtml(t.instance_id.slice(0, 8))}</div>
      <div class="terminal forensics-tail">${lineHtml || '<span class="muted">no output</span>'}</div>
    </div>`;
        })
        .join("");

    return `<div class="forensics-section">
    <h3>Terminal Tail (last 20 lines per instance)</h3>
    ${sections}
  </div>`;
}
