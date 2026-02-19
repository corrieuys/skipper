import { escapeHtml } from "./components";

const MODES: Array<{ value: "bypassPermissions" | "plan" | "default"; label: string; title: string }> = [
  { value: "bypassPermissions", label: "Bypass", title: "Skip all permission prompts (current default; edits, bash, etc. all allowed)" },
  { value: "plan", label: "Plan", title: "Read-only planning mode — the agent proposes changes without touching disk" },
  { value: "default", label: "Default", title: "Standard Claude Code permission prompts (limited use headless)" },
];

/**
 * Inline picker for the chat header. Switching it POSTs to the conversation's
 * permission-mode endpoint, which updates the DB and kills any mid-turn
 * runtime so the next user message spawns claude with the new --permission-mode.
 */
export function chatModePicker(conversationId: string, current: string): string {
  const cid = escapeHtml(conversationId);
  const options = MODES.map((m) => {
    const selected = m.value === current ? " selected" : "";
    return `<option value="${m.value}" title="${escapeHtml(m.title)}"${selected}>${m.label}</option>`;
  }).join("");
  return `<select class="chat-mode-picker"
    name="mode"
    title="Claude Code --permission-mode for this conversation"
    hx-post="/api/conversations/${cid}/permission-mode"
    hx-trigger="change"
    hx-swap="none"
    style="font-size:0.72rem;padding:0.15rem 0.35rem;background:var(--sk-surface-2,#1a1a1a);color:var(--on-surface,#ddd);border:1px solid var(--sk-border,#333);border-radius:3px;">
    ${options}
  </select>`;
}
