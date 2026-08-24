import type { RealtimeSessionManager } from "../orchestrator/realtime-session";

export type UiPushWSData = { type: "ui-push"; subscriptions: Set<string>; format: "html" | "json" };

export type WSData =
  | {
      type: "realtime";
      taskId: string;
      realtimeSessionManager: RealtimeSessionManager;
      // Recording-lock owner id this connection currently holds (e.g. "web:<id>"),
      // set on recording.start and cleared on recording.stop/close.
      recordingSource?: string;
    }
  | UiPushWSData;
