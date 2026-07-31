import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { saveSlackConfig } from "../config/slack-settings";
import { handleInteraction, type InteractionDeps } from "./interactions";
import { MODAL_INPUT_BLOCK, MODAL_INPUT_ACTION } from "./blocks";
import type { EscalationManager } from "../escalations/manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import type { TaskScheduler } from "../tasks/scheduler";
import type { SlackClient } from "./client";

const USER = "U-allowed";

let db: Database;
let calls: {
  resolve: Array<{ id: string; resp: string }>;
  dismiss: string[];
  approve: Array<{ id: string; note?: string }>;
  reject: Array<{ id: string; msg?: string }>;
  iterate: Array<{ id: string; input: string }>;
  openView: Array<{ triggerId: string; view: Record<string, unknown> }>;
  update: Array<{ channel: string; ts: string; text: string; blocks?: unknown }>;
};
let deps: InteractionDeps;

// State the buttons point at. Buttons outlive their records — a task swept by
// retention, an escalation answered in the web UI — so each test sets the world
// its click lands in. Defaults are the happy path: everything still actionable.
let taskStatus: string | null;
let escalationStatus: string;
let escalationGone: boolean;

/** A task row in the state a review button expects: running, review open. */
function seedReviewTask(id: string, opts: { needsReview?: boolean; status?: string } = {}): void {
  db.prepare("INSERT INTO tasks (id, title, status, needs_review) VALUES (?, 'Add webhook', ?, ?)").run(
    id,
    opts.status ?? "running",
    opts.needsReview === false ? 0 : 1,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  saveSlackConfig(db, { botToken: "", defaultChannel: "", allowedUsers: [USER] });
  calls = { resolve: [], dismiss: [], approve: [], reject: [], iterate: [], openView: [], update: [] };
  taskStatus = "completed";
  escalationStatus = "open";
  escalationGone = false;

  const escalationManager = {
    resolveEscalation: async (id: string, resp: string) => {
      calls.resolve.push({ id, resp });
    },
    dismissEscalation: (id: string) => {
      calls.dismiss.push(id);
      return {} as unknown;
    },
    // Re-derived when editing the message so the original question stays visible.
    getEscalation: (id: string) => (escalationGone ? null : { id, task_id: "t-esc", question: "Which database should I use?", status: escalationStatus }),
  } as unknown as EscalationManager;

  const phaseManager = {
    approveReview: async (id: string, note?: string) => {
      calls.approve.push({ id, note });
    },
    rejectReview: async (id: string, msg?: string) => {
      calls.reject.push({ id, msg });
    },
  } as unknown as PhaseManager;

  const client = {
    openView: async (triggerId: string, view: Record<string, unknown>) => {
      calls.openView.push({ triggerId, view });
    },
    updateMessage: async (channel: string, ts: string, text: string, blocks?: unknown) => {
      calls.update.push({ channel, ts, text, blocks });
    },
  } as unknown as SlackClient;

  const taskScheduler = {
    iterateTask: (id: string, input: string) => {
      calls.iterate.push({ id, input });
      return {} as unknown;
    },
    getTask: (id: string) => (taskStatus ? { id, status: taskStatus } : null),
  } as unknown as TaskScheduler;

  deps = { db, client, escalationManager, phaseManager, taskScheduler };
});

afterEach(() => db.close());

function blockAction(value: string, opts: { user?: string; triggerId?: string } = {}) {
  return {
    type: "block_actions" as const,
    user: { id: opts.user ?? USER },
    trigger_id: opts.triggerId ?? "trig-1",
    response_url: undefined,
    channel: { id: "C1" },
    message: { ts: "111.22" },
    actions: [{ action_id: "x", value }],
  };
}

/** Join every section's mrkdwn text from an updated message's blocks. */
function updateBlockText(blocks: unknown): string {
  return ((blocks as Array<{ text?: { text?: string } }>) ?? [])
    .map((b) => b?.text?.text ?? "")
    .join("\n");
}

function viewSubmission(meta: object, message: string, user = USER) {
  return {
    type: "view_submission" as const,
    user: { id: user },
    view: {
      private_metadata: JSON.stringify(meta),
      state: { values: { [MODAL_INPUT_BLOCK]: { [MODAL_INPUT_ACTION]: { value: message } } } },
    },
  };
}

