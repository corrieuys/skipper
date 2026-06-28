import { eventBus, type EventName } from "../events/bus";

// Events pushed to integrators. Excludes chatty per-line outputs.
const FORWARDED_EVENTS: readonly EventName[] = [
  "task:state_changed",
  "task:note_added",
  "task:needs_review_changed",
  "escalation:created",
  "escalation:resolved",
  "artifact:created",
  "consensus:phase_advance",
  "delegation_group:progress",
  "realtime:trigger_fired",
  "realtime:session_state",
] as const;

export type EventSender = (frame: string) => void;

export function subscribeConnectEvents(sender: EventSender): () => void {
  const cleanup: Array<() => void> = [];

  for (const eventName of FORWARDED_EVENTS) {
    const handler = (payload: unknown) => {
      try {
        sender(
          JSON.stringify({
            type: "event",
            event: eventName,
            payload,
            ts: new Date().toISOString(),
            source: "skipper",
          }),
        );
      } catch {
        // ignore serialization errors
      }
    };
    // Use base EventEmitter methods to avoid complex generic constraints on the
    // typed bus — correct at runtime, only the handler type is widened.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (eventBus as any).on(eventName, handler);
    cleanup.push(() => (eventBus as any).off(eventName, handler)); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  return () => {
    for (const fn of cleanup) fn();
  };
}
