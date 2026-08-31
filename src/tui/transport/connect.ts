import type { Transport, TransportCapabilities } from "./types";
import type { TransportEvent } from "../model/types";

/**
 * Placeholder for monitoring a REMOTE instance through the Skipper Connect
 * integrator. Not implemented: the integrator's client-facing API (reader auth,
 * gid routing, state snapshot + event stream) lives in the separate
 * skipper-connect worker, not this repo. When that spec lands, this class maps
 * the integrator's projections onto the same {@link TransportEvent} shapes the
 * LocalTransport already produces — the store, renderer and input layers do not
 * change. `canWrite` will flip true here to expose the CONNECT_TOOLS actions.
 */
export class ConnectTransport implements Transport {
  readonly label = "connect";

  capabilities(): TransportCapabilities {
    return { canWrite: false };
  }

  async start(_onEvent: (e: TransportEvent) => void): Promise<void> {
    throw new ConnectUnavailableError();
  }

  async close(): Promise<void> {
    /* nothing to tear down */
  }
}

export class ConnectUnavailableError extends Error {
  constructor() {
    super(
      "Skipper Connect mode is not available yet: it needs the integrator's " +
        "client-facing API (reader auth + gid routing + state/event stream), " +
        "which is not part of this repo.",
    );
    this.name = "ConnectUnavailableError";
  }
}
