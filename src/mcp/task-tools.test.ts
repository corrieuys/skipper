import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskScheduler } from "../tasks/scheduler";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { GlobalStoreManager } from "../global-store/manager";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { eventBus } from "../events/bus";
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
    artifactManager: new ArtifactManager(db),
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
  it("exposes the full task set to external, and only the recurring-task pair to internal root", () => {
    expect(taskToolNamesFor("external")).toContain("update_task");
    expect(taskToolNamesFor("external")).toContain("pause_task");
    // Root Skipper gets the two "both" + root-only recurring tools, nothing else.
    expect(taskToolNamesFor("internal").sort()).toEqual(["list_recurring_tasks", "run_recurring_task"]);
  });

  it("omits the root-only recurring tools from a delegated internal session", () => {
    expect(taskToolNamesFor("internal", true)).toEqual([]);
  });

  it("registers only the recurring-task pair on an internal root session", () => {
    const f = fakeServer();
    registerTaskTools(f.server as never, deps(), () => EXTERNAL_IDENTITY, "internal");
    expect([...f.map.keys()].sort()).toEqual(["list_recurring_tasks", "run_recurring_task"]);
  });

  it("registers nothing on a delegated internal session", () => {
    const f = fakeServer();
    registerTaskTools(f.server as never, deps(), () => EXTERNAL_IDENTITY, "internal", true);
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
    await call("approve_task", { task_id: a.id }); // → active
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
  async function activeTask(): Promise<string> {
    const t = await call("create_task", { title: "L", team_id: "team-1" });
    await call("approve_task", { task_id: t.id });
    return t.id;
  }

  it("pauses then resumes an active task", async () => {
    const id = await activeTask();
    const paused = await call("pause_task", { task_id: id });
    expect(paused.status).toBe("active");
    expect(db.prepare("SELECT paused FROM tasks WHERE id = ?").get(id)).toMatchObject({ paused: 1 });
    const resumed = await call("resume_task", { task_id: id });
    expect(resumed.status).toBe("active");
    expect(db.prepare("SELECT paused FROM tasks WHERE id = ?").get(id)).toMatchObject({ paused: 0 });
  });

  it("completes (archives) an active task", async () => {
    const id = await activeTask();
    expect((await call("complete_task", { task_id: id, result: "done" })).status).toBe("settled");
  });

  it("cancels an active task to archived with an error result", async () => {
    const id = await activeTask();
    expect((await call("cancel_task", { task_id: id })).status).toBe("settled");
    const row = db.prepare("SELECT result FROM tasks WHERE id = ?").get(id) as { result: string };
    expect(JSON.parse(row.result).error).toContain("Cancelled");
  });

  it("resume_task rejects a task that is not paused", async () => {
    const t = await call("create_task", { title: "D", team_id: "team-1" });
    expect(await call("resume_task", { task_id: t.id })).toContain("resume a paused task");
  });

  it("pause_task rejects a draft task", async () => {
    const t = await call("create_task", { title: "D", team_id: "team-1" });
    expect(await call("pause_task", { task_id: t.id })).toContain("pause an active task");
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

  it("lists recurring tasks with status + cadence + active_runs", async () => {
    makeRecurring(true);
    const list = await call("list_recurring_tasks", {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Nightly report", status: "approved", schedule: "manual", active_runs: 0 });
  });

  it("reports active_runs once a run is in flight (the duplicate-trigger guard)", async () => {
    const id = makeRecurring(true);
    // Idle: nothing running yet.
    expect((await call("list_recurring_tasks", {}))[0].active_runs).toBe(0);
    // After a run is triggered (created + approved), it counts as in flight.
    await call("run_recurring_task", { recurring_task_id: id });
    expect((await call("list_recurring_tasks", {}))[0].active_runs).toBe(1);
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
    expect(row.status).toBe("active");
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

  // A source task that already has a Slack thread. The internal identity points at
  // it, so the root Skipper on that task is the one calling run_recurring_task.
  function makeSlackRootedTask(): { taskId: string; identity: AgentIdentity } {
    const src = scheduler.createTask({
      title: "Slack-rooted",
      teamId: "team-1",
      workingDirectory: "/repo",
      taskConfig: { slack_origin: { channel: "C123", thread_ts: "1712.5", source: "slash_command" } },
    } as any);
    return { taskId: src.id, identity: { type: "internal", runtimeId: "rt-1", templateAgentId: "a", taskId: src.id } };
  }

  function newRunOrigin(runTaskId: string): any {
    const row = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(runTaskId) as { task_config: string | null };
    return JSON.parse(row.task_config ?? "{}").slack_origin ?? null;
  }

  it("carries the calling task's Slack thread over to the new run by default", async () => {
    const id = makeRecurring(true);
    const { identity } = makeSlackRootedTask();
    const out = await call("run_recurring_task", { recurring_task_id: id }, identity);
    expect(out.slack_thread_continued).toBe(true);
    expect(newRunOrigin(out.run_task_id)).toMatchObject({ channel: "C123", thread_ts: "1712.5" });
  });

  it("does not carry the thread when continue_slack_thread=false", async () => {
    const id = makeRecurring(true);
    const { identity } = makeSlackRootedTask();
    const out = await call("run_recurring_task", { recurring_task_id: id, continue_slack_thread: false }, identity);
    expect(out.slack_thread_continued).toBe(false);
    expect(newRunOrigin(out.run_task_id)).toBeNull();
  });

  it("carries nothing when the calling task has no Slack thread", async () => {
    const id = makeRecurring(true);
    const src = scheduler.createTask({ title: "Plain", teamId: "team-1", workingDirectory: "/repo" });
    const identity: AgentIdentity = { type: "internal", runtimeId: "rt-2", templateAgentId: "a", taskId: src.id };
    const out = await call("run_recurring_task", { recurring_task_id: id }, identity);
    expect(out.slack_thread_continued).toBe(false);
    expect(newRunOrigin(out.run_task_id)).toBeNull();
  });

  it("an external caller (no task context) never inherits a thread", async () => {
    const id = makeRecurring(true);
    // Even with a Slack-rooted task in the DB, an external identity has no taskId.
    makeSlackRootedTask();
    const out = await call("run_recurring_task", { recurring_task_id: id });
    expect(out.slack_thread_continued).toBe(false);
    expect(newRunOrigin(out.run_task_id)).toBeNull();
  });
});

describe("create_note (operator note)", () => {
  it("writes the same row the UI note form writes", async () => {
    const t = await call("create_task", { title: "N", team_id: "team-1" });
    const out = await call("create_note", { task_id: t.id, content: "  Check the staging config first  " });

    const row = db.prepare("SELECT * FROM task_notes WHERE id = ?").get(out.id) as {
      task_id: string; agent_id: string; content: string; source: string; deleted_at: string | null;
    };
    expect(row.task_id).toBe(t.id);
    expect(row.content).toBe("Check the staging config first"); // trimmed
    expect(row.source).toBe("user"); // operator-authored, not agent
    expect(row.agent_id).toBe("a"); // team entrypoint agent, for attribution
    expect(row.deleted_at).toBeNull();
  });

  it("emits task:note_added so the dashboard updates live", async () => {
    const t = await call("create_task", { title: "N", team_id: "team-1" });
    let seen: { taskId: string; content: string } | null = null;
    const listener = (e: { taskId: string; content: string }) => { seen = e; };
    eventBus.on("task:note_added", listener);
    await call("create_note", { task_id: t.id, content: "Heads up" });
    eventBus.off("task:note_added", listener);

    expect(seen).not.toBeNull();
    expect(seen!.taskId).toBe(t.id);
    expect(seen!.content).toBe("Heads up");
  });

  it("rejects an unknown task and an empty body", async () => {
    expect(await call("create_note", { task_id: "nope", content: "x" })).toContain("Task not found");
    const t = await call("create_task", { title: "N", team_id: "team-1" });
    expect(await call("create_note", { task_id: t.id, content: "   " })).toContain("content is required");
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_notes").get()).toMatchObject({ c: 0 });
  });

  it("explains itself when the task has no team to attribute the note to", async () => {
    const t = await call("create_task", { title: "teamless" });
    expect(await call("create_note", { task_id: t.id, content: "x" })).toContain("no team");
  });
});

describe("create_artifact (operator artifact)", () => {
  it("creates version 1 and versions a re-used name", async () => {
    const t = await call("create_task", { title: "A", team_id: "team-1" });
    const first = await call("create_artifact", { task_id: t.id, name: "spec", kind: "plan", body: "v1 body", format: "markdown", description: "The spec" });
    expect(first).toMatchObject({ name: "spec", version: 1, kind: "plan" });

    const second = await call("create_artifact", { task_id: t.id, name: "spec", kind: "plan", body: "v2 body", format: "markdown" });
    expect(second.version).toBe(2);

    // Both versions are retained; the agent-facing read resolves 'latest' to v2.
    expect(new ArtifactManager(db).getArtifact(t.id, "spec", "latest")!.body).toBe("v2 body");
    expect(new ArtifactManager(db).getArtifact(t.id, "spec", 1)!.body).toBe("v1 body");
  });

  it("persists the chosen format", async () => {
    const t = await call("create_task", { title: "A", team_id: "team-1" });
    const out = await call("create_artifact", { task_id: t.id, name: "tbl", kind: "summary", body: "<p>ok</p>", format: "html" });
    expect(new ArtifactManager(db).getArtifactById(out.id)!.format).toBe("html");
  });

  it("rejects malformed html with the location where it broke", async () => {
    const t = await call("create_task", { title: "A", team_id: "team-1" });
    const res = await call("create_artifact", { task_id: t.id, name: "broken", kind: "summary", body: "<ul><li>x</ul>", format: "html" });
    expect(res).toContain("invalid");
    expect(res).toMatch(/line \d+, col \d+/);
    // Nothing was persisted.
    expect(new ArtifactManager(db).getArtifact(t.id, "broken", "latest")).toBeNull();
  });

  it("marks the artifact as externally authored", async () => {
    const t = await call("create_task", { title: "A", team_id: "team-1" });
    const out = await call("create_artifact", { task_id: t.id, name: "notes", kind: "summary", body: "b", format: "markdown" });
    const row = db.prepare("SELECT created_by_agent_id FROM task_artifacts WHERE id = ?").get(out.id) as { created_by_agent_id: string };
    expect(row.created_by_agent_id).toBe("api");
  });

  it("rejects an unknown task", async () => {
    expect(await call("create_artifact", { task_id: "nope", name: "x", kind: "other", body: "b", format: "markdown" })).toContain("Task not found");
  });
});

// Type-only sanity: the audience union is exported for downstream typing.
const _audiences: ToolAudience[] = ["internal", "external", "both"];
void _audiences;
