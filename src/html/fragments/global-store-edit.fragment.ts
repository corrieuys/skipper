import { escapeHtml } from "../atoms/escape-html";
import type { GlobalStoreRow } from "../../global-store/manager";

const COLSPAN = 7;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** A single data row, wrapped in its own <tbody> so HTMX can swap it whole. */
export function globalStoreRowFragment(row: GlobalStoreRow): string {
  const data = row.data ?? "";
  const by = row.updated_by_agent_id ?? "";
  return `<tbody class="gs-row">
    <tr>
      <td class="sk-mono">${escapeHtml(row.name)}</td>
      <td>${row.type ? escapeHtml(row.type) : '<span class="sk-muted">-</span>'}</td>
      <td>${row.status ? `<span class="sk-badge">${escapeHtml(row.status)}</span>` : '<span class="sk-muted">-</span>'}</td>
      <td class="sk-mono sk-text-xs" title="${escapeHtml(data)}">${data ? escapeHtml(truncate(data, 80)) : '<span class="sk-muted">-</span>'}</td>
      <td class="sk-muted sk-text-xs">${escapeHtml(row.updated_at)}</td>
      <td class="sk-muted sk-text-xs sk-mono" title="${escapeHtml(by)}">${by ? escapeHtml(truncate(by, 12)) : '<span class="sk-muted">ui</span>'}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="sk-btn sk-btn--sm"
          hx-get="/fragments/global-store/edit?name=${encodeURIComponent(row.name)}"
          hx-target="closest tbody" hx-swap="beforeend">Edit</button>
        <button class="sk-btn sk-btn--sm sk-btn--danger"
          hx-delete="/api/global-store?name=${encodeURIComponent(row.name)}"
          hx-confirm="Delete global value '${escapeHtml(row.name)}'?"
          hx-target="closest tbody" hx-swap="outerHTML">Delete</button>
      </td>
    </tr>
  </tbody>`;
}

/**
 * Inline edit form. When `row` is given, edits an existing value (name is the
 * primary key, so it's read-only and the form is a bare <tr> appended inside the
 * row's tbody). When omitted, it's a new value wrapped in its own <tbody>.
 */
export function globalStoreEditFragment(row?: GlobalStoreRow): string {
  const isNew = !row;
  const name = row?.name ?? "";
  const type = row?.type ?? "";
  const status = row?.status ?? "";
  const data = row?.data ?? "";
  const cancel = isNew
    ? "this.closest('tbody').remove()"
    : "this.closest('tr').remove()";

  const form = `<tr class="sk-edit-row">
    <td colspan="${COLSPAN}">
      <form hx-post="/api/global-store" hx-target="closest tbody" hx-swap="outerHTML" class="sk-inline-edit-form">
        <div class="sk-inline-edit-form__grid">
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Name</span>
            <span class="sk-inline-edit-form__hint">Unique key. ${isNew ? "Choose a stable identifier." : "Primary key — cannot be changed."}</span>
            <input type="text" name="name" value="${escapeHtml(name)}" class="sk-input sk-input--sm" required${isNew ? "" : " readonly"}>
          </div>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Type</span>
            <span class="sk-inline-edit-form__hint">Free-form category (e.g. checklist, log).</span>
            <input type="text" name="type" value="${escapeHtml(type)}" class="sk-input sk-input--sm">
          </div>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Status</span>
            <span class="sk-inline-edit-form__hint">Free-form status (e.g. open, done).</span>
            <input type="text" name="status" value="${escapeHtml(status)}" class="sk-input sk-input--sm">
          </div>
        </div>
        <div class="sk-inline-edit-form__field" style="margin-top:var(--sk-space-3);">
          <span class="sk-inline-edit-form__label">Data</span>
          <span class="sk-inline-edit-form__hint">Value payload (free-form text or JSON).</span>
          <textarea name="data" rows="6" class="sk-textarea sk-textarea--sm" style="font-family:var(--sk-font-mono);font-size:11px;">${escapeHtml(data)}</textarea>
        </div>
        <div class="sk-inline-edit-form__actions">
          <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Save</button>
          <button type="button" class="sk-btn sk-btn--sm" onclick="${cancel}">Cancel</button>
        </div>
      </form>
    </td>
  </tr>`;

  return isNew ? `<tbody class="gs-row gs-row--new">${form}</tbody>` : form;
}
