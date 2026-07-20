import type { Database } from "bun:sqlite";
import { logError } from "../logging";
import { isSlackUserAllowed } from "../config/slack-settings";
import type { EscalationManager } from "../escalations/manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import type { SlackClient } from "./client";
import {
  decodeActionValue,
  actionModal,
  noticeBlocks,
  readModalMessage,
  MODAL_INPUT_BLOCK,
  type ModalMeta,
} from "./blocks";

export interface InteractionDeps {
  db: Database;
  client: SlackClient;
  escalationManager: EscalationManager;
  phaseManager: PhaseManager;
}

/** Minimal shapes of the Slack interactive payloads we consume. */
export interface BlockActionsPayload {
  type: "block_actions";
  user?: { id?: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

export interface ViewSubmissionPayload {
  type: "view_submission";
  user?: { id?: string };
  view?: {
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string }>> };
  };
}

export type InteractionPayload = BlockActionsPayload | ViewSubmissionPayload | { type?: string };

/**
 * Result the socket applies: `ackPayload` (if any) rides the envelope ACK; `run`
 * is the deferred work performed AFTER the ACK, because phase approve/reject can
 * respawn agents and blow the 3s ACK budget.
 */
export interface InteractionResult {
  ackPayload?: Record<string, unknown>;
  run?: () => Promise<void>;
}

/**
 * Route a Slack interactive payload (button click or modal submit) to the right
 * Skipper action. Pure over its deps; never throws (errors surface as message
 * edits / logs).
 */
export function handleInteraction(deps: InteractionDeps, payload: InteractionPayload): InteractionResult {
  if (payload.type === "block_actions") return handleBlockAction(deps, payload as BlockActionsPayload);
  if (payload.type === "view_submission") return handleViewSubmission(deps, payload as ViewSubmissionPayload);
  return {};
}

function handleBlockAction(deps: InteractionDeps, payload: BlockActionsPayload): InteractionResult {
  const userId = payload.user?.id ?? "";
  const action = payload.actions?.[0];
  const decoded = action ? decodeActionValue(action.value ?? "") : null;
  const channel = payload.channel?.id ?? "";
  const messageTs = payload.message?.ts ?? "";

  // The ACK for a block_action is always an empty envelope; work is deferred.
  if (!decoded) return {};

  if (!isSlackUserAllowed(deps.db, userId)) {
    return { run: () => postEphemeral(payload.response_url, "You are not authorized to act on Skipper items.") };
  }

  // Dismiss needs no message, so it runs straight away and edits the message.
  if (decoded.kind === "esc" && decoded.action === "dismiss") {
    return {
      run: async () => {
        try {
          deps.escalationManager.dismissEscalation(decoded.id);
          await editMessage(deps.client, channel, messageTs, `:heavy_multiplication_x: *Escalation dismissed* by <@${userId}>`);
        } catch (err) {
          logError(deps.db, "slack_interaction_dismiss", { id: decoded.id }, err);
          await editMessage(deps.client, channel, messageTs, `:warning: Could not dismiss: ${errMsg(err)}`);
        }
      },
    };
  }

  // Everything else collects a message in a modal. Thread the origin message
  // coordinates through so the submission can edit it.
  const meta: ModalMeta = { kind: decoded.kind, action: decoded.action, id: decoded.id, channel, messageTs };
  const spec = modalSpecFor(decoded.kind, decoded.action);
  if (!spec || !payload.trigger_id) return {};
  const view = actionModal({ meta, ...spec });
  return {
    run: async () => {
      try {
        await deps.client.openView(payload.trigger_id!, view);
      } catch (err) {
        logError(deps.db, "slack_interaction_openview", { id: decoded.id }, err);
      }
    },
  };
}

function handleViewSubmission(deps: InteractionDeps, payload: ViewSubmissionPayload): InteractionResult {
  const userId = payload.user?.id ?? "";
  const meta = parseMeta(payload.view?.private_metadata);
  if (!meta) return {};

  if (!isSlackUserAllowed(deps.db, userId)) {
    return {
      ackPayload: {
        response_action: "errors",
        errors: { [MODAL_INPUT_BLOCK]: "You are not authorized to act on Skipper items." },
      },
    };
  }

  const message = readModalMessage(payload.view ?? {});

  // ACK empty → the modal closes. The mutation runs after, since it may respawn
  // agents and exceed the 3s ACK window.
  return {
    run: async () => {
      try {
        const notice = await performAction(deps, meta, message, userId);
        await editMessage(deps.client, meta.channel, meta.messageTs, notice);
      } catch (err) {
        logError(deps.db, "slack_interaction_submit", { kind: meta.kind, action: meta.action, id: meta.id }, err);
        await editMessage(deps.client, meta.channel, meta.messageTs, `:warning: Action failed: ${errMsg(err)}`);
      }
    },
  };
}

async function performAction(deps: InteractionDeps, meta: ModalMeta, message: string, userId: string): Promise<string> {
  if (meta.kind === "esc" && meta.action === "respond") {
    await deps.escalationManager.resolveEscalation(meta.id, message);
    return `:white_check_mark: *Escalation resolved* by <@${userId}>\n> ${quote(message)}`;
  }
  if (meta.kind === "rev" && meta.action === "approve") {
    await deps.phaseManager.approveReview(meta.id, message || undefined);
    const note = message ? `\n> ${quote(message)}` : "";
    return `:white_check_mark: *Phase approved* by <@${userId}>${note}`;
  }
  if (meta.kind === "rev" && meta.action === "reject") {
    await deps.phaseManager.rejectReview(meta.id, message);
    return `:leftwards_arrow_with_hook: *Phase rejected* by <@${userId}>\n> ${quote(message)}`;
  }
  return ":grey_question: Unknown action.";
}

function modalSpecFor(
  kind: string,
  action: string,
): { title: string; label: string; submit: string; optional: boolean; placeholder?: string } | null {
  if (kind === "esc" && action === "respond") {
    return { title: "Respond", label: "Response to the agent", submit: "Send", optional: false, placeholder: "Your answer…" };
  }
  if (kind === "rev" && action === "approve") {
    return { title: "Approve phase", label: "Optional note for the next phase", submit: "Approve", optional: true };
  }
  if (kind === "rev" && action === "reject") {
    return { title: "Reject phase", label: "What should change?", submit: "Reject", optional: false, placeholder: "Why are you rejecting?" };
  }
  return null;
}

function parseMeta(raw: string | undefined): ModalMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ModalMeta;
    if (v && typeof v.id === "string" && typeof v.kind === "string" && typeof v.action === "string") return v;
  } catch {
    /* fall through */
  }
  return null;
}

async function editMessage(client: SlackClient, channel: string, ts: string, text: string): Promise<void> {
  if (!channel || !ts) return;
  try {
    await client.updateMessage(channel, ts, stripMrkdwn(text), noticeBlocks(text));
  } catch {
    /* best-effort: the action already succeeded even if the edit fails */
  }
}

/** Post an ephemeral reply to the clicking user via the interaction response_url. */
async function postEphemeral(responseUrl: string | undefined, text: string): Promise<void> {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch {
    /* best-effort */
  }
}

function quote(s: string): string {
  return s.replace(/\n/g, "\n> ");
}

function stripMrkdwn(s: string): string {
  return s.replace(/[*_>`]/g, "");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
