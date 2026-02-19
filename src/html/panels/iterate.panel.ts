import { escapeHtml } from "../atoms/escape-html";

export function iteratePanel(taskId: string): string {
  return `<div class="sk-panel">
    <div class="sk-panel__header"><span class="sk-panel__title">Iterate</span></div>
    <div class="sk-panel__body">
      <form hx-post="/api/tasks/${escapeHtml(taskId)}/iterate" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.reset();}">
        <div class="sk-form-group">
          <textarea name="additionalInput" class="sk-textarea"
                    placeholder="Describe what to change or improve..."
                    rows="3" required></textarea>
        </div>
        <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Iterate Task</button>
      </form>
    </div>
  </div>`;
}
