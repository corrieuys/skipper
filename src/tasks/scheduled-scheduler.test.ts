import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskScheduler } from "./scheduler";
import { ScheduledTaskScheduler } from "./scheduled-scheduler";
import { unlinkSync } from "fs";

const TEST_DB = "test-scheduled-scheduler.db";

let db: Database;
let taskScheduler: TaskScheduler;
let scheduled: ScheduledTaskScheduler;

function createTeam(id = "team-1"): string {
  db.prepare(
    "INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('default-agent', 'Default Agent', 'claude-code', 'default')",
  ).run();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, ?, 'default-agent')",
  ).run(id, "Test Team");
  db.prepare(
    "INSERT OR IGNORE INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, 'default-agent', 'lead', 0)",
  ).run(`ta-${id}`, id);
  return id;
}

function makeApprovedScheduled(): string {
  const teamId = createTeam();
  const st = scheduled.createScheduledTask({
    title: "Nightly sweep",
    description: "Sweep the repo",
    teamId,
    workingDirectory: "/repo",
  });
  scheduled.approveScheduledTask(st.id);
  return st.id;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  taskScheduler = new TaskScheduler(db);
  scheduled = new ScheduledTaskScheduler(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("runTaskNow run_input", () => {
  it("stores the provided run input on the materialized task", () => {
    const id = makeApprovedScheduled();
    const task = scheduled.runTaskNow(id, taskScheduler, "  Only touch the auth module  ");

    const row = db.prepare("SELECT run_input, source_scheduled_task_id FROM tasks WHERE id = ?").get(task.id) as {
      run_input: string | null;
      source_scheduled_task_id: string | null;
    };
    expect(row.run_input).toBe("Only touch the auth module"); // trimmed
    expect(row.source_scheduled_task_id).toBe(id);
  });

  it("leaves run_input NULL when no input is given", () => {
    const id = makeApprovedScheduled();
    const task = scheduled.runTaskNow(id, taskScheduler);

    const row = db.prepare("SELECT run_input FROM tasks WHERE id = ?").get(task.id) as { run_input: string | null };
    expect(row.run_input).toBeNull();
  });

  it("treats a whitespace-only input as no input", () => {
    const id = makeApprovedScheduled();
    const task = scheduled.runTaskNow(id, taskScheduler, "   ");

    const row = db.prepare("SELECT run_input FROM tasks WHERE id = ?").get(task.id) as { run_input: string | null };
    expect(row.run_input).toBeNull();
  });
});
