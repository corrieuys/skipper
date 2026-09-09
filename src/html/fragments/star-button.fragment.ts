import { lucideSvg } from "../atoms/lucide";

/**
 * A star toggle for a task or recurring task. Posts to `/api/tasks/:id/star`
 * (or `/api/scheduled-tasks/:id/star`) and swaps itself for the route's
 * re-rendered fragment; the route also OOB-refreshes only `#mc-sidebar-list` so the
 * Favorites board updates without touching `#mc-main` (no view/page refresh). The
 * button preventDefaults + stops propagation so it can sit inside a clickable `<a>`
 * row without triggering the anchor's navigation (a full page reload) or htmx's
 * row handler.
 */
export function starButtonFragment(
  id: string,
  starred: boolean,
  kind: "task" | "recurring" = "task",
): string {
  const base = kind === "recurring" ? "/api/scheduled-tasks" : "/api/tasks";
  const glyph = lucideSvg("star", {
    // A filled look for on, outline for off: tint gold when starred, muted otherwise.
    color: starred ? "#f2c14e" : "#8b93a7",
    size: 15,
    className: starred ? "sk-star--on" : "sk-star--off",
  });
  const label = starred ? "Unstar" : "Star";
  // hx-swap="none": the star does NOT swap itself. The route replies with OOB
  // swaps only (the whole sidebar list, plus the open task's header identity slot),
  // which carry the new star state. A self-swap would collide with the sidebar OOB
  // that replaces the very button being swapped — leaving a stray star in the main
  // pane and wedging htmx so rows stop responding.
  return `<button type="button" class="sk-star${starred ? " sk-star--active" : ""}"
    data-sk-star="${id}"
    hx-post="${base}/${id}/star" hx-swap="none" hx-trigger="click"
    title="${label}" aria-label="${label}" aria-pressed="${starred ? "true" : "false"}"
    onclick="event.preventDefault();event.stopPropagation()">${glyph}</button>`;
}
