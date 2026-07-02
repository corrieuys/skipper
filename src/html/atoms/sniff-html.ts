// Heuristic shared by the artifact modal renderer and the connect
// read-published action: decides whether an artifact body is HTML or plain
// text/markdown.
export function looksLikeHtml(body: string): boolean {
  return (
    /^\s*<[a-zA-Z]/.test(body) ||
    /<(h[1-6]|p|div|table|ul|ol|blockquote|pre|section|article|header|footer|nav|figure|details)\b/i.test(body)
  );
}
