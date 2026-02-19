import type { RealtimeSessionManager } from "../orchestrator/realtime-session";

export type UiPushWSData = { type: "ui-push"; subscriptions: Set<string>; format: "html" | "json" };

export type WSData =
  | { type: "realtime"; taskId: string; realtimeSessionManager: RealtimeSessionManager }
  | UiPushWSData;
