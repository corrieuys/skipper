import { describe, it, expect } from "bun:test";
import { taskMessageFragment, taskMessagesFragment } from "./task-message.fragment";
import type { TaskMessage } from "../../messages/manager";

function msg(overrides: Partial<TaskMessage> = {}): TaskMessage {
  return {
    id: "m-1",
    task_id: "t-1",
    agent_id: "agent-1",
    agent_instance_id: "inst-1",
    content: "Started on the login fix.",
    created_at: "2026-08-02 10:00:00.000",
    agent_name: "Skipper",
    ...overrides,
  };
}

describe("taskMessageFragment", () => {
  it("renders the agent name, the body, and no raw markup", () => {
    const html = taskMessageFragment(msg());
    expect(html).toContain("Skipper");
    expect(html).toContain("Started on the login fix.");
    expect(html).toContain("sk-message__body");
  });

  it("falls back to the agent id when no name joined", () => {
    const html = taskMessageFragment(msg({ agent_name: null }));
    expect(html).toContain("agent-1");
  });

  it("escapes the body rather than rendering it as markup", () => {
    const html = taskMessageFragment(msg({ content: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("taskMessagesFragment", () => {
  it("renders an empty state when there is nothing to show", () => {
    const html = taskMessagesFragment([]);
    expect(html).toContain("No messages yet");
    expect(html).not.toContain("sk-message-list");
  });

  it("renders one entry per message", () => {
    const html = taskMessagesFragment([msg({ id: "m-1" }), msg({ id: "m-2", content: "Tests passing." })]);
    expect(html).toContain("sk-message-list");
    expect(html).toContain("Tests passing.");
    expect(html.match(/class="sk-message"/g)).toHaveLength(2);
  });
});
