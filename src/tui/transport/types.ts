import type { TransportEvent } from "../model/types";

/**
 * A source of live dashboard state. Two implementations planned:
 *   - LocalTransport   → this machine's daemon over the open /ws/ui JSON socket
 *   - ConnectTransport → a remote instance via the Skipper Connect integrator
 *
 * The rest of the TUI (store, renderer, input) depends ONLY on this interface,
 * so swapping or adding a transport never touches the view layer. `execute` is
 * the seam for future write-interactivity (approve/cancel/create); read-only
 * transports leave it undefined and advertise `canWrite: false`.
 */
export interface Transport {
  /** Short human label for the header, e.g. "local" or "connect:acme". */
  readonly label: string;

  /** Begin streaming. Emits an initial `snapshot`, then live events + status. */
  start(onEvent: (e: TransportEvent) => void): Promise<void>;

  /** Tear down sockets/timers. Idempotent. */
  close(): Promise<void>;

  /** Force a fresh full snapshot (e.g. operator pressed "r"). Optional. */
  resync?(): void;

  capabilities(): TransportCapabilities;

  /** Future interactivity. Undefined until a transport implements writes. */
  execute?(action: WriteAction): Promise<void>;
}

export interface TransportCapabilities {
  canWrite: boolean;
}

/**
 * Placeholder write surface. Mirrors the Skipper Connect CONNECT_TOOLS set so a
 * ConnectTransport can map 1:1 later. No transport implements these yet.
 */
export type WriteAction =
  | { type: "approve-task"; taskId: string }
  | { type: "cancel-task"; taskId: string }
  | { type: "create-task"; title: string; prompt: string };
