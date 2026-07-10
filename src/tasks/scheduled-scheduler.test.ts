import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskScheduler } from "./scheduler";
import {
  ScheduledTaskScheduler,
  isValidScheduleMatrix,
  calculateNextRunFromMatrix,
  type ScheduleMatrix,
} from "./scheduled-scheduler";
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

describe("webhook trigger lifecycle", () => {
  it("enableWebhook generates a stable key; re-enable keeps it", () => {
    const id = makeApprovedScheduled();
    expect(scheduled.getScheduledTask(id)!.webhook_key).toBeNull();

    const enabled = scheduled.enableWebhook(id);
    expect(enabled.webhook_key).toBeTruthy();

    const again = scheduled.enableWebhook(id);
    expect(again.webhook_key).toBe(enabled.webhook_key!);
  });

  it("regenerateWebhookKey rotates the secret", () => {
    const id = makeApprovedScheduled();
    const first = scheduled.enableWebhook(id).webhook_key!;
    const second = scheduled.regenerateWebhookKey(id).webhook_key!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("disableWebhook clears the secret", () => {
    const id = makeApprovedScheduled();
    scheduled.enableWebhook(id);
    const disabled = scheduled.disableWebhook(id);
    expect(disabled.webhook_key).toBeNull();
  });

  it("throws for unknown ids", () => {
    expect(() => scheduled.enableWebhook("nope")).toThrow("not found");
    expect(() => scheduled.regenerateWebhookKey("nope")).toThrow("not found");
    expect(() => scheduled.disableWebhook("nope")).toThrow("not found");
  });
});

describe("webhook debounce", () => {
  function backdateWebhookEvent(id: string, minutesAgo: number): void {
    db.prepare(
      `UPDATE scheduled_tasks SET webhook_last_event_at = datetime('now', ?) WHERE id = ?`,
    ).run(`-${minutesAgo} minutes`, id);
  }

  it("defaults to 1 minute and validates the setter", () => {
    const id = makeApprovedScheduled();
    expect(scheduled.getScheduledTask(id)!.webhook_debounce_minutes).toBe(1);

    const set = scheduled.setWebhookDebounce(id, 15);
    expect(set.webhook_debounce_minutes).toBe(15);

    expect(() => scheduled.setWebhookDebounce(id, 0)).toThrow("at least 1");
    expect(() => scheduled.setWebhookDebounce(id, -5)).toThrow("at least 1");
    expect(() => scheduled.setWebhookDebounce(id, 1.5)).toThrow("at least 1");
    expect(() => scheduled.setWebhookDebounce("nope", 5)).toThrow("not found");
  });

  it("fires the first webhook and ignores an immediate second one", () => {
    const id = makeApprovedScheduled();

    const first = scheduled.runWebhookTask(id, taskScheduler, "payload one");
    expect(first.debounced).toBe(false);
    expect(scheduled.getScheduledTask(id)!.webhook_last_event_at).toBeTruthy();

    const second = scheduled.runWebhookTask(id, taskScheduler, "payload two");
    expect(second.debounced).toBe(true);
    // Only the first webhook materialized a run.
    const runs = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE source_scheduled_task_id = ?").get(id) as { c: number }).c;
    expect(runs).toBe(1);
  });

  it("an ignored webhook restamps the window (true debounce, not throttle)", () => {
    const id = makeApprovedScheduled();
    scheduled.runWebhookTask(id, taskScheduler);
    // Backdate 30 seconds: still inside the 1-minute window.
    db.prepare("UPDATE scheduled_tasks SET webhook_last_event_at = datetime('now', '-30 seconds') WHERE id = ?").run(id);

    const before = scheduled.getScheduledTask(id)!.webhook_last_event_at!;
    const ignored = scheduled.runWebhookTask(id, taskScheduler);
    expect(ignored.debounced).toBe(true);

    // The stamp moved forward to now even though the webhook was ignored.
    const after = scheduled.getScheduledTask(id)!.webhook_last_event_at!;
    expect(after > before).toBe(true);
  });

  it("fires again once the quiet window has passed", () => {
    const id = makeApprovedScheduled();
    scheduled.runWebhookTask(id, taskScheduler);
    backdateWebhookEvent(id, 2); // beyond the default 1-minute window

    const again = scheduled.runWebhookTask(id, taskScheduler);
    expect(again.debounced).toBe(false);
  });

  it("respects a configured longer window", () => {
    const id = makeApprovedScheduled();
    scheduled.setWebhookDebounce(id, 10);
    scheduled.runWebhookTask(id, taskScheduler);

    backdateWebhookEvent(id, 5); // inside the 10-minute window
    expect(scheduled.runWebhookTask(id, taskScheduler).debounced).toBe(true);

    backdateWebhookEvent(id, 11);
    expect(scheduled.runWebhookTask(id, taskScheduler).debounced).toBe(false);
  });

  it("manual runs neither stamp nor consume the webhook window", () => {
    const id = makeApprovedScheduled();
    scheduled.runTaskNow(id, taskScheduler);
    expect(scheduled.getScheduledTask(id)!.webhook_last_event_at).toBeNull();

    const fired = scheduled.runWebhookTask(id, taskScheduler);
    expect(fired.debounced).toBe(false);
  });
});

describe("global store instructions", () => {
  const contract = "Store the last processed timestamp under key 'report-window' and resume from it.";

  it("round-trips through create and get", () => {
    const teamId = createTeam("team-gsi");
    const st = scheduled.createScheduledTask({
      title: "Rolling report",
      teamId,
      workingDirectory: "/repo",
      globalStoreInstructions: `  ${contract}  `,
    });
    expect(st.global_store_instructions).toBe(contract);
  });

  it("update replaces and clears the instructions", () => {
    const teamId = createTeam("team-gsi-upd");
    const st = scheduled.createScheduledTask({
      title: "Rolling report",
      teamId,
      workingDirectory: "/repo",
      globalStoreInstructions: contract,
    });

    const replaced = scheduled.updateScheduledTask(st.id, {
      title: "Rolling report",
      globalStoreInstructions: "New contract",
    });
    expect(replaced.global_store_instructions).toBe("New contract");

    const cleared = scheduled.updateScheduledTask(st.id, {
      title: "Rolling report",
      globalStoreInstructions: "",
    });
    expect(cleared.global_store_instructions).toBeNull();
  });

  it("runTaskNow merges the instructions into the run's task_config, preserving other keys", () => {
    const teamId = createTeam("team-gsi-run");
    const st = scheduled.createScheduledTask({
      title: "Rolling report",
      teamId,
      workingDirectory: "/repo",
      globalStoreInstructions: contract,
      taskConfig: { phase_overrides: { Build: { review: false } } },
    });
    scheduled.approveScheduledTask(st.id);

    const task = scheduled.runTaskNow(st.id, taskScheduler);
    const row = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(task.id) as { task_config: string };
    const config = JSON.parse(row.task_config);
    expect(config.global_store_instructions).toBe(contract);
    expect(config.phase_overrides).toEqual({ Build: { review: false } });
  });

  it("runTaskNow leaves task_config untouched when no instructions are set", () => {
    const id = makeApprovedScheduled();
    const task = scheduled.runTaskNow(id, taskScheduler);
    const row = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(task.id) as { task_config: string };
    expect(JSON.parse(row.task_config).global_store_instructions).toBeUndefined();
  });
});

// Build a 7x24 zero matrix with the given (day, hour) cells enabled.
function matrixWith(cells: Array<[number, number]>): ScheduleMatrix {
  const m: ScheduleMatrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const [day, hour] of cells) m[day]![hour] = 1;
  return m;
}

// The scheduler stores next_run_at as a UTC "YYYY-MM-DD HH:MM:SS" string;
// parse it back to an instant so assertions hold in any test-machine timezone.
function toInstant(stored: string): number {
  return new Date(stored.replace(" ", "T") + "Z").getTime();
}

describe("isValidScheduleMatrix", () => {
  it("accepts a 7x24 grid of 0/1 with at least one enabled cell", () => {
    expect(isValidScheduleMatrix(matrixWith([[0, 9]]))).toBe(true);
  });

  it("rejects wrong shapes, wrong values, and empty grids", () => {
    expect(isValidScheduleMatrix(matrixWith([[0, 9]]).slice(0, 6))).toBe(false);
    expect(isValidScheduleMatrix(matrixWith([[0, 9]]).map(r => r.slice(0, 23)))).toBe(false);
    const badValue = matrixWith([[0, 9]]);
    badValue[1]![1] = 2;
    expect(isValidScheduleMatrix(badValue)).toBe(false);
    expect(isValidScheduleMatrix(matrixWith([]))).toBe(false);
    expect(isValidScheduleMatrix("not a matrix")).toBe(false);
    expect(isValidScheduleMatrix(null)).toBe(false);
  });
});

describe("calculateNextRunFromMatrix", () => {
  // Mon Jan 5 2026, local time.
  const monday1430 = new Date(2026, 0, 5, 14, 30);

  it("finds a later cell on the same day", () => {
    const ret = calculateNextRunFromMatrix(matrixWith([[0, 16]]), monday1430);
    expect(toInstant(ret!)).toBe(new Date(2026, 0, 5, 16, 0).getTime());
  });

  it("is strictly after `from`: an exact top-of-hour start skips that hour", () => {
    const ret = calculateNextRunFromMatrix(matrixWith([[0, 14]]), new Date(2026, 0, 5, 14, 0, 0));
    expect(toInstant(ret!)).toBe(new Date(2026, 0, 12, 14, 0).getTime());
  });

  it("wraps to next week when the only cell has passed", () => {
    const ret = calculateNextRunFromMatrix(matrixWith([[0, 13]]), monday1430);
    expect(toInstant(ret!)).toBe(new Date(2026, 0, 12, 13, 0).getTime());
  });

  it("returns the next top-of-hour for an all-enabled matrix", () => {
    const all = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 1));
    const ret = calculateNextRunFromMatrix(all, monday1430);
    expect(toInstant(ret!)).toBe(new Date(2026, 0, 5, 15, 0).getTime());
  });

  it("fires a cell one minute away", () => {
    const ret = calculateNextRunFromMatrix(matrixWith([[0, 16]]), new Date(2026, 0, 5, 15, 59));
    expect(toInstant(ret!)).toBe(new Date(2026, 0, 5, 16, 0).getTime());
  });

  it("maps matrix rows Monday-first: a Sunday cell resolves to a Sunday", () => {
    const ret = calculateNextRunFromMatrix(matrixWith([[6, 8]]), monday1430);
    const when = new Date(toInstant(ret!));
    expect(when.getDay()).toBe(0); // JS Sunday
    expect(when.getHours()).toBe(8);
    expect(toInstant(ret!)).toBe(new Date(2026, 0, 11, 8, 0).getTime());
  });

  it("returns null for an all-zero matrix", () => {
    expect(calculateNextRunFromMatrix(matrixWith([]), monday1430)).toBeNull();
  });
});

