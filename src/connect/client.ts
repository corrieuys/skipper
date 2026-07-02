import { getStringSetting, SETTING_SKIPPER_CONNECT_KEY, SETTING_SKIPPER_CONNECT_URL } from "../config/app-settings";
import { getDb } from "../db/connection";
import type { TaskScheduler } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { EscalationManager } from "../escalations/manager";
import type { ArtifactManager } from "../orchestrator/artifact-manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import type { ClientMessage, ServerMessage, ConnectTool } from "./protocol";
import { executeCommand } from "./commands";
import { handleResourceRequest, type ResourceDeps } from "./resources";
import { subscribeConnectEvents } from "./events";

const MAX_BACKOFF_MS = 60_000;

export type ConnectionStatus = "disabled" | "connecting" | "connected" | "auth_failed" | "error";

export class ConnectClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private running = false;
  private _connectionStatus: ConnectionStatus = "disabled";
  private _eventUnsub: (() => void) | null = null;

  private taskScheduler: TaskScheduler;
  private scheduledTaskScheduler: ScheduledTaskScheduler;
  private escalationManager: EscalationManager;
  private artifactManager: ArtifactManager;
  private phaseManager: PhaseManager;

  constructor(
    taskScheduler: TaskScheduler,
    scheduledTaskScheduler: ScheduledTaskScheduler,
    escalationManager: EscalationManager,
    artifactManager: ArtifactManager,
    phaseManager: PhaseManager,
  ) {
    this.taskScheduler = taskScheduler;
    this.scheduledTaskScheduler = scheduledTaskScheduler;
    this.escalationManager = escalationManager;
    this.artifactManager = artifactManager;
    this.phaseManager = phaseManager;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.backoffMs = 1_000;
    this._connectionStatus = "connecting";
    this.connect();
  }

  stop(): void {
    this.running = false;
    this._connectionStatus = "disabled";
    this._eventUnsub?.();
    this._eventUnsub = null;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getConnectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  private get resourceDeps(): ResourceDeps {
    return {
      taskScheduler: this.taskScheduler,
      scheduledTaskScheduler: this.scheduledTaskScheduler,
      escalationManager: this.escalationManager,
      artifactManager: this.artifactManager,
      phaseManager: this.phaseManager,
    };
  }

  private connect(): void {
    if (!this.running) return;

    const db = getDb();
    const baseUrl = getStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "");
    const connectKey = getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "");

    if (!connectKey || !baseUrl) {
      console.warn("[connect] Missing connect URL or key, not connecting");
      this.running = false;
      this._connectionStatus = "disabled";
      return;
    }

    const wsUrl = `${baseUrl.replace(/\/+$/, "")}/connect?token=${encodeURIComponent(connectKey)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error("[connect] Failed to create WebSocket:", err);
      this._connectionStatus = "error";
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1_000;
      this._connectionStatus = "connecting";
      console.log("[connect] WebSocket open — awaiting auth_ok");
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === "auth_ok") {
        this._connectionStatus = "connected";
        console.log("[connect] Authenticated — Skipper Connect live");
        this._eventUnsub?.();
        this._eventUnsub = subscribeConnectEvents((frame) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        });
      } else if (msg.type === "auth_error") {
        this._connectionStatus = "auth_failed";
        console.error("[connect] Auth rejected by server:", msg.message);
        ws.close();
      } else if (msg.type === "ping") {
        const pong: ClientMessage = { type: "pong" };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(pong));
      } else if (msg.type === "command") {
        this.handleCommand(ws, msg.id, msg.tool, (msg.args ?? {}) as Record<string, unknown>);
      } else if (msg.type === "request") {
        this.handleRequest(ws, msg.id, msg.resource, msg.action, (msg.params ?? {}) as Record<string, unknown>);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      this._eventUnsub?.();
      this._eventUnsub = null;
      this.ws = null;
      if (event.code === 4001) {
        this.running = false;
        this._connectionStatus = "auth_failed";
        console.error("[connect] Auth failed (code 4001), check the Connect API Key in config. Reconnect stopped.");
        return;
      }
      if (this.running) {
        this._connectionStatus = "error";
        console.log(`[connect] Disconnected (code ${event.code}) — scheduling reconnect`);
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose fires immediately after; no-op here to suppress unhandled error
    };
  }

  private handleCommand(ws: WebSocket, id: string, tool: ConnectTool, args: Record<string, unknown>): void {
    const result = executeCommand(tool, args, this.taskScheduler, this.scheduledTaskScheduler);
    const resultMsg: ClientMessage = result.ok
      ? { type: "result", id, ok: true, data: result.data }
      : { type: "result", id, ok: false, error: result.error };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(resultMsg));
    }
  }

  private handleRequest(ws: WebSocket, id: string, resource: string, action: string, params: Record<string, unknown>): void {
    handleResourceRequest(resource, action, params, this.resourceDeps).then((result) => {
      const responseMsg: ClientMessage = result.ok
        ? { type: "response", id, ok: true, data: result.data }
        : { type: "response", id, ok: false, error: result.error };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(responseMsg));
      }
    }).catch((err) => {
      const responseMsg: ClientMessage = { type: "response", id, ok: false, error: err instanceof Error ? err.message : String(err) };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(responseMsg));
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    console.log(`[connect] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

let _connectClient: ConnectClient | null = null;

export function initConnectClient(
  taskScheduler: TaskScheduler,
  scheduledTaskScheduler: ScheduledTaskScheduler,
  escalationManager: EscalationManager,
  artifactManager: ArtifactManager,
  phaseManager: PhaseManager,
): ConnectClient {
  _connectClient = new ConnectClient(taskScheduler, scheduledTaskScheduler, escalationManager, artifactManager, phaseManager);
  return _connectClient;
}

export function getConnectClient(): ConnectClient | null {
  return _connectClient;
}
