import { describe, it, expect } from "bun:test";
import { eventBus, type AgentOutputEvent, type AgentExitEvent, type EscalationCreatedEvent, type EscalationResolvedEvent, type TaskNoteAddedEvent, type TaskStateChangedEvent, type AgentStateChangedEvent } from "./bus";

describe("EventBus", () => {
  it("emits and receives agent:output events", () => {
    const received: AgentOutputEvent[] = [];
    const listener = (event: AgentOutputEvent) => received.push(event);

    eventBus.on("agent:output", listener);
    eventBus.emit("agent:output", {
      agentId: "agent-1",
      stream: "stdout",
      data: "hello world",
      sequence: 1,
    });

    expect(received).toHaveLength(1);
    expect(received[0].agentId).toBe("agent-1");
    expect(received[0].data).toBe("hello world");

    eventBus.off("agent:output", listener);
  });

  it("emits and receives agent:exit events", () => {
    const received: AgentExitEvent[] = [];
    const listener = (event: AgentExitEvent) => received.push(event);

    eventBus.on("agent:exit", listener);
    eventBus.emit("agent:exit", {
      agentId: "agent-1",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    });

    expect(received).toHaveLength(1);
    expect(received[0].code).toBe(0);

    eventBus.off("agent:exit", listener);
  });

  it("emits and receives escalation:created events", () => {
    const received: EscalationCreatedEvent[] = [];
    const listener = (event: EscalationCreatedEvent) => received.push(event);

    eventBus.on("escalation:created", listener);
    eventBus.emit("escalation:created", {
      escalationId: "esc-1",
      agentId: "agent-1",
      taskId: "task-1",
      type: "agent_request",
      question: "Where are the credentials?",
    });

    expect(received).toHaveLength(1);
    expect(received[0].question).toBe("Where are the credentials?");

    eventBus.off("escalation:created", listener);
  });

  it("emits and receives escalation:resolved events", () => {
    const received: EscalationResolvedEvent[] = [];
    const listener = (event: EscalationResolvedEvent) => received.push(event);

    eventBus.on("escalation:resolved", listener);
    eventBus.emit("escalation:resolved", {
      escalationId: "esc-1",
      agentId: "agent-1",
      taskId: "task-1",
      response: "Check /etc/app.conf",
    });

    expect(received).toHaveLength(1);
    expect(received[0].response).toBe("Check /etc/app.conf");

    eventBus.off("escalation:resolved", listener);
  });

  it("emits and receives task:note_added events", () => {
    const received: TaskNoteAddedEvent[] = [];
    const listener = (event: TaskNoteAddedEvent) => received.push(event);

    eventBus.on("task:note_added", listener);
    eventBus.emit("task:note_added", {
      noteId: "note-1",
      taskId: "task-1",
      agentId: "agent-1",
      content: "Auth config is in /etc/app.conf",
    });

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("Auth config is in /etc/app.conf");

    eventBus.off("task:note_added", listener);
  });

  it("emits and receives task:state_changed events", () => {
    const received: TaskStateChangedEvent[] = [];
    const listener = (event: TaskStateChangedEvent) => received.push(event);

    eventBus.on("task:state_changed", listener);
    eventBus.emit("task:state_changed", {
      taskId: "task-1",
      previousStatus: "approved",
      newStatus: "running",
    });

    expect(received).toHaveLength(1);
    expect(received[0].newStatus).toBe("running");

    eventBus.off("task:state_changed", listener);
  });

  it("emits and receives agent:state_changed events", () => {
    const received: AgentStateChangedEvent[] = [];
    const listener = (event: AgentStateChangedEvent) => received.push(event);

    eventBus.on("agent:state_changed", listener);
    eventBus.emit("agent:state_changed", {
      agentId: "agent-1",
      previousState: "idle",
      newState: "working",
    });

    expect(received).toHaveLength(1);
    expect(received[0].newState).toBe("working");

    eventBus.off("agent:state_changed", listener);
  });

  it("supports once listeners", () => {
    let callCount = 0;
    eventBus.once("agent:output", () => { callCount++; });

    eventBus.emit("agent:output", {
      agentId: "agent-1",
      stream: "stdout",
      data: "first",
      sequence: 1,
    });
    eventBus.emit("agent:output", {
      agentId: "agent-1",
      stream: "stdout",
      data: "second",
      sequence: 2,
    });

    expect(callCount).toBe(1);
  });

  it("removes listeners with off", () => {
    let callCount = 0;
    const listener = () => { callCount++; };

    eventBus.on("agent:exit", listener);
    eventBus.emit("agent:exit", {
      agentId: "agent-1",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    });
    expect(callCount).toBe(1);

    eventBus.off("agent:exit", listener);
    eventBus.emit("agent:exit", {
      agentId: "agent-1",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    });
    expect(callCount).toBe(1);
  });
});
