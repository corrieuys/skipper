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
  update: Array<{ channel: string; ts: string; text: string }>;
};
let deps: InteractionDeps;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  saveSlackConfig(db, { botToken: "", defaultChannel: "", allowedUsers: [USER] });
  calls = { resolve: [], dismiss: [], approve: [], reject: [], iterate: [], openView: [], update: [] };

  const escalationManager = {
    resolveEscalation: async (id: string, resp: string) => {
      calls.resolve.push({ id, resp });
    },
    dismissEscalation: (id: string) => {
      calls.dismiss.push(id);
      return {} as unknown;
    },
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
    updateMessage: async (channel: string, ts: string, text: string) => {
      calls.update.push({ channel, ts, text });
    },
  } as unknown as SlackClient;

  const taskScheduler = {
    iterateTask: (id: string, input: string) => {
      calls.iterate.push({ id, input });
      return {} as unknown;
    },
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
