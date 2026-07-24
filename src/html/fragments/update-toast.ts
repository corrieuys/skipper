import { escapeHtml } from "../atoms/escape-html";
import type { UpdateNoticeView } from "../../config/auto-update-settings";

/**
 * Render the bottom-right update snackbar(s): 0-2 `.sk-toast` cards for an
 * available update and/or a just-applied update. Returns "" when nothing is
 * pending (clears the polled host). Each card carries `data-kind`/`data-version`
 * so the delegated close handler in skipper.js can POST the dismissal.
 */
export function renderUpdateNotice(view: UpdateNoticeView): string {
  const cards: string[] = [];

  if (view.availableVersion) {
    const v = escapeHtml(view.availableVersion);
    cards.push(toastCard(
      "available",
      v,
      "Update available",
      `Skipper v${v} is available. Run <code>skipper update</code> then <code>skipper restart</code> in your terminal to upgrade.`,
    ));
  }

  if (view.appUpdatedTo) {
    const v = escapeHtml(view.appUpdatedTo);
    cards.push(toastCard("applied", v, "Skipper updated", `Skipper was updated to v${v}.`));
  }

  return cards.join("");
}

function toastCard(kind: string, version: string, title: string, body: string): string {
  return `<div class="sk-toast" data-kind="${kind}" data-version="${version}" role="status">
    <div class="sk-toast__body">
      <strong class="sk-toast__title">${title}</strong>
      <span class="sk-toast__msg">${body}</span>
    </div>
    <button type="button" class="sk-toast__close" data-sk-toast-close aria-label="Dismiss">&times;</button>
  </div>`;
}
