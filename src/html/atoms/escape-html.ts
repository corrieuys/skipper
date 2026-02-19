/** HTML-escape a string for safe interpolation into templates. */
export function escapeHtml(str: string): string {
  const value = str == null ? "" : String(str);
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
