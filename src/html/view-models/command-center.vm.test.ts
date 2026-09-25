import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../../db/connection";
import { buildCommandCenterViewModel, buildTaskMission } from "./command-center.vm";

let db: Database;

function seed(): void {
  db.exec("INSERT INTO agents (id, name, type, model, config, capabilities) VALUES ('lead', 'Lead', 'codex', 'default', '{}', '[]')");
  db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES ('team-p', 'Phased', 'lead', ?)")
    .run(JSON.stringify([{ name: "Plan" }, { name: "Build" }]));
  db.exec("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES ('team-n', 'Flat', 'lead', '[]')");
  const task = db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, current_phase, result, task_config, source_scheduled_task_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  task.run("working", "Working", "team-p", "active", 1, null, JSON.stringify({ memory_enabled: true }), null, "2026-01-01 00:00:01", "2026-01-01 00:00:01");
  task.run("idle", "Idle", "team-p", "active", 0, null, "{}", null, "2026-01-01 00:00:02", "2026-01-01 00:00:02");
  task.run("done", "Done", "team-p", "settled", 1, JSON.stringify({ summary: "ok" }), "{}", null, "2026-01-01 00:00:03", "2026-01-01 00:00:03");
  task.run("flat", "Flat", "team-n", "active", 0, null, "{}", null, "2026-01-01 00:00:04", "2026-01-01 00:00:04");
  task.run("run-ok", "Run ok", "team-p", "settled", 1, JSON.stringify({ summary: "ok" }), "{}", "series-1", "2026-01-01 00:00:05", "2026-01-01 00:00:05");
  task.run("run-err", "Run err", "team-p", "settled", 0, JSON.stringify({ error: "boom" }), "{}", "series-1", "2026-01-01 00:00:06", "2026-01-01 00:00:06");
  db.exec("INSERT INTO agent_instances (id, task_id, template_agent_id, status, input_tokens) VALUES ('i-working', 'working', 'lead', 'running', 10)");
  db.exec("INSERT INTO agent_instances (id, task_id, template_agent_id, status, input_tokens) VALUES ('i-idle', 'idle', 'lead', 'completed', 20)");
  db.exec("INSERT INTO delegation_groups (id, task_id, parent_instance_id, expected_count) VALUES ('g1', 'working', 'i-working', 2)");
  db.exec("INSERT INTO realtime_pipeline_state (task_id, cadence_timer_active) VALUES ('idle', 1)");
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  seed();
});

afterEach(() => {
  db.close();
});

/** SQL text of every statement prepared while fn runs. */
function preparedDuring(fn: () => void): string[] {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

describe("buildCommandCenterViewModel", () => {
  it("carries only fields a renderer reads", () => {
    const vm = buildCommandCenterViewModel(db);
    expect(Object.keys(vm).sort()).toEqual([
      "allTasks", "daemonState", "daemonUptime", "escalationCount", "isIdle", "mission",
      "missionsByTask", "scheduledRuns", "scheduledTasks", "skipperConnectEnabled", "teams",
    ]);
    const working = vm.allTasks.find((t) => t.id === "working")!;
    expect(working).not.toHaveProperty("memory_enabled");
    expect(working).not.toHaveProperty("memory_mode");
    expect(working).not.toHaveProperty("tokens");
  });

  it("skips the per-task memory lookups and the agent-tree, token, delegation and realtime queries", () => {
    const sql = preparedDuring(() => buildCommandCenterViewModel(db)).join("\n---\n");
    expect(sql).not.toContain("SELECT task_config, source_scheduled_task_id FROM tasks WHERE id = ?"); // memory scope
    expect(sql).not.toContain("SUM(input_tokens)"); // token totals
    expect(sql).not.toMatch(/FROM agent_instances ai\s+LEFT JOIN agents/); // agent tree rows
    expect(sql).not.toContain("child_instance_id IN"); // delegation pills
    expect(sql).not.toContain("delegation_groups"); // delegation summary
    expect(sql).not.toContain("realtime_pipeline_state"); // realtime session flags
  });
});

describe("buildTaskMission", () => {
  it("matches the full view model's row and mission for every listed task", () => {
    const vm = buildCommandCenterViewModel(db);
    for (const summary of vm.allTasks) {
      const one = buildTaskMission(db, summary.id)!;
      expect(one).not.toBeNull();
      expect(one.task.display_status).toBe(summary.display_status);
      expect(one.mission).toEqual(vm.missionsByTask[summary.id] ?? null);
    }
    expect(buildTaskMission(db, "working")!.mission!.phases.map((p) => p.status)).toEqual(["completed", "current"]);
    expect(buildTaskMission(db, "flat")!.mission).toBeNull();
    expect(buildTaskMission(db, "run-err")).not.toBeNull(); // failed runs stay listed
  });

  it("is null for a task the list hides and for an unknown id", () => {
    const vm = buildCommandCenterViewModel(db);
    expect(vm.allTasks.some((t) => t.id === "run-ok")).toBe(false);
    expect(buildTaskMission(db, "run-ok")).toBeNull();
    expect(buildTaskMission(db, "nope")).toBeNull();
  });

  it("reads one task row, not the task list", () => {
    const sql = preparedDuring(() => buildTaskMission(db, "working"));
    const taskReads = sql.filter((s) => /FROM tasks t\b/.test(s));
    expect(taskReads.length).toBe(1);
    expect(taskReads[0]).toContain("WHERE t.id = ?");
    expect(sql.join("\n")).not.toContain("ORDER BY t.created_at DESC");
  });
});