describe("weekly matrix lifecycle", () => {
  function makeMatrixScheduled(): string {
    const teamId = createTeam();
    const st = scheduled.createScheduledTask({
      title: "Weekend hourly",
      teamId,
      workingDirectory: "/repo",
      scheduleMatrix: matrixWith([[4, 18], [5, 3], [6, 9]]),
    });
    return st.id;
  }

  it("round-trips the matrix through create/get", () => {
    const id = makeMatrixScheduled();
    const task = scheduled.getScheduledTask(id)!;
    expect(task.schedule_matrix).toEqual(matrixWith([[4, 18], [5, 3], [6, 9]]));
    expect(task.schedule_unit).toBeNull();
    expect(task.schedule_amount).toBeNull();
  });

  it("approve sets a future next_run_at from the matrix", () => {
    const id = makeMatrixScheduled();
    const approved = scheduled.approveScheduledTask(id);
    expect(approved.next_run_at).toBeTruthy();
    expect(toInstant(approved.next_run_at!)).toBeGreaterThan(Date.now());
  });

  it("recordRun advances next_run_at strictly forward", () => {
    const id = makeMatrixScheduled();
    scheduled.approveScheduledTask(id);
    scheduled.recordRun(id);
    const after = scheduled.getScheduledTask(id)!;
    expect(after.next_run_at).toBeTruthy();
    expect(toInstant(after.next_run_at!)).toBeGreaterThan(Date.now());
    expect(after.last_run_at).toBeTruthy();
  });

  it("clearSchedule wipes the matrix and next_run_at", () => {
    const id = makeMatrixScheduled();
    scheduled.approveScheduledTask(id);
    const cleared = scheduled.clearSchedule(id);
    expect(cleared.schedule_matrix).toBeNull();
    expect(cleared.next_run_at).toBeNull();
    expect(cleared.status).toBe("approved");
  });

  it("rejects interval + matrix together on create", () => {
    const teamId = createTeam("team-xor");
    expect(() =>
      scheduled.createScheduledTask({
        title: "Both modes",
        teamId,
        workingDirectory: "/repo",
        scheduleUnit: "hours",
        scheduleAmount: 2,
        scheduleMatrix: matrixWith([[0, 9]]),
      }),
    ).toThrow("not both");
  });

  it("rejects interval + matrix together on update", () => {
    const id = makeMatrixScheduled();
    expect(() =>
      scheduled.updateScheduledTask(id, {
        title: "Weekend hourly",
        scheduleUnit: "hours",
        scheduleAmount: 2,
      }),
    ).toThrow("not both");
  });

  it("update switches interval to weekly and back, clearing the other mode", () => {
    const teamId = createTeam("team-switch");
    const st = scheduled.createScheduledTask({
      title: "Switcher",
      teamId,
      workingDirectory: "/repo",
      scheduleUnit: "hours",
      scheduleAmount: 6,
    });

    const weekly = scheduled.updateScheduledTask(st.id, {
      title: "Switcher",
      scheduleUnit: null,
      scheduleAmount: null,
      scheduleMatrix: matrixWith([[2, 12]]),
    });
    expect(weekly.schedule_matrix).toEqual(matrixWith([[2, 12]]));
    expect(weekly.schedule_unit).toBeNull();

    const interval = scheduled.updateScheduledTask(st.id, {
      title: "Switcher",
      scheduleUnit: "days",
      scheduleAmount: 1,
      scheduleMatrix: null,
    });
    expect(interval.schedule_matrix).toBeNull();
    expect(interval.schedule_unit).toBe("days");
    expect(interval.schedule_amount).toBe(1);
  });
});
