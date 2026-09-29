import type { AttentionCounts } from "../../data/attention";

/**
 * Top-bar attention indicator (experimental): one small chip per kind of thing
 * waiting on the operator (pending improvements, review gates, open
 * escalations), each linking to where it is handled. Empty when nothing waits.
 * `#sk-attention` is the OOB target `ws/ui-push.ts` replaces on topic
 * `attention`, which every page subscribes to (shell/layout.ts).
 */
export function attentionIndicator(counts: AttentionCounts, oob = false): string {
  const chip = (href: string, label: string, count: number, kind: string) =>
    `<a href="${href}" class="sk-attention__chip sk-attention__chip--${kind}" title="${count} ${label.toLowerCase()} waiting on you"><span class="sk-attention__label">${label}</span><span class="sk-attention__count">${count}</span></a>`;
  const task = (id: string | null) => (id ? `/?task=${encodeURIComponent(id)}` : "/");
  const chips = [
    counts.improvements > 0 ? chip("/improvements", "Improvements", counts.improvements, "improvements") : "",
    counts.reviews.count > 0 ? chip(task(counts.reviews.taskId), counts.reviews.count === 1 ? "Review" : "Reviews", counts.reviews.count, "review") : "",
    counts.escalations.count > 0
      ? chip(task(counts.escalations.taskId), counts.escalations.count === 1 ? "Escalation" : "Escalations", counts.escalations.count, "escalation")
      : "",
  ].join("");
  return `<span id="sk-attention" class="sk-attention"${oob ? ' hx-swap-oob="outerHTML"' : ""}>${chips}</span>`;
}