describe("block_actions", () => {
  it("dismiss (authorized) dismisses the escalation and edits the message", async () => {
    const res = handleInteraction(deps, blockAction("esc:dismiss:e1"));
    await res.run?.();
    expect(calls.dismiss).toEqual(["e1"]);
    expect(calls.update[0]?.channel).toBe("C1");
    expect(calls.update[0]?.ts).toBe("111.22");
  });

  it("respond opens a modal carrying kind/action/id + origin message coords", async () => {
    const res = handleInteraction(deps, blockAction("esc:respond:e1"));
    await res.run?.();
    expect(calls.openView).toHaveLength(1);
    const meta = JSON.parse(calls.openView[0]!.view.private_metadata as string);
    expect(meta).toEqual({ kind: "esc", action: "respond", id: "e1", channel: "C1", messageTs: "111.22" });
  });

  it("reject opens a modal for the task id", async () => {
    seedReviewTask("t1");
    const res = handleInteraction(deps, blockAction("rev:reject:t1"));
    await res.run?.();
    const meta = JSON.parse(calls.openView[0]!.view.private_metadata as string);
    expect(meta.kind).toBe("rev");
    expect(meta.action).toBe("reject");
    expect(meta.id).toBe("t1");
  });

  it("iterate opens a modal for the task id", async () => {
    const res = handleInteraction(deps, blockAction("task:iterate:t9"));
    await res.run?.();
    expect(calls.openView).toHaveLength(1);
    const meta = JSON.parse(calls.openView[0]!.view.private_metadata as string);
    expect(meta).toEqual({ kind: "task", action: "iterate", id: "t9", channel: "C1", messageTs: "111.22" });
  });

  it("unauthorized user cannot dismiss", async () => {
    const res = handleInteraction(deps, blockAction("esc:dismiss:e1", { user: "U-stranger" }));
    await res.run?.();
    expect(calls.dismiss).toEqual([]);
    expect(calls.openView).toEqual([]);
  });
});

// Buttons sit in Slack scrollback long after the records behind them go away.
// Catching that at click time is the whole point: the alternative is the operator
// typing a full response into a modal and losing it to a throw on submit.
describe("block_actions — stale items", () => {
  it("iterate on a deleted task explains itself instead of opening a modal", async () => {
    taskStatus = null; // swept by task retention
    const res = handleInteraction(deps, blockAction("task:iterate:t9"));
    await res.run?.();
    expect(calls.openView).toEqual([]);
    // The dead button is replaced so the next reader doesn't hit the same wall.
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]?.text).toContain("no longer exists");
  });

  it("iterate on a task that is running again says so", async () => {
    taskStatus = "running";
    await handleInteraction(deps, blockAction("task:iterate:t9")).run?.();
    expect(calls.openView).toEqual([]);
    expect(calls.update[0]?.text).toContain("running");
  });

  it("respond on an already-handled escalation does not open a modal", async () => {
    escalationStatus = "resolved";
    await handleInteraction(deps, blockAction("esc:respond:e1")).run?.();
    expect(calls.openView).toEqual([]);
    expect(calls.update[0]?.text).toContain("already been handled");
  });

  it("respond on a vanished escalation does not open a modal", async () => {
    escalationGone = true;
    await handleInteraction(deps, blockAction("esc:respond:e1")).run?.();
    expect(calls.openView).toEqual([]);
    expect(calls.update[0]?.text).toContain("no longer exists");
  });

  // approveReview/rejectReview return silently when the review is closed, which
  // used to leave the message claiming the approval worked.
  it("approve on a closed review does not open a modal", async () => {
    seedReviewTask("t1", { needsReview: false });
    await handleInteraction(deps, blockAction("rev:approve:t1")).run?.();
    expect(calls.openView).toEqual([]);
    expect(calls.update[0]?.text).toContain("no longer open");
  });

  // Dismiss acts immediately rather than via a modal, so without the precheck the
  // manager's own throw ("Escalation not found: e1") is what lands in the channel.
  it("dismiss on a vanished escalation explains itself instead of raising", async () => {
    escalationGone = true;
    await handleInteraction(deps, blockAction("esc:dismiss:e1")).run?.();
    expect(calls.dismiss).toEqual([]);
    expect(calls.update[0]?.text).toContain("no longer exists");
    expect(calls.update[0]?.text).not.toContain("Could not dismiss");
  });

  it("dismiss on an already-handled escalation says so", async () => {
    escalationStatus = "resolved";
    await handleInteraction(deps, blockAction("esc:dismiss:e1")).run?.();
    expect(calls.dismiss).toEqual([]);
    expect(calls.update[0]?.text).toContain("already been handled");
  });

  // Retiring a button shouldn't wipe what the thread was about — an escalation
  // answered in the web UI still has its question, so it stays on screen.
  it("keeps the recoverable context when it retires a dead button", async () => {
    escalationStatus = "resolved";
    await handleInteraction(deps, blockAction("esc:respond:e1")).run?.();
    expect(updateBlockText(calls.update[0]?.blocks)).toContain("Which database should I use?");
  });

  it("dismiss on an open escalation still acts immediately without a modal", async () => {
    await handleInteraction(deps, blockAction("esc:dismiss:e1")).run?.();
    expect(calls.dismiss).toEqual(["e1"]);
    expect(calls.openView).toEqual([]);
  });
});

