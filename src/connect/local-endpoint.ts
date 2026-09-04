import type { Server, ServerWebSocket } from "bun";
import type { WSData } from "../ws/types";
import type { ResourceDeps } from "./resources";
import { ConsumerSession } from "./consumer-session";

export const CONNECT_LOCAL_PATH = "/connect/local";

/** Daemon → app liveness ping interval. */
const PING_INTERVAL_MS = 30_000;
/** Consecutive unanswered pings before the socket is closed. */
const MAX_MISSED_PONGS = 2;

/**
 * Loopback check for the local consumer endpoint. IPv4 loopback is the whole
 * 127.0.0.0/8 block; IPv6 loopback is ::1 (and its v4-mapped forms).
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const addr = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

interface LocalSocketState {
  session: ConsumerSession;
  pingTimer: ReturnType<typeof setInterval>;
  missedPongs: number;
}

/**
 * `GET /connect/local` — an inbound consumer WebSocket for clients running on
 * this machine (the Mac app). It speaks the same consumer protocol as the
 * integrator worker's consumer socket, so one client transport serves both.
 *
 * Unauthenticated by design and loopback-only, always: the rest of the local
 * HTTP surface has no auth either, and the upgrade is refused with 403 even
 * when SKIPPER_HOST exposes the daemon beyond loopback.
 */
export function createConnectLocalEndpoint(deps: ResourceDeps) {
  const sockets = new Map<ServerWebSocket<WSData>, LocalSocketState>();

  function detach(ws: ServerWebSocket<WSData>): void {
    const state = sockets.get(ws);
    if (!state) return;
    clearInterval(state.pingTimer);
    state.session.destroy();
    sockets.delete(ws);
  }

  return {
    /** Non-WS (or non-loopback) hits fall through to this route handler. */
    routeHandler(): Response {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    },

    tryUpgrade(req: Request, server: Server<WSData>): boolean {
      const url = new URL(req.url);
      if (url.pathname !== CONNECT_LOCAL_PATH) return false;
      // Not loopback → do not upgrade; the request falls through to the 403 route.
      if (!isLoopbackAddress(server.requestIP?.(req)?.address)) return false;
      return server.upgrade(req, { data: { type: "connect-local" as const } });
    },

    wsHandlers: {
      open(ws: ServerWebSocket<WSData>) {
        ws.send(JSON.stringify({ type: "auth_ok" }));
        const sender = (frame: string) => {
          try {
            ws.send(frame);
          } catch {
            // socket closed mid-send
          }
        };
        // Constructing the session subscribes to events, which immediately
        // emits connect:capabilities, so the client gets version + features.
        const session = new ConsumerSession(sender, deps, {
          onPong: () => {
            const state = sockets.get(ws);
            if (state) state.missedPongs = 0;
          },
        });
        const pingTimer = setInterval(() => {
          const state = sockets.get(ws);
          if (!state) return;
          if (state.missedPongs >= MAX_MISSED_PONGS) {
            ws.close(1001, "ping timeout");
            return;
          }
          state.missedPongs += 1;
          state.session.sendPing();
        }, PING_INTERVAL_MS);
        sockets.set(ws, { session, pingTimer, missedPongs: 0 });
      },

      message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
        sockets.get(ws)?.session.handleFrame(message);
      },

      close(ws: ServerWebSocket<WSData>) {
        detach(ws);
      },
    },

    /** Live socket count; used by tests to assert nothing leaks on close. */
    socketCount(): number {
      return sockets.size;
    },

    destroy(): void {
      for (const ws of [...sockets.keys()]) detach(ws);
    },
  };
}

export type ConnectLocalEndpoint = ReturnType<typeof createConnectLocalEndpoint>;
