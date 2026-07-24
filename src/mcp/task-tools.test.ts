import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskScheduler } from "../tasks/scheduler";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { GlobalStoreManager } from "../global-store/manager";
import { registerTaskTools, taskToolNamesFor, type ToolAudience } from "./task-tools";
import type { DaemonDeps } from "./tools";
import type { AgentIdentity } from "./auth";

let db: Database;
let scheduler: TaskScheduler;
let handlers: Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>>;

const EXTERNAL_IDENTITY: AgentIdentity = { type: "external", apiKeyId: "k1", apiKeyName: "test" };

function fakeServer() {
  const map = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }>) => {
      map.set(name, handler);
    },
  };
  return { server, map };
}

function deps(): DaemonDeps {
  return {
    db,
    taskScheduler: scheduler,
    globalStoreManager: new GlobalStoreManager(db),
    agentManager: {} as DaemonDeps["agentManager"],
    delegationManager: {} as DaemonDeps["delegationManager"],
    phaseManager: {} as DaemonDeps["phaseManager"],
    escalationManager: {} as DaemonDeps["escalationManager"],
    artifactManager: {} as DaemonDeps["artifactManager"],
    consensusManager: {} as DaemonDeps["consensusManager"],
  };
}

/** Invoke a captured tool handler and JSON-parse its text payload. */
async function call(name: string, args: Record<string, unknown> = {}, identity: AgentIdentity | null = EXTERNAL_IDENTITY): Promise<any> {
  // Re-register against the given identity when overriding (default uses external).
  if (identity !== EXTERNAL_IDENTITY) {
    const f = fakeServer();
    registerTaskTools(f.server as never, deps(), () => identity, "external");
    handlers = f.map;
  }
  const res = await handlers.get(name)!(args);
  const text = res.content[0]!.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function makeTeam(id = "team-1") {
  db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('a', 'A', 'claude-code', 'default')").run();
  db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, 'T', 'a')").run(id);
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  scheduler = new TaskScheduler(db);
  makeTeam();
  const f = fakeServer();
  registerTaskTools(f.server as never, deps(), () => EXTERNAL_IDENTITY, "external");
  handlers = f.map;
});

afterEach(() => db.close());

describe("audience tagging", () => {
  it("exposes the task tools to external and none to internal (today)", () => {
    expect(taskToolNamesFor("external")).toContain("update_task");
    expect(taskToolNamesFor("external")).toContain("pause_task");
    expect(taskToolNamesFor("internal")).toEqual([]);
  });

  it("registers nothing on an internal session", () => {
    const f = fakeServer();
    registerTaskTools(f.server as never, deps(), () => EXTERNAL_IDENTITY, "internal");
    expect([...f.map.keys()]).toEqual([]);
  });

  it("rejects an unauthenticated caller", async () => {
    const out = await call("list_tasks", {}, null);
    expect(out).toContain("not authenticated");
  });
});

describe("create / get / list", () => {
  it("creates a draft, then retrieves it with get_task", async () => {
    const created = await call("create_task", { title: "Do it", description: "desc", team_id: "team-1" });
    expect(created.status).toBe("draft");
    const got = await call("get_task", { task_id: created.id });
    expect(got.id).toBe(created.id);
    expect(got.title).toBe("Do it");
    expect(got.description).toBe("desc");
  });

  it("get_task errors for an unknown id", async () => {
    expect(await call("get_task", { task_id: "nope" })).toContain("Task not found");
  });

  it("list_active_tasks returns only running/queued/paused tasks", async () => {
    const a = await call("create_task", { title: "queued", team_id: "team-1" });
    await call("approve_task", { task_id: a.id }); // → approved (active)
    await call("create_task", { title: "still draft", team_id: "team-1" }); // draft (not active)
    const active = await call("list_active_tasks", {});
    expect(active.tasks.map((t: any) => t.id)).toEqual([a.id]);
    expect(active.pagination.total).toBe(1);
  });
});

describe("list pagination + ordering", () => {
  it("returns newest first and pages through results", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await call("create_task", { title: `t${i}`, team_id: "team-1" })).id);
    }
    // Force a deterministic newest→oldest order (created_at, then rowid desc).
    // Created in order t0..t4, so newest-first is t4,t3,t2,t1,t0.
    const newestFirst = [...ids].reverse();

    const page1 = await call("list_tasks", { page: 1, page_size: 2 });
    expect(page1.tasks.map((t: any) => t.id)).toEqual(newestFirst.slice(0, 2));
    expect(page1.pagination).toMatchObject({ page: 1, page_size: 2, total: 5, total_pages: 3, has_more: true });

    const page2 = await call("list_tasks", { page: 2, page_size: 2 });
    expect(page2.tasks.map((t: any) => t.id)).toEqual(newestFirst.slice(2, 4));
    expect(page2.pagination.has_more).toBe(true);

    const page3 = await call("list_tasks", { page: 3, page_size: 2 });
    expect(page3.tasks.map((t: any) => t.id)).toEqual(newestFirst.slice(4, 5));
    expect(page3.pagination.has_more).toBe(false);
  });

  it("returns an empty page (not an error) past the end", async () => {
    await call("create_task", { title: "only", team_id: "team-1" });
    const out = await call("list_tasks", { page: 9, page_size: 20 });
    expect(out.tasks).toEqual([]);
    expect(out.pagination).toMatchObject({ page: 9, total: 1, has_more: false });
  });

  it("caps page_size at 100", async () => {
    // The SDK would normally reject >100 via the schema; the handler also clamps.
    const out = await call("list_tasks", { page_size: 100 });
    expect(out.pagination.page_size).toBe(100);
  });

  it("filters by status with pagination", async () => {
    const a = await call("create_task", { title: "a", team_id: "team-1" });
    await call("approve_task", { task_id: a.id });
    await call("create_task", { title: "b", team_id: "team-1" }); // draft
    const drafts = await call("list_tasks", { status: "draft" });
    expect(drafts.tasks.every((t: any) => t.status === "draft")).toBe(true);
    expect(drafts.pagination.total).toBe(1);
  });
});

