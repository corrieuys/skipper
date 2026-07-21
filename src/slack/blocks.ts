import { htmlToMrkdwn } from "./html-to-mrkdwn";

// Block Kit builders + the action-value codec shared by the outbound push
// (src/slack/push.ts) and the interactive handler (src/slack/interactions.ts).
//
// Buttons carry all correlation state in their `value` (kind + action + target
// id) so a click needs no server-side lookup table. Modals carry the same plus
// the origin message coordinates in `private_metadata`, so the message can be
// edited in place once the action completes.

export type ActionKind = "esc" | "rev" | "task";
export type ActionName = "respond" | "dismiss" | "approve" | "reject" | "iterate";

export interface ActionValue {
  kind: ActionKind;
  action: ActionName;
  /** escalation id (esc) or task id (rev / task). */
  id: string;
}

/** Encode `{kind, action, id}` into a button value. ids are UUIDs (no colons). */
export function encodeActionValue(v: ActionValue): string {
  return `${v.kind}:${v.action}:${v.id}`;
}

export function decodeActionValue(raw: string): ActionValue | null {
  const m = /^(esc|rev|task):(respond|dismiss|approve|reject|iterate):(.+)$/.exec(raw ?? "");
  if (!m) return null;
  return { kind: m[1] as ActionKind, action: m[2] as ActionName, id: m[3]! };
}

const MODAL_CALLBACK_ID = "skipper_action_submit";
export { MODAL_CALLBACK_ID };

/** Data threaded through a modal so its submission can act + edit the origin message. */
export interface ModalMeta {
  kind: ActionKind;
  action: ActionName;
  id: string;
  channel: string;
  messageTs: string;
}

function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  const b: Record<string, unknown> = {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    action_id: actionId,
    value,
  };
  if (style) b.style = style;
  return b;
}

/** Message posted when an escalation opens: question + Respond / Dismiss. */
export function escalationMessageBlocks(escalationId: string, taskTitle: string, question: string): unknown[] {
  // The question is agent-authored HTML; translate it to Slack mrkdwn. The title
  // is plain, so simple escaping is enough. A section's text field caps at 3000
  // chars — keep headroom for the title + heading prefix.
  const body = `:warning: *Escalation* — ${mrkdwn(taskTitle)}\n${htmlToMrkdwn(question)}`;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(body, 2900) },
    },
    {
      type: "actions",
      elements: [
        button("Respond", "esc_respond", encodeActionValue({ kind: "esc", action: "respond", id: escalationId }), "primary"),
        button("Dismiss", "esc_dismiss", encodeActionValue({ kind: "esc", action: "dismiss", id: escalationId })),
      ],
    },
  ];
}

/** Message posted when a phase needs review: Approve / Reject. */
export function reviewMessageBlocks(taskId: string, taskTitle: string, phaseLabel: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:mag: *Phase review required* — ${mrkdwn(taskTitle)}\nPhase: ${mrkdwn(phaseLabel)}` },
    },
    {
      type: "actions",
      elements: [
        button("Approve", "rev_approve", encodeActionValue({ kind: "rev", action: "approve", id: taskId }), "primary"),
        button("Reject", "rev_reject", encodeActionValue({ kind: "rev", action: "reject", id: taskId }), "danger"),
      ],
    },
  ];
}

/**
 * Task-completion notice posted back into the origin thread, carrying an Iterate
 * button. Clicking it opens a modal that collects the next iteration's prompt
 * (mirrors the web UI's iterate flow) → `TaskScheduler.iterateTask`. Only used for
 * completed tasks (a failed task can't be iterated), so the button always targets a
 * task that is currently iterable — a stale click self-heals with an error edit.
 */
export function completionMessageBlocks(taskId: string, taskTitle: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: Task *${mrkdwn(taskTitle)}* finished running.` },
    },
    {
      type: "actions",
      elements: [
        button("Iterate", "task_iterate", encodeActionValue({ kind: "task", action: "iterate", id: taskId }), "primary"),
      ],
    },
  ];
}

/** A single-section replacement for a message once it has been actioned. */
export function noticeBlocks(text: string): unknown[] {
  return [{ type: "section", text: { type: "mrkdwn", text: mrkdwn(text) } }];
}

export const MODAL_INPUT_BLOCK = "message";
export const MODAL_INPUT_ACTION = "message_input";

/**
 * Build the modal that collects the optional/required message for an action.
 * `optional` false forces the reviewer to type a reason (reject / respond).
 */
export function actionModal(opts: {
  meta: ModalMeta;
  title: string;
  label: string;
  submit: string;
  optional: boolean;
  placeholder?: string;
}): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(opts.meta),
    title: { type: "plain_text", text: opts.title.slice(0, 24) },
    submit: { type: "plain_text", text: opts.submit.slice(0, 24) },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: MODAL_INPUT_BLOCK,
        optional: opts.optional,
        label: { type: "plain_text", text: opts.label.slice(0, 150) },
        element: {
          type: "plain_text_input",
          action_id: MODAL_INPUT_ACTION,
          multiline: true,
          ...(opts.placeholder ? { placeholder: { type: "plain_text", text: opts.placeholder.slice(0, 150) } } : {}),
        },
      },
    ],
  };
}

/** Read the submitted message text out of a view_submission payload. */
export function readModalMessage(view: {
  state?: { values?: Record<string, Record<string, { value?: string }>> };
}): string {
  return view.state?.values?.[MODAL_INPUT_BLOCK]?.[MODAL_INPUT_ACTION]?.value?.trim() ?? "";
}

/** Slack mrkdwn escaping for the three special characters (& < >). */
function mrkdwn(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cap a string to Slack's section limit, marking where it was cut. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
