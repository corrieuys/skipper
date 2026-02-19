const DEDUP_WINDOW_MS = 15_000;
const CACHE_LIMIT = 256;

interface McpAction {
  type: string;
  fingerprint: string;
  timestamp: number;
}

/**
 * Shared registry that allows MCP tool handlers and stdout signal parsers
 * to coordinate and prevent duplicate processing of the same action.
 *
 * When an MCP tool is called, it registers the action here.
 * When the stdout parser sees a matching signal, it checks here and suppresses it.
 */
class SignalBridge {
  private actions: Map<string, McpAction[]> = new Map(); // runtimeId -> actions

  registerMcpAction(runtimeId: string, actionType: string, contentSnippet: string): void {
    const fingerprint = `${actionType}|${contentSnippet.trim().replace(/\s+/g, " ").slice(0, 260)}`;
    const entry: McpAction = { type: actionType, fingerprint, timestamp: Date.now() };

    let list = this.actions.get(runtimeId);
    if (!list) {
      list = [];
      this.actions.set(runtimeId, list);
    }
    list.push(entry);

    // Evict old entries
    if (list.length > CACHE_LIMIT) {
      list.splice(0, list.length - CACHE_LIMIT);
    }
  }

  /**
   * Check if a recent MCP action matches the given stdout signal fingerprint.
   * Used by the stdout parser to suppress duplicate signals.
   */
  hasMcpAction(runtimeId: string, signalType: string, contentSnippet: string): boolean {
    const list = this.actions.get(runtimeId);
    if (!list) return false;

    const now = Date.now();
    const fingerprint = `${signalType}|${contentSnippet.trim().replace(/\s+/g, " ").slice(0, 260)}`;

    // Clean expired entries while checking
    let foundMatch = false;
    const kept: McpAction[] = [];
    for (const action of list) {
      if (now - action.timestamp > DEDUP_WINDOW_MS) continue;
      kept.push(action);
      if (action.fingerprint === fingerprint) foundMatch = true;
    }
    this.actions.set(runtimeId, kept);

    return foundMatch;
  }

  /** Check if this agent has used MCP at all recently (any action type) */
  hasRecentMcpActivity(runtimeId: string): boolean {
    const list = this.actions.get(runtimeId);
    if (!list || list.length === 0) return false;
    const now = Date.now();
    return list.some((a) => now - a.timestamp <= DEDUP_WINDOW_MS);
  }

  /** Clear all entries for a runtime (on agent exit) */
  clear(runtimeId: string): void {
    this.actions.delete(runtimeId);
  }
}

export const signalBridge = new SignalBridge();