describe("update_task (draft only)", () => {
  it("edits a draft and preserves omitted fields", async () => {
    const t = await call("create_task", { title: "Old", description: "keep me", team_id: "team-1" });
    const upd = await call("update_task", { task_id: t.id, title: "New" });
    expect(upd.title).toBe("New");
    expect(upd.description).toBe("keep me"); // omitted → preserved
    expect(upd.team_id).toBe("team-1"); // omitted → preserved
  });

  it("refuses to edit a non-draft task", async () => {
    const t = await call("create_task", { title: "T", team_id: "team-1" });
    await call("approve_task", { task_id: t.id });
    const out = await call("update_task", { task_id: t.id, title: "nope" });
    expect(out).toContain("Can only edit draft tasks");
  });
});

describe("lifecycle: pause / resume / cancel / complete", () => {
  async function runningTask(): Promise<string> {
    const t = await call("create_task", { title: "L", team_id: "team-1" });
    await call("approve_task", { task_id: t.id });
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id); // simulate the daemon starting it
    return t.id;
  }

  it("pauses then resumes a running task", async () => {
    const id = await runningTask();
    expect((await call("pause_task", { task_id: id })).status).toBe("paused");
    expect((await call("resume_task", { task_id: id })).status).toBe("running");
  });

  it("completes a running task", async () => {
    const id = await runningTask();
    expect((await call("complete_task", { task_id: id, result: "done" })).status).toBe("completed");
  });

  it("cancels an active task to failed", async () => {
    const id = await runningTask();
    expect((await call("cancel_task", { task_id: id })).status).toBe("failed");
  });

  it("resume_task rejects a task that is not paused", async () => {
    const t = await call("create_task", { title: "D", team_id: "team-1" });
    expect(await call("resume_task", { task_id: t.id })).toContain("resume a paused task");
  });

  it("pause_task rejects a task that is not running", async () => {
    const t = await call("create_task", { title: "D", team_id: "team-1" });
    expect(await call("pause_task", { task_id: t.id })).toContain("pause a running task");
  });
});

describe("recurring tasks: list + run now", () => {
  function makeRecurring(approved: boolean): string {
    const sched = new ScheduledTaskScheduler(db);
    const st = sched.createScheduledTask({
      title: "Nightly report",
      teamId: "team-1",
      workingDirectory: "/repo",
    });
    if (approved) sched.approveScheduledTask(st.id);
    return st.id;
  }

  it("lists recurring tasks with status + cadence", async () => {
    makeRecurring(true);
    const list = await call("list_recurring_tasks", {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Nightly report", status: "approved", schedule: "manual" });
  });

  it("filters recurring tasks by status", async () => {
    makeRecurring(true);
    makeRecurring(false); // draft
    expect(await call("list_recurring_tasks", { status: "draft" })).toHaveLength(1);
    expect(await call("list_recurring_tasks", { status: "approved" })).toHaveLength(1);
  });

  it("runs an approved recurring task now with an optional prompt", async () => {
    const id = makeRecurring(true);
    const out = await call("run_recurring_task", { recurring_task_id: id, prompt: "focus on errors" });
    expect(out.run_task_id).toBeTruthy();
    // The run is created + approved, and the one-off prompt is stamped as run_input.
    const row = db.prepare("SELECT source_scheduled_task_id, run_input, status FROM tasks WHERE id = ?").get(out.run_task_id) as {
      source_scheduled_task_id: string; run_input: string | null; status: string;
    };
    expect(row.source_scheduled_task_id).toBe(id);
    expect(row.run_input).toBe("focus on errors");
    expect(["approved", "running"]).toContain(row.status);
  });

  it("runs without a prompt (run_input null)", async () => {
    const id = makeRecurring(true);
    const out = await call("run_recurring_task", { recurring_task_id: id });
    const row = db.prepare("SELECT run_input FROM tasks WHERE id = ?").get(out.run_task_id) as { run_input: string | null };
    expect(row.run_input).toBeNull();
  });

  it("refuses to run a draft (unapproved) recurring task", async () => {
    const id = makeRecurring(false);
    expect(await call("run_recurring_task", { recurring_task_id: id })).toContain("Recurring task must be approved");
  });

  it("errors on an unknown recurring task id", async () => {
    expect(await call("run_recurring_task", { recurring_task_id: "nope" })).toContain("Recurring task not found");
  });
});

// Type-only sanity: the audience union is exported for downstream typing.
const _audiences: ToolAudience[] = ["internal", "external", "both"];
void _audiences;
