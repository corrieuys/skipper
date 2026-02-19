export type NotificationEventKey =
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "escalation.created"
  | "escalation.resolved"
  | "phase.review_pending";

export interface NotificationEventMeta {
  key: NotificationEventKey;
  label: string;
  description: string;
  soundFile: string;
}

export const NOTIFICATION_EVENTS: NotificationEventMeta[] = [
  { key: "task.started", label: "Task started", description: "A queued task transitions to running.", soundFile: "skipper_boop.mp3" },
  { key: "task.completed", label: "Task completed", description: "A running task finishes successfully.", soundFile: "skipper_boop.mp3" },
  { key: "task.failed", label: "Task failed", description: "A task fails or is moved to failed state.", soundFile: "skipper_chime.mp3" },
  { key: "escalation.created", label: "Escalation raised", description: "An agent escalated and is waiting for you.", soundFile: "skipper_chime.mp3" },
  { key: "escalation.resolved", label: "Escalation resolved", description: "An open escalation was answered/dismissed.", soundFile: "skipper_boop.mp3" },
  { key: "phase.review_pending", label: "Phase review pending", description: "A phase finished and is awaiting your review.", soundFile: "skipper_chime.mp3" },
];

export const SOUND_URL_PREFIX = "/sounds/";
