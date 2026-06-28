export type ClientMessage =
  | { type: "result"; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: "response"; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: "event"; event: string; payload: unknown; ts: string; source: "skipper" }
  | { type: "pong" };

export type ServerMessage =
  | { type: "auth_ok" }
  | { type: "auth_error"; message: string }
  | { type: "command"; id: string; tool: ConnectTool; args: Record<string, unknown> }
  | { type: "request"; id: string; resource: string; action: string; params: Record<string, unknown> }
  | { type: "ping" };

export const CONNECT_TOOLS = [
  "create-task",
  "delete-task",
  "list-draft-tasks",
  "approve-task",
  "run-recurring-task",
] as const;

export type ConnectTool = (typeof CONNECT_TOOLS)[number];
