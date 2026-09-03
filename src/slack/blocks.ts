import { htmlToMrkdwn } from "./html-to-mrkdwn";

// Block Kit builders + the action-value codec shared by the outbound push
// (src/slack/push.ts) and the interactive handler (src/slack/interactions.ts).
//
// Buttons carry all correlation state in their `value` (kind + action + target
// id) so a click needs no server-side lookup table. Modals carry the same plus
// the origin message coordinates in `private_metadata`, so the message can be
// edited in place once the action completes.

// "task"/"iterate" survive only so legacy Iterate buttons in Slack scrollback
// still decode (they self-heal with a pointer to the thread-reply input flow);
// no new message carries them.
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

/**
 * Hard cap on the escalation section's text. A Block Kit section caps at 3000
 * chars; this leaves headroom for the title + heading prefix. Exported because
 * the push logs when it is about to bite (`push.ts`) — one limit, one constant.
 */
export const ESCALATION_TEXT_LIMIT = 2900;

/**
 * Cap for a section whose body is already length-limited upstream — today the
 * operator message, capped at `MESSAGE_MAX_LENGTH` (2900). Sits just under Block
 * Kit's hard 3000 so the `:speech_balloon: *<agent>*: ` prefix fits without
 * eating the tail of a maximum-length message. Applied after mrkdwn escaping, so
 * an `&`-heavy body can never push the payload past what Slack accepts.
 */
export const SECTION_TEXT_LIMIT = 2990;

/**
 * The figure agents are told to write to, comfortably inside
 * `ESCALATION_TEXT_LIMIT` once the title and heading prefix are spent. Three
 * surfaces quote it (the SLACK ORIGIN prompt block, the `slack_send_*` capture
 * note, the `escalate` warning) and they drifted apart once already, so they all
 * read it from here.
 */
export const SLACK_ESCALATION_SOFT_LIMIT = 2500;

/** Message posted when an escalation opens: question + Respond / Dismiss. */
export function escalationMessageBlocks(escalationId: string, taskTitle: string, question: string): unknown[] {
  // The question is agent-authored HTML; translate it to Slack mrkdwn. The title
  // is plain, so simple escaping is enough.
  const body = `:warning: *Escalation* — ${escapeMrkdwn(taskTitle)}\n${htmlToMrkdwn(question)}`;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(body, ESCALATION_TEXT_LIMIT) },
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
      text: { type: "mrkdwn", text: `:mag: *Phase review required* — ${escapeMrkdwn(taskTitle)}\nPhase: ${escapeMrkdwn(phaseLabel)}` },
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
 * Notice posted back into the origin thread when a run settles (completed or
 * failed). The task stays active in the unified model, so there is no button:
 * a thread reply containing the word "Skipper" is fed straight to the task as
 * new input and continues the conversation.
 */
export function completionMessageBlocks(taskTitle: string, failed = false): unknown[] {
  const headline = failed
    ? `:x: Task *${escapeMrkdwn(taskTitle)}* stopped, its run failed before finishing.`
    : `:white_check_mark: Task *${escapeMrkdwn(taskTitle)}* finished its run.`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${headline}\nReply in this thread (include the word "Skipper") to continue this task.`,
      },
    },
  ];
}

/**
 * An operator message (src/messages) posted into the task's thread. No buttons —
 * there is nothing to act on; it is an agent telling the human what is happening.
 * The emoji is what separates it at a glance from an escalation, which looks
 * similar but is waiting on an answer.
 *
 * The content is plain text by construction (`MessageManager.normalizeContent`
 * collapses it to one line and caps its length), so it only needs mrkdwn escaping —
 * `htmlToMrkdwn` is for the agent-authored HTML in escalations, not for this.
 */
export function operatorMessageBlocks(agentName: string, content: string): unknown[] {
  const body = `:speech_balloon: *${escapeMrkdwn(agentName)}*: ${escapeMrkdwn(content)}`;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(body, SECTION_TEXT_LIMIT) },
    },
  ];
}

/**
 * A single-section replacement for a message once it has been actioned. `text` is
 * ALREADY composed mrkdwn (bold, `<@user>` mentions, `> quotes`) — escaping it here
 * would turn `<@U…>` into literal text instead of a rendered mention, so it passes
 * through untouched. Callers must escape any untrusted interpolated content with
 * `escapeMrkdwn` before it reaches this function.
 */
export function noticeBlocks(text: string): unknown[] {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
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
export function escapeMrkdwn(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cap a string to Slack's section limit, marking where it was cut. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
