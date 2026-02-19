import type { Database } from "bun:sqlite";
import type { EventName } from "../events/bus";

export type SwapMode = "innerHTML" | "beforeend" | "outerHTML";

export interface FragmentRegistration {
  /** DOM element ID for OOB swap */
  id: string;
  /** Subscription topics this fragment belongs to (e.g., "dashboard", "task:{taskId}") */
  topics: string[];
  /** Event bus events that trigger this fragment */
  events: EventName[];
  /** Render function returning HTML */
  render: (ctx: FragmentContext) => string;
  /** OOB swap mode (default: innerHTML via the oob() helper) */
  swapMode?: SwapMode;
  /** Debounce in ms (if set, fragments are batched) */
  debounceMs?: number;
  /** If true, use broadcastRaw instead of broadcast with OOB injection */
  raw?: boolean;
}

export interface FragmentContext {
  db: Database;
  /** The event data that triggered this fragment (if any) */
  eventData?: Record<string, unknown>;
  /** The specific taskId from the event, if applicable */
  taskId?: string;
}

export class FragmentRegistry {
  private registrations: FragmentRegistration[] = [];
  private eventIndex: Map<string, FragmentRegistration[]> = new Map();

  register(reg: FragmentRegistration): void {
    this.registrations.push(reg);
    for (const event of reg.events) {
      const list = this.eventIndex.get(event) ?? [];
      list.push(reg);
      this.eventIndex.set(event, list);
    }
  }

  getForEvent(event: EventName): FragmentRegistration[] {
    return this.eventIndex.get(event) ?? [];
  }

  getAll(): FragmentRegistration[] {
    return this.registrations;
  }

  /** Get unique event names across all registrations */
  getAllEvents(): EventName[] {
    return Array.from(this.eventIndex.keys()) as EventName[];
  }
}

/**
 * Check if a client's subscriptions match any of the fragment's topics.
 * Supports exact match and wildcard patterns (e.g., "task:*" matches "task:abc123").
 * If client has no subscriptions, they receive everything (backward compat).
 */
export function topicMatches(clientTopics: Set<string>, fragmentTopics: string[]): boolean {
  if (clientTopics.size === 0) return true; // no subscriptions = receive all

  for (const ft of fragmentTopics) {
    if (clientTopics.has(ft)) return true;
    // Check wildcard: client subscribed to "task:abc" matches fragment "task:{taskId}"
    // and vice versa: client subscribed to "dashboard" matches fragment "dashboard"
    for (const ct of clientTopics) {
      if (ct.endsWith(":*") && ft.startsWith(ct.slice(0, -1))) return true;
      if (ft.endsWith(":*") && ct.startsWith(ft.slice(0, -1))) return true;
    }
  }
  return false;
}
