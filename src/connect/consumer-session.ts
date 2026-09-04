import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import type { ClientMessage } from "./protocol";
import { handleResourceRequest, type ResourceDeps } from "./resources";
import { subscribeConnectEvents } from "./events";
import { OutputTailManager } from "./output-tail";

/**
 * Max concurrent output-tail subscriptions per consumer socket. Mirrors
 * MAX_OUTPUT_SUBS_PER_CONSUMER in the integrator worker so a client that
 * behaves against a remote instance behaves the same locally.
 */
export const MAX_OUTPUT_SUBS_PER_SESSION = 4;

export type SessionSender = (frame: string) => void;

export interface ConsumerSessionOptions {
  /** DB the output tail reads from (defaults to the process DB). */
  db?: Database;
  /** Called whenever the peer answers a ping (liveness bookkeeping). */
  onPong?: () => void;
  /** Subscription cap; defaults to MAX_OUTPUT_SUBS_PER_SESSION. */
  maxOutputSubs?: number;
}

/**
 * One consumer's view of this daemon over a socket: resource requests, the fat
 * event stream and live output tails. Shared by the outbound `ConnectClient`
 * (integrator socket) and the local `/connect/local` endpoint, so both speak an
 * identical protocol. Command frames stay in `ConnectClient` (worker-only).
 *
 * Constructing the session already attaches the event stream, which emits
 * `connect:capabilities` at once.
 */
export class ConsumerSession {
  private eventUnsub: (() => void) | null;
  private outputTail: OutputTailManager | null;
  private readonly subscribed = new Set<string>();
  private readonly maxOutputSubs: number;
  private destroyed = false;

  constructor(
    private readonly sender: SessionSender,
    private readonly deps: ResourceDeps,
    private readonly options: ConsumerSessionOptions = {},
  ) {
    this.maxOutputSubs = options.maxOutputSubs ?? MAX_OUTPUT_SUBS_PER_SESSION;
    this.eventUnsub = subscribeConnectEvents(sender);
    this.outputTail = new OutputTailManager(options.db ?? getDb(), sender);
  }

  /** Parse a raw socket frame and dispatch it. Returns false when unhandled. */
  handleFrame(raw: string | Buffer): boolean {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>;
    } catch {
      return false;
    }
    return this.handleMessage(msg);
  }

  /** Dispatch an already-parsed frame. Returns false when unhandled. */
  handleMessage(msg: Record<string, unknown>): boolean {
    if (this.destroyed || !msg || typeof msg !== "object") return false;
    const type = msg.type;

    if (type === "request") {
      this.handleRequest(
        String(msg.id ?? ""),
        String(msg.resource ?? ""),
        String(msg.action ?? ""),
        (msg.params ?? {}) as Record<string, unknown>,
      );
      return true;
    }

    // Provider-side demand signals from the integrator worker (no acks).
    if (type === "output_subscribe") {
      this.subscribeOutputs(String(msg.taskId ?? ""), false);
      return true;
    }
    if (type === "output_unsubscribe") {
      this.unsubscribeOutputs(String(msg.taskId ?? ""), false);
      return true;
    }

    // Consumer-side subscribe/unsubscribe with acks (worker consumer branch).
    if (type === "subscribe" || type === "unsubscribe") {
      if (msg.channel !== "outputs") return false;
      const taskId = String(msg.taskId ?? "");
      if (type === "subscribe") this.subscribeOutputs(taskId, true);
      else this.unsubscribeOutputs(taskId, true);
      return true;
    }

    if (type === "ping") {
      this.send({ type: "pong" } satisfies ClientMessage);
      return true;
    }
    if (type === "pong") {
      this.options.onPong?.();
      return true;
    }

    return false;
  }

  /** Ask the peer for liveness (daemon-initiated ping on the local endpoint). */
  sendPing(): void {
    this.sendRaw(JSON.stringify({ type: "ping" }));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.eventUnsub?.();
    this.eventUnsub = null;
    this.outputTail?.destroy();
    this.outputTail = null;
    this.subscribed.clear();
  }

  private subscribeOutputs(taskId: string, ack: boolean): void {
    if (!taskId) {
      if (ack) this.sendRaw(JSON.stringify({ type: "sub_error", channel: "outputs", taskId, error: "taskId is required" }));
      return;
    }
    if (this.subscribed.has(taskId)) {
      if (ack) this.sendRaw(JSON.stringify({ type: "subscribed", channel: "outputs", taskId }));
      return;
    }
    // The cap is a consumer-socket notion. The integrator worker already caps
    // its own consumers and forwards the union to the provider, so the
    // ack-less (worker) path must not re-cap or it would silently drop tails.
    if (ack && this.subscribed.size >= this.maxOutputSubs) {
      this.sendRaw(
        JSON.stringify({
          type: "sub_error",
          channel: "outputs",
          taskId,
          error: `Subscription limit reached (${this.maxOutputSubs})`,
        }),
      );
      return;
    }
    this.subscribed.add(taskId);
    if (ack) this.sendRaw(JSON.stringify({ type: "subscribed", channel: "outputs", taskId }));
    // After the ack, so the backfill frame never precedes its own subscribed ack.
    this.outputTail?.handleSubscribe(taskId);
  }

  private unsubscribeOutputs(taskId: string, ack: boolean): void {
    if (!taskId) {
      if (ack) this.sendRaw(JSON.stringify({ type: "sub_error", channel: "outputs", taskId, error: "taskId is required" }));
      return;
    }
    if (this.subscribed.delete(taskId)) this.outputTail?.handleUnsubscribe(taskId);
    if (ack) this.sendRaw(JSON.stringify({ type: "unsubscribed", channel: "outputs", taskId }));
  }

  private handleRequest(id: string, resource: string, action: string, params: Record<string, unknown>): void {
    handleResourceRequest(resource, action, params, this.deps)
      .then((result) => {
        const response: ClientMessage = result.ok
          ? { type: "response", id, ok: true, data: result.data }
          : { type: "response", id, ok: false, error: result.error };
        this.send(response);
      })
      .catch((err) => {
        this.send({
          type: "response",
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies ClientMessage);
      });
  }

  private send(msg: ClientMessage): void {
    this.sendRaw(JSON.stringify(msg));
  }

  private sendRaw(frame: string): void {
    if (this.destroyed) return;
    try {
      this.sender(frame);
    } catch {
      // peer closed mid-send
    }
  }
}
