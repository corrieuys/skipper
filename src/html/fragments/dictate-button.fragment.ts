import { escapeHtml } from "../atoms/escape-html";
import { isExperimental } from "../../config/feature-flags";

/**
 * Mic button for dictating into a textarea. The behavior lives in
 * public/dictation.js (loaded globally by v2layout); it binds via a delegated
 * click handler, so this works inside HTMX-swapped fragments too. The status
 * line is created by the script under the target textarea (never next to the
 * button, so the button doesn't shift as status text changes). Renders
 * nothing outside --experimental — dictation is an experimental feature.
 */
export function dictateButton(targetSelector: string): string {
  if (!isExperimental()) return "";
  return `<span class="sk-dictate-wrap"><button type="button" class="sk-btn sk-btn--sm sk-dictate-btn"
      data-dictate data-dictate-target="${escapeHtml(targetSelector)}" title="Dictate into this field">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
      <span data-dictate-label>Dictate</span>
    </button></span>`;
}
