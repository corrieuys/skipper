import type { Transport, TransportCapabilities } from "./types";
import type {
  TransportEvent,
  TaskRow,
  AgentRow,
  ActivityRow,
  PhaseInfo,
  Metrics,
} from "../model/types";

/**
 * Reads this machine's daemon over the open, unauthenticated /ws/ui JSON
 * socket (loopback-bound by default — no API key needed for local). On connect
 * the daemon pushes a full `dashboard:snapshot`; live `updated` envelopes
 * follow. On any drop we reconnect with backoff; the next snapshot resyncs, so
 * no missed-delta handling is required.
 */
export class LocalTransport implements Transport {
  readonly label = "local";

  private ws: WebSocket | null = null;
  private onEvent: ((e: TransportEvent) => void) | null = null;
  private closed = false;
  private backoffMs = 250;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: string = process.env.SKIPPER_HOST || "127.0.0.1",
    private readonly port: number = Number(process.env.PORT) || 5005,
  ) {}

  capabilities(): TransportCapabilities {
    return { canWrite: false };
  }

  async start(onEvent: (e: TransportEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.connect();
  }

  /** Drop the socket; the auto-reconnect re-opens and the daemon re-snapshots. */
  resync(): void {
    if (this.closed) return;
    try {
      this.ws?.close();
    } catch {
      /* the close handler schedules the reconnect */
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  private emit(e: TransportEvent): void {
    this.onEvent?.(e);
  }

  private connect(): void {
    if (this.closed) return;
    this.emit({ kind: "status", status: this.backoffMs === 250 ? "connecting" : "reconnecting" });

    const host = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    const url = `ws://${host}:${this.port}/ws/ui?format=json&topics=dashboard`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = 250;
      this.emit({ kind: "status", status: "connected" });
      // Topics are set via the URL, but resend for older servers / clarity.
      try {
        ws.send(JSON.stringify({ type: "subscribe", topics: ["dashboard"] }));
      } catch {
        /* race with close */
      }
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      const event = parseEnvelope(typeof ev.data === "string" ? ev.data : "");
      if (event) this.emit(event);
    });

    ws.addEventListener("close", () => {
      if (this.closed) return;
      this.emit({ kind: "status", status: "reconnecting" });
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // 'close' fires after 'error'; let scheduleReconnect run there.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

// ── envelope → TransportEvent ──────────────────────────────────────────────

interface Envelope {
  event?: string;
  resource?: string;
  data?: unknown;
  type?: string;
}

/** Parse one WS JSON frame. Returns null for heartbeats / unrecognized frames. */
export function parseEnvelope(raw: string): TransportEvent | null {
  if (!raw) return null;
  let msg: Envelope;
  try {
    msg = JSON.parse(raw) as Envelope;
  } catch {
    return null;
  }
  if (msg.type === "ping" || msg.type === "pong") return null;

  const data = (msg.data ?? {}) as Record<string, unknown>;
  switch (msg.resource) {
    case "dashboard:snapshot":
      return {
        kind: "snapshot",
        snapshot: {
          tasks: toTasks(data.tasks),
          agents: toAgents(data.running_instances),
          activity: toActivity(data.activity),
          phase: toPhase(data.phase_indicator),
          metrics: toMetrics(data.metrics),
        },
      };
    case "dashboard:tasks":
      return { kind: "tasks", tasks: toTasks(data.tasks) };
    case "dashboard:instances":
      return { kind: "agents", agents: toAgents(data.running_instances) };
    case "dashboard:activity":
      return { kind: "activity", activity: toActivity(data.activity) };
    case "dashboard:phase-indicator":
      return { kind: "phase", phase: toPhase(data.task) };
    case "dashboard:metrics":
      return { kind: "metrics", metrics: toMetrics(data) };
    default:
      return null;
  }
}

function toTasks(v: unknown): TaskRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      title: String(o.title ?? ""),
      status: String(o.status ?? ""),
      task_type: (o.task_type as string | undefined) ?? null,
      mode: (o.mode as string | undefined) ?? null,
      display_status: (o.display_status as string | undefined) ?? null,
      created_at: (o.created_at as string | undefined) ?? null,
    };
  });
}

function toAgents(v: unknown): AgentRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      template_agent_name: String(o.template_agent_name ?? o.template_agent_id ?? "agent"),
      task_id: (o.task_id as string | null | undefined) ?? null,
      task_title: (o.task_title as string | null | undefined) ?? null,
      status: String(o.status ?? ""),
      updated_at: (o.updated_at as string | undefined) ?? null,
    };
  });
}

const ACTIVITY_KINDS = new Set(["message", "tool", "event", "note"]);

function toActivity(v: unknown): ActivityRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    const kind = typeof o.kind === "string" && ACTIVITY_KINDS.has(o.kind) ? o.kind : "event";
    return {
      agent_id: String(o.agent_id ?? ""),
      agent_name: String(o.agent_name ?? "agent"),
      kind: kind as ActivityRow["kind"],
      text: String(o.text ?? ""),
      stream: String(o.stream ?? "stdout"),
      created_at: (o.created_at as string | undefined) ?? null,
    };
  });
}

/** Map the phase-indicator task projection (or null) into PhaseInfo. */
function toPhase(v: unknown): PhaseInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!o.id) return null;
  const phases = Array.isArray(o.phases) ? (o.phases as Array<Record<string, unknown>>) : [];
  const current = num(o.current_phase);
  const phaseName = phases[current] && typeof phases[current]?.name === "string" ? String(phases[current]!.name) : null;
  return {
    taskId: String(o.id),
    title: String(o.title ?? ""),
    status: String(o.status ?? ""),
    current,
    total: phases.length,
    needsReview: Boolean(o.needs_review),
    phaseName,
  };
}

function toMetrics(v: unknown): Metrics {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    running: num(o.running),
    queued: num(o.queued),
    completed: num(o.completed),
    failed: num(o.failed),
    activeAgentCount: num(o.activeAgentCount),
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