describe("view_submission", () => {
  it("respond resolves the escalation with the typed message and edits the message", async () => {
    const meta = { kind: "esc", action: "respond", id: "e1", channel: "C1", messageTs: "111.22" };
    const res = handleInteraction(deps, viewSubmission(meta, "use the staging DB"));
    expect(res.ackPayload).toBeUndefined();
    await res.run?.();
    expect(calls.resolve).toEqual([{ id: "e1", resp: "use the staging DB" }]);
    expect(calls.update).toHaveLength(1);
  });

  it("approve advances the review with an optional note (undefined when blank)", async () => {
    const meta = { kind: "rev", action: "approve", id: "t1", channel: "C1", messageTs: "111.22" };
    await handleInteraction(deps, viewSubmission(meta, "")).run?.();
    expect(calls.approve).toEqual([{ id: "t1", note: undefined }]);
  });

  it("renders the user mention (not escaped) in the edited notice block", async () => {
    const meta = { kind: "rev", action: "approve", id: "t1", channel: "C1", messageTs: "111.22" };
    await handleInteraction(deps, viewSubmission(meta, "")).run?.();
    const allText = updateBlockText(calls.update[0]?.blocks);
    expect(allText).toContain(`<@${USER}>`);
    expect(allText).not.toContain("&lt;@");
  });

  it("escapes mrkdwn specials in the operator-typed quote body", async () => {
    const meta = { kind: "esc", action: "respond", id: "e1", channel: "C1", messageTs: "111.22" };
    await handleInteraction(deps, viewSubmission(meta, "use <prod> & staging")).run?.();
    expect(updateBlockText(calls.update[0]?.blocks)).toContain("&lt;prod&gt; &amp; staging");
  });

  it("keeps the original escalation question on screen after resolving", async () => {
    const meta = { kind: "esc", action: "respond", id: "e1", channel: "C1", messageTs: "111.22" };
    await handleInteraction(deps, viewSubmission(meta, "use the staging DB")).run?.();
    const allText = updateBlockText(calls.update[0]?.blocks);
    // Original question survives...
    expect(allText).toContain("Which database should I use?");
    // ...alongside the resolution notice.
    expect(allText).toContain("Escalation resolved");
    // ...but the action buttons are gone (no actions block remains).
    const blocks = calls.update[0]?.blocks as Array<{ type?: string }>;
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("reject regresses the review with the required feedback", async () => {
    const meta = { kind: "rev", action: "reject", id: "t1", channel: "C1", messageTs: "111.22" };
    await handleInteraction(deps, viewSubmission(meta, "add tests first")).run?.();
    expect(calls.reject).toEqual([{ id: "t1", msg: "add tests first" }]);
  });

  it("iterate re-runs the completed task with the typed prompt and edits the notice", async () => {
    const meta = { kind: "task", action: "iterate", id: "t9", channel: "C1", messageTs: "111.22" };
    await handleInteraction(deps, viewSubmission(meta, "also handle the empty-input case")).run?.();
    expect(calls.iterate).toEqual([{ id: "t9", input: "also handle the empty-input case" }]);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]?.text).toContain("Iteration started");
  });

  it("unauthorized submission returns modal errors and performs no action", async () => {
    const meta = { kind: "rev", action: "approve", id: "t1", channel: "C1", messageTs: "111.22" };
    const res = handleInteraction(deps, viewSubmission(meta, "ok", "U-stranger"));
    expect((res.ackPayload as { response_action?: string })?.response_action).toBe("errors");
    expect(res.run).toBeUndefined();
    expect(calls.approve).toEqual([]);
  });
});
