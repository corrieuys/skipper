/**
 * Skipper Connect URLs carry an instance or integrator key on the socket
 * handshake, so they must be TLS (`wss://` / `https://`). Plain `ws://` /
 * `http://` is allowed only for a loopback host (a local `wrangler dev`).
 * Returns the reason a URL is refused, or null when it is acceptable.
 */
export function insecureConnectUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "not a valid URL";
  }
  if (url.protocol === "wss:" || url.protocol === "https:") return null;
  if (url.protocol === "ws:" || url.protocol === "http:") {
    return isLoopbackHost(url.hostname) ? null : "use wss:// (or https://): the key would travel unencrypted";
  }
  return "use a wss:// (or https://) URL";
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}
