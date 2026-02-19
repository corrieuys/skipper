import { escapeHtml } from "./escape-html";

export function thinkingWaveHtml(summary: string): string | null {
  if (!summary.startsWith("<thinking>")) return null;
  const rest = summary.slice("<thinking>".length).trim();
  const word = "thinking";
  const spans = word
    .split("")
    .map((ch, i) => `<span class="sk-wave-char" style="animation-delay:${i * 0.07}s">${ch}</span>`)
    .join("");
  const wave = `<span class="sk-thinking-wave">${spans}</span>`;
  return rest ? `${wave} <span class="mc-steer-card__thinking-rest">${escapeHtml(rest)}</span>` : wave;
}
