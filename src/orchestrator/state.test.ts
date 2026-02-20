import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import {
  transition,
  InvalidTransitionError,
  TaskStateMachine,
  TRANSITIONS,
} from "./state";
import type { TaskOrchStep } from "./state";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
});

describe("transition()", () => {
  it("allows valid transitions", () => {
    expect(transition("IDLE", "AGENT_RUNNING", "t1")).toBe("AGENT_RUNNING");
    expect(transition("IDLE", "RECOVERING", "t1")).toBe("RECOVERING");
    expect(transition("AGENT_RUNNING", "WAITING_DELEGATION", "t1")).toBe("WAITING_DELEGATION");
    expect(transition("AGENT_RUNNING", "IDLE", "t1")).toBe("IDLE");
    expect(transition("WAITING_DELEGATION", "AGENT_RUNNING", "t1")).toBe("AGENT_RUNNING");
    expect(transition("PAUSING", "PAUSED", "t1")).toBe("PAUSED");
    expect(transition("PAUSED", "RECOVERING", "t1")).toBe("RECOVERING");
    expect(transition("RECOVERING", "AGENT_RUNNING", "t1")).toBe("AGENT_RUNNING");
  });

  it("allows self-transitions", () => {
    expect(transition("AGENT_RUNNING", "AGENT_RUNNING", "t1")).toBe("AGENT_RUNNING");
    expect(transition("IDLE", "IDLE", "t1")).toBe("IDLE");
    expect(transition("PAUSED", "PAUSED", "t1")).toBe("PAUSED");
  });

  it("throws InvalidTransitionError for invalid transitions", () => {
    expect(() => transition("IDLE", "PAUSED", "t1")).toThrow(InvalidTransitionError);
    expect(() => transition("PAUSED", "AGENT_RUNNING", "t1")).toThrow(InvalidTransitionError);
    expect(() => transition("PAUSING", "IDLE", "t1")).toThrow(InvalidTransitionError);
    expect(() => transition("WAITING_DELEGATION", "PAUSED", "t1")).toThrow(InvalidTransitionError);
  });

  it("error includes from, to, and taskId", () => {
    try {
      transition("IDLE", "PAUSED", "task-123");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.from).toBe("IDLE");
      expect(e.to).toBe("PAUSED");
      expect(e.taskId).toBe("task-123");
      expect(e.message).toContain("IDLE");
      expect(e.message).toContain("PAUSED");
      expect(e.message).toContain("task-123");
    }
  });

  it("covers all states in the transition table", () => {
    const allStates: TaskOrchStep[] = [
      "IDLE", "AGENT_RUNNING", "WAITING_DELEGATION", "ADVANCING_PHASE",
      "REGRESSION", "WAITING_ESCALATION", "PAUSING", "PAUSED", "RECOVERING",
    ];
    for (const state of allStates) {
      expect(TRANSITIONS[state]).toBeDefined();
      expect(TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });
});

describe("TaskStateMachine", () => {
  function createTask(id: string, step?: TaskOrchStep): void {
    db.prepare("INSERT INTO agent_types (name, command) VALUES ('claude-code', 'claude') ON CONFLICT DO NOTHING").run();
    db.prepare("INSERT INTO agents (id, name, type) VALUES (?, ?, 'claude-code') ON CONFLICT DO NOTHING").run("a1", "Agent");
    db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run("team1", "Team", "a1");

    const orchState = step
      ? JSON.stringify({ step })
      : "{}";
    db.prepare(
      "INSERT INTO tasks (id, title, team_id, status, orchestration_state) VALUES (?, ?, 'team1', 'running', ?)",
    ).run(id, "Test Task", orchState);
  }

  it("returns IDLE for task with empty orchestration state", () => {
    createTask("t1");
    const sm = new TaskStateMachine("t1", db);
    expect(sm.getCurrentStep()).toBe("IDLE");
  });

  it("returns current step from orchestration state", () => {
    createTask("t1", "AGENT_RUNNING");
    const sm = new TaskStateMachine("t1", db);
    expect(sm.getCurrentStep()).toBe("AGENT_RUNNING");
  });

  it("returns IDLE for nonexistent task", () => {
    const sm = new TaskStateMachine("nonexistent", db);
    expect(sm.getCurrentStep()).toBe("IDLE");
  });

  it("validates and returns new step on valid transition", () => {
    createTask("t1", "IDLE");
    const sm = new TaskStateMachine("t1", db);
    expect(sm.transitionTo("AGENT_RUNNING")).toBe("AGENT_RUNNING");
  });

  it("throws on invalid transition", () => {
    createTask("t1", "IDLE");
    const sm = new TaskStateMachine("t1", db);
    expect(() => sm.transitionTo("PAUSED")).toThrow(InvalidTransitionError);
  });

  it("logs transitions to events table", () => {
    createTask("t1", "IDLE");
    const sm = new TaskStateMachine("t1", db);
    sm.transitionTo("AGENT_RUNNING");

    const events = db
      .prepare("SELECT * FROM events WHERE task_id = ? AND type = 'orchestration:transition'")
      .all("t1") as { type: string; payload: string; task_id: string }[];

    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.from).toBe("IDLE");
    expect(payload.to).toBe("AGENT_RUNNING");
  });

  it("does not log self-transitions", () => {
    createTask("t1", "AGENT_RUNNING");
    const sm = new TaskStateMachine("t1", db);
    sm.transitionTo("AGENT_RUNNING");

    const events = db
      .prepare("SELECT * FROM events WHERE task_id = ? AND type = 'orchestration:transition'")
      .all("t1") as { type: string }[];

    expect(events.length).toBe(0);
  });
});
