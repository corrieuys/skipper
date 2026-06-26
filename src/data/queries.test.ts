import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import { fetchTaskForensics } from "./queries";

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

describe("forensics token usage queries", () => {
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
