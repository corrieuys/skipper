import { eventBus, type DelegationGroupProgressEvent, type EventName } from "../events/bus";
import { getDb } from "../db/connection";
import { CONNECT_PROTOCOL_VERSION } from "./protocol";
import { fetchArtifactItem, fetchEscalationItem, fetchNoteItem, toTaskListItem } from "./serializers";

// Events pushed to integrators. Excludes chatty per-line outputs (those go
// through the subscription-gated output tail instead - see output-tail.ts).
const FORWARDED_EVENTS: readonly EventName[] = [
  "task:created",
  "task:state_changed",
  "task:phase_changed",
  "task:note_added",
  "task:needs_review_changed",
  "escalation:created",
  "escalation:resolved",
  "artifact:created",
  "artifact:published",
  "artifact:unpublished",
  "consensus:phase_advance",
  "delegation_group:progress",
  "realtime:trigger_fired",
  "realtime:session_state",
] as const;

// Events whose payload carries a taskId and gets a `task` projection attached.
const TASK_FAT_EVENTS = new Set<EventName>([
  "task:created",
  "task:state_changed",
  "task:phase_changed",
  "task:needs_review_changed",
  "consensus:phase_advance",
]);

const ARTIFACT_FAT_EVENTS = new Set<EventName>([
  "artifact:created",
  "artifact:published",
  "artifact:unpublished",
]);

/**
 * Fat events: forwarded payloads keep their bus shape and additionally carry
 * the changed entity's projection (task / escalation / note / artifact) so the
 * integrator web app can patch its local store without a relayed refetch.
 * Enrichment is best-effort - on any failure the raw bus payload still ships.
 */
function enrichPayload(eventName: EventName, payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  try {
    const db = getDb();
    if (TASK_FAT_EVENTS.has(eventName) && typeof p.taskId === "string") {
      const task = toTaskListItem(db, p.taskId);
      return task ? { ...p, task } : p;
    }
    if (eventName === "task:note_added" && typeof p.noteId === "string") {
      const note = fetchNoteItem(db, p.noteId);
      return note ? { ...p, note } : p;
    }
    if ((eventName === "escalation:created" || eventName === "escalation:resolved") && typeof p.escalationId === "string") {
      const escalation = fetchEscalationItem(db, p.escalationId);
      return escalation ? { ...p, escalation } : p;
    }
    if (ARTIFACT_FAT_EVENTS.has(eventName) && typeof p.artifactId === "string") {
      const artifact = fetchArtifactItem(db, p.artifactId);
      return artifact ? { ...p, artifact } : p;
    }
  } catch {
    // fat fields are additive - fall through to the raw payload
  }
  return payload;
}

export type EventSender = (frame: string) => void;

export interface SubscribeConnectEventsOptions {
  /** Trailing-debounce window for delegation_group:progress bursts. */
  delegationFlushMs?: number;
}

const DELEGATION_FLUSH_MS = 500;
const DELEGATION_TERMINAL_STATUSES = new Set(["completed", "failed"]);

function frame(eventName: string, payload: unknown): string {
  return JSON.stringify({
    type: "event",
    event: eventName,
    payload,
    ts: new Date().toISOString(),
    source: "skipper",
  });
}

export function subscribeConnectEvents(sender: EventSender, options: SubscribeConnectEventsOptions = {}): () => void {
  const cleanup: Array<() => void> = [];
  const delegationFlushMs = options.delegationFlushMs ?? DELEGATION_FLUSH_MS;
  // delegation_group:progress fires per settled child - coalesce bursts per
  // group with a trailing debounce, always flushing terminal states instantly.
  const delegationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const send = (eventName: string, payload: unknown) => {
    try {
      sender(frame(eventName, payload));
    } catch {
      // ignore serialization errors
    }
  };

  // Advertise push capabilities so the integrator/web app can decide between
  // fat-event patching and legacy refetch mode. Ordinary event frame: old
  // servers fan it out, old consumers ignore the unknown name.
  send("connect:capabilities", {
    protocolVersion: CONNECT_PROTOCOL_VERSION,
    features: ["snapshot", "fat_events", "output_tail"],
  });

  for (const eventName of FORWARDED_EVENTS) {
    const handler = (payload: unknown) => {
      if (eventName === "delegation_group:progress") {
        const progress = payload as DelegationGroupProgressEvent;
        const existing = delegationTimers.get(progress.groupId);
        if (existing) clearTimeout(existing);
        if (DELEGATION_TERMINAL_STATUSES.has(progress.status)) {
          delegationTimers.delete(progress.groupId);
          send(eventName, payload);
          return;
        }
        delegationTimers.set(
          progress.groupId,
          setTimeout(() => {
            delegationTimers.delete(progress.groupId);
            send(eventName, payload);
          }, delegationFlushMs),
        );
        return;
      }
      send(eventName, enrichPayload(eventName, payload));
    };
    // Use base EventEmitter methods to avoid complex generic constraints on the
    // typed bus — correct at runtime, only the handler type is widened.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (eventBus as any).on(eventName, handler);
    cleanup.push(() => (eventBus as any).off(eventName, handler)); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  return () => {
    for (const fn of cleanup) fn();
    for (const timer of delegationTimers.values()) clearTimeout(timer);
    delegationTimers.clear();
  };
}
