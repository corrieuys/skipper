import { describe, it, expect } from "bun:test";
import {
  encodeActionValue,
  decodeActionValue,
  escalationMessageBlocks,
  reviewMessageBlocks,
  completionMessageBlocks,
  actionModal,
  readModalMessage,
  MODAL_INPUT_BLOCK,
  MODAL_INPUT_ACTION,
  MODAL_CALLBACK_ID,
} from "./blocks";

describe("action value codec", () => {
  it("round-trips kind/action/id", () => {
    const v = { kind: "esc" as const, action: "respond" as const, id: "abc-123" };
    expect(decodeActionValue(encodeActionValue(v))).toEqual(v);
  });

  it("handles ids containing no colons (uuids)", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const decoded = decodeActionValue(encodeActionValue({ kind: "rev", action: "reject", id }));
    expect(decoded?.id).toBe(id);
  });

  it("round-trips the task iterate action", () => {
    const v = { kind: "task" as const, action: "iterate" as const, id: "task-9" };
    expect(decodeActionValue(encodeActionValue(v))).toEqual(v);
  });

  it("rejects malformed values", () => {
    expect(decodeActionValue("")).toBeNull();
    expect(decodeActionValue("nope")).toBeNull();
    expect(decodeActionValue("esc:bogus:x")).toBeNull();
  });
});

describe("message blocks", () => {
  it("escalation message carries Respond + Dismiss buttons with encoded values", () => {
    const blocks = escalationMessageBlocks("e1", "Fix login", "Which DB?") as Array<Record<string, unknown>>;
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<{ value: string }> };
    const values = actions.elements.map((e) => e.value);
    expect(values).toContain("esc:respond:e1");
    expect(values).toContain("esc:dismiss:e1");
  });

  it("review message carries Approve + Reject buttons keyed by task id", () => {
    const blocks = reviewMessageBlocks("t1", "Add webhook", "build") as Array<Record<string, unknown>>;
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<{ value: string }> };
    const values = actions.elements.map((e) => e.value);
    expect(values).toContain("rev:approve:t1");
    expect(values).toContain("rev:reject:t1");
  });

  it("completion notice carries an Iterate button keyed by task id", () => {
    const blocks = completionMessageBlocks("t1", "Add webhook") as Array<Record<string, unknown>>;
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<{ value: string }> };
    expect(actions.elements.map((e) => e.value)).toContain("task:iterate:t1");
  });
});

describe("modal", () => {
  it("stashes meta in private_metadata and reads back the input", () => {
    const meta = { kind: "rev" as const, action: "reject" as const, id: "t1", channel: "C1", messageTs: "111.22" };
    const view = actionModal({ meta, title: "Reject", label: "Why?", submit: "Reject", optional: false });
    expect(view.callback_id).toBe(MODAL_CALLBACK_ID);
    expect(JSON.parse(view.private_metadata as string)).toEqual(meta);

    const submitted = {
      state: { values: { [MODAL_INPUT_BLOCK]: { [MODAL_INPUT_ACTION]: { value: "  add tests  " } } } },
    };
    expect(readModalMessage(submitted)).toBe("add tests");
  });
});
