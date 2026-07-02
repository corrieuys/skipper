/**
 * Normalize signal content into the snippet used for dedup fingerprints.
 * Must stay identical between the stdout parser (agents/manager.ts) and the
 * MCP signal bridge (mcp/signal-bridge.ts) or dedup silently breaks.
 */
export function signalTextSnippet(value?: string): string {
  if (!value) return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 260);
}
