import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import { fetchTaskForensics, fetchTokenAnalyticsByAgentTypeAndModel } from "./queries";

const TEST_DB = "test-queries.db";

let db: Database;

function insertAgent(id: string, name: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, type, model, config, capabilities)
     VALUES (?, ?, 'codex', 'default', '{}', '[]')`,
  ).run(id, name);
}

beforeEach(() => {
  db = new Database(TEST_DB);
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {
    // no-op
  }
});

describe("token analytics queries", () => {
  it("aggregates usage by configured agent across provider event formats", () => {
    insertAgent("agent-skip", "Skipper");
    insertAgent("agent-coder", "Coder");
    insertAgent("agent-lib", "Librarian");
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-1', 'Task 1', 'running')").run();

    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, 'task-1', ?, 'completed')",
    ).run("inst-skip-1", "agent-skip");
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, 'task-1', ?, 'completed')",
    ).run("inst-code-1", "agent-coder");
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, 'task-1', ?, 'completed')",
    ).run("inst-code-2", "agent-coder");

    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)",
    ).run(
      "inst-skip-1",
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 10,
        },
      }),
      1,
    );
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)",
    ).run(
      "inst-code-1",
      JSON.stringify({
        type: "turn.completed",
        usage: {
          prompt_tokens: 40,
          cached_input_tokens: 7,
          completion_tokens: 9,
        },
      }),
      2,
    );
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)",
    ).run(
      "inst-code-2",
      JSON.stringify({
        type: "step_finish",
        part: { tokens: { input: 30, output: 4 } },
      }),
      3,
    );

    const analytics = fetchTokenAnalyticsByAgentTypeAndModel(db);
    const groupsById = new Map(analytics.groups.map((group) => [group.agent_id, group]));

    const skipper = groupsById.get("agent-skip");
    expect(skipper).toBeDefined();
    expect(skipper?.input_tokens).toBe(100);
    expect(skipper?.cache_read_tokens).toBe(20);
    expect(skipper?.cache_write_tokens).toBe(5);
    expect(skipper?.output_tokens).toBe(10);
    expect(skipper?.total_tokens).toBe(135);
    expect(skipper?.instance_count).toBe(1);
    expect(skipper?.usage_event_count).toBe(1);

    const coder = groupsById.get("agent-coder");
    expect(coder).toBeDefined();
    expect(coder?.input_tokens).toBe(70);
    expect(coder?.cache_read_tokens).toBe(7);
    expect(coder?.cache_write_tokens).toBe(0);
    expect(coder?.output_tokens).toBe(13);
    expect(coder?.total_tokens).toBe(90);
    expect(coder?.instance_count).toBe(2);
    expect(coder?.usage_event_count).toBe(2);

    const librarian = groupsById.get("agent-lib");
    expect(librarian).toBeDefined();
    expect(librarian?.total_tokens).toBe(0);
    expect(librarian?.instance_count).toBe(0);
    expect(librarian?.usage_event_count).toBe(0);
  });

  it("forensics token usage includes step_finish and prompt/completion token fields", () => {
    insertAgent("agent-coder", "Coder");
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-2', 'Task 2', 'running')").run();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, 'task-2', ?, 'completed')",
    ).run("inst-forensics-1", "agent-coder");

    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)",
    ).run(
      "inst-forensics-1",
      JSON.stringify({
        type: "step_finish",
        part: { tokens: { input: 11, output: 3 } },
      }),
      1,
    );
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)",
    ).run(
      "inst-forensics-1",
      JSON.stringify({
        type: "turn.completed",
        usage: {
          prompt_tokens: 6,
          completion_tokens: 2,
          input_tokens_details: { cached_tokens: 4 },
        },
      }),
      2,
    );

    const forensics = fetchTaskForensics(db, "task-2");
    expect(forensics.tokenUsage.length).toBe(1);
    const usage = forensics.tokenUsage[0];
    expect(usage.input_tokens).toBe(17);
    expect(usage.cache_read_input_tokens).toBe(4);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(5);
  });
});
