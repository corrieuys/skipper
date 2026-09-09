import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { RealtimeSessionManager } from "../orchestrator/realtime-session";
import { setStringSetting, SETTING_SKIPPER_CONNECT_KEY, SETTING_SKIPPER_CONNECT_URL } from "../config/app-settings";
import { handleResourceRequest, type ResourceDeps } from "./resources";
import { getPublicArtifactUrl, getWebhookTriggerUrl, gidFromConnectKey } from "./public-links";
import { TaskScheduler } from "../tasks/scheduler";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { registerVisibleLocalTeam, unregisterVisibleLocalTeam } from "../config/feature-flags";
import { createLocalTeam } from "../teams/local-teams";

// Unsigned JWT-shaped token; only the payload's gid claim matters client-side.
function fakeConnectKey(gid: string): string {
  const payload = Buffer.from(JSON.stringify({ gid, jti: "test", kind: "connect" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

let artifactManager: ArtifactManager;
let deps: ResourceDeps;

function seedArtifact(body = "artifact body"): { taskId: string; artifactId: string } {
  const db = getDb();
  db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team-1", "Test Team");
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES (?, ?, ?, 'active')").run("task-1", "Test Task", "team-1");
  const artifact = artifactManager.createArtifact({ taskId: "task-1", name: "doc", kind: "plan", body });
  return { taskId: "task-1", artifactId: artifact.id };
}

beforeEach(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  artifactManager = new ArtifactManager(db);
  // Only the artifacts resource is exercised here; the other managers are not touched.
  deps = { artifactManager } as unknown as ResourceDeps;
});

afterEach(() => {
  resetDb();
});

describe("connect teams list + task create", () => {
  it("teams/list returns light projections with phase counts", async () => {
    const db = getDb();
    const phases = JSON.stringify([
      { name: "Plan", prompt: "plan it" },
      { name: "Build", prompt: "build it" },
    ]);
    db.prepare("INSERT INTO teams (id, name, goal, phases) VALUES (?, ?, ?, ?)").run("team-a", "Alpha", "ship things", phases);
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run("team-b", "Beta", "[]");
    registerVisibleLocalTeam("team-a");
    registerVisibleLocalTeam("team-b");

    const result = await handleResourceRequest("teams", "list", {}, deps);
    expect(result.ok).toBe(true);
    const teams = (result as { ok: true; data: Array<Record<string, unknown>> }).data;
    // the schema seed may include default teams; ours must both be present
    expect(teams.find((t) => t.id === "team-b")).toBeTruthy();
    const alpha = teams.find((t) => t.id === "team-a")!;
    expect(alpha.name).toBe("Alpha");
    expect(alpha.goal).toBe("ship things");
    expect(alpha.phase_count).toBe(2);
    // never leak full team config through connect
    expect(alpha.phases).toBeUndefined();

    unregisterVisibleLocalTeam("team-a");
    unregisterVisibleLocalTeam("team-b");
  });

  it("teams/list is unified: includes conversational teams, still excludes hidden ones (same rule as the web picker)", async () => {
    const db = getDb();
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run("team-reg", "Regular", "[]");
    registerVisibleLocalTeam("team-reg");
    // A hidden team: present in the teams table but never registered visible.
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run("team-hidden", "Hidden", "[]");
    // A conversational (legacy 'realtime') team: assignable like any other team.
    const realtime = createLocalTeam(db, { name: "Live", phases: [], config: { mode: "realtime" } });

    const result = await handleResourceRequest("teams", "list", {}, deps);
    expect(result.ok).toBe(true);
    const ids = (result as { ok: true; data: Array<{ id: string }> }).data.map((t) => t.id);
    expect(ids).toContain("team-reg");
    expect(ids).not.toContain("team-hidden");
    expect(ids).toContain(realtime.id);

    unregisterVisibleLocalTeam("team-reg");
    unregisterVisibleLocalTeam(realtime.id);
  });

  it("teams rejects unknown actions", async () => {
    const result = await handleResourceRequest("teams", "update", {}, deps);
    expect(result.ok).toBe(false);
  });

  it("tasks/create persists title, description, team, and mode", async () => {
    const db = getDb();
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run("team-a", "Alpha", "[]");
    const taskScheduler = new TaskScheduler(db);
    const createDeps = { ...deps, taskScheduler } as ResourceDeps;

    const result = await handleResourceRequest("tasks", "create", {
      title: "From the app",
      description: "made remotely",
      teamId: "team-a",
      mode: "conversational",
    }, createDeps);
    expect(result.ok).toBe(true);
    const task = (result as { ok: true; data: { id: string } }).data;
    const stored = taskScheduler.getTask(task.id)!;
    expect(stored.title).toBe("From the app");
    expect(stored.description).toBe("made remotely");
    expect(stored.team_id).toBe("team-a");
    expect(stored.mode).toBe("conversational");
    expect(stored.status).toBe("draft");
  });

  it("tasks/create defaults to workflow mode", async () => {
    const taskScheduler = new TaskScheduler(getDb());
    const createDeps = { ...deps, taskScheduler } as ResourceDeps;
    const result = await handleResourceRequest("tasks", "create", { title: "Plain" }, createDeps);
    expect(result.ok).toBe(true);
    const created = (result as { ok: true; data: { id: string } }).data;
    expect(taskScheduler.getTask(created.id)!.mode).toBe("workflow");
  });

  it("tasks/create rejects taskType and names its replacement", async () => {
    const taskScheduler = new TaskScheduler(getDb());
    const createDeps = { ...deps, taskScheduler } as ResourceDeps;
    const result = await handleResourceRequest("tasks", "create", { title: "x", taskType: "real_time" }, createDeps);
    expect(result.ok).toBe(false);
    const error = (result as { ok: false; error: string }).error;
    expect(error).toContain("taskType was removed in protocol v3");
    expect(error).toContain("mode");
  });

  it("tasks/create rejects an invalid mode", async () => {
    const taskScheduler = new TaskScheduler(getDb());
    const createDeps = { ...deps, taskScheduler } as ResourceDeps;
    const result = await handleResourceRequest("tasks", "create", { title: "x", mode: "realtime" }, createDeps);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("Invalid mode");
  });
});

describe("connect teams management (protocol v3 vocabulary)", () => {
  function teamDeps(): ResourceDeps {
    return { ...deps } as ResourceDeps;
  }

  it("list-all projects mode as workflow/conversational, never the legacy names", async () => {
    const db = getDb();
    createLocalTeam(db, { name: "Legacy live", phases: [], config: { mode: "realtime" } });
    createLocalTeam(db, { name: "Legacy plain", phases: [], config: { mode: "regular" } });

    const result = await handleResourceRequest("teams", "list-all", {}, teamDeps());
    expect(result.ok).toBe(true);
    const teams = (result as { ok: true; data: Array<Record<string, unknown>> }).data;
    const live = teams.find((t) => t.name === "Legacy live")!;
    const plain = teams.find((t) => t.name === "Legacy plain")!;
    expect(live.mode).toBe("conversational");
    expect(plain.mode).toBe("workflow");
    for (const team of teams) {
      expect(team).not.toContainKey("unified_mode");
      expect(["workflow", "conversational"]).toContain(team.mode as string);
    }
  });

  it("create accepts the new mode vocabulary and rejects the legacy names", async () => {
    const created = await handleResourceRequest(
      "teams",
      "create",
      { name: "Chatty", mode: "conversational", phases: [], agents: [] },
      teamDeps(),
    );
    expect(created.ok).toBe(true);
    expect((created as { ok: true; data: { mode: string } }).data.mode).toBe("conversational");

    const legacy = await handleResourceRequest(
      "teams",
      "create",
      { name: "Old", mode: "realtime", phases: [], agents: [] },
      teamDeps(),
    );
    expect(legacy.ok).toBe(false);
    const error = (legacy as { ok: false; error: string }).error;
    expect(error).toContain("removed in protocol v3");
    expect(error).toContain("conversational");
  });

  it("update rejects the legacy 'regular' mode", async () => {
    const db = getDb();
    const team = createLocalTeam(db, { name: "Editable", phases: [], config: { mode: "workflow" } });
    const result = await handleResourceRequest(
      "teams",
      "update",
      { id: team.id, name: "Editable", mode: "regular", phases: [], agents: [] },
      teamDeps(),
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("workflow");
  });
});

describe("connect tasks read/list projections + v3 actions", () => {
  function taskDeps(extra: Partial<ResourceDeps> = {}): ResourceDeps {
    const db = getDb();
    return {
      ...deps,
      taskScheduler: new TaskScheduler(db),
      ...extra,
    } as ResourceDeps;
  }

  function seedTask(status: "draft" | "active" | "settled" = "active", result: string | null = null): string {
    const db = getDb();
    db.prepare("INSERT INTO teams (id, name, phases) VALUES ('team-p', 'Proj Team', ?)").run(
      JSON.stringify([{ name: "Build", prompt: "b" }]),
    );
    db.prepare(
      `INSERT INTO tasks (id, title, description, team_id, status, working_directory, mode, result)
       VALUES ('task-p', 'Projected', 'the description', 'team-p', ?, '/tmp/work', 'workflow', ?)`,
    ).run(status, result);
    return "task-p";
  }

  it("tasks/read returns the projected detail shape, not a raw row", async () => {
    const id = seedTask("active");
    const result = await handleResourceRequest("tasks", "read", { id }, taskDeps());
    expect(result.ok).toBe(true);
    const task = (result as { ok: true; data: Record<string, unknown> }).data;

    expect(task).toMatchObject({
      id,
      title: "Projected",
      status: "active",
      display_status: "queued",
      mode: "workflow",
      paused: false,
      needs_review: false,
      description: "the description",
      working_directory: "/tmp/work",
      phase_count: 1,
    });
    // Dropped v2 fields and heavy internals never cross the wire.
    expect(task).not.toContainKeys(["task_type", "iteration_count", "unified_status", "orchestration_state", "task_config"]);
    expect(task.agent_tiles).toBeDefined();
  });

  it("a settled task reads as completed or failed on display_status, never 'settled'", async () => {
    seedTask("settled", JSON.stringify({ error: "Cancelled by user" }));
    const failed = await handleResourceRequest("tasks", "read", { id: "task-p" }, taskDeps());
    const failedTask = (failed as { ok: true; data: Record<string, unknown> }).data;
    expect(failedTask.status).toBe("settled");
    expect(failedTask.display_status).toBe("failed");

    getDb().prepare("UPDATE tasks SET result = NULL WHERE id = 'task-p'").run();
    const done = await handleResourceRequest("tasks", "read", { id: "task-p" }, taskDeps());
    expect((done as { ok: true; data: Record<string, unknown> }).data.display_status).toBe("completed");
  });

  it("tasks/list returns list projections", async () => {
    seedTask("active");
    const result = await handleResourceRequest("tasks", "list", {}, taskDeps());
    expect(result.ok).toBe(true);
    const tasks = (result as { ok: true; data: Array<Record<string, unknown>> }).data;
    const task = tasks.find((t) => t.id === "task-p")!;
    expect(task).toMatchObject({ status: "active", display_status: "queued", mode: "workflow", paused: false });
    expect(task).not.toContainKeys(["task_type", "iteration_count", "unified_status", "description", "result"]);
  });

  it("tasks/input relays into inputTask and answers with the projected task", async () => {
    const id = seedTask("active");
    const calls: Array<{ taskId: string; text: string; source?: string }> = [];
    const inputDeps = taskDeps({
      inputTask: async (taskId, text, source) => {
        calls.push({ taskId, text, source });
        return { delivered: "wake" };
      },
    });

    const result = await handleResourceRequest("tasks", "input", { id, text: "keep going" }, inputDeps);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ taskId: id, text: "keep going", source: "connect" }]);
    const data = (result as { ok: true; data: { delivered: string; task: Record<string, unknown> } }).data;
    expect(data.delivered).toBe("wake");
    expect(data.task.status).toBe("active");

    const blank = await handleResourceRequest("tasks", "input", { id, text: "   " }, inputDeps);
    expect(blank.ok).toBe(false);
    expect((blank as { ok: false; error: string }).error).toContain("text is required");
  });

  it("tasks/settle finishes a task as completed", async () => {
    const id = seedTask("active");
    const result = await handleResourceRequest("tasks", "settle", { id }, taskDeps());
    expect(result.ok).toBe(true);
    const task = (result as { ok: true; data: Record<string, unknown> }).data;
    expect(task.status).toBe("settled");
    expect(task.display_status).toBe("completed");
  });

  it("tasks/cancel settles with an error result and kills the task runtimes", async () => {
    const id = seedTask("active");
    const killed: string[] = [];
    const result = await handleResourceRequest("tasks", "cancel", { id }, taskDeps({
      killTaskRuntimes: (taskId) => killed.push(taskId),
    }));
    expect(result.ok).toBe(true);
    const task = (result as { ok: true; data: Record<string, unknown> }).data;
    expect(task.status).toBe("settled");
    expect(task.display_status).toBe("failed");
    expect(killed).toEqual([id]);
    expect((task.result as { error: string }).error).toBe("Cancelled by user");
  });

  it("tasks/revive brings a settled task back to active and queues a wake", async () => {
    const id = seedTask("settled");
    const result = await handleResourceRequest("tasks", "revive", { id }, taskDeps());
    expect(result.ok).toBe(true);
    const task = (result as { ok: true; data: Record<string, unknown> }).data;
    expect(task.status).toBe("active");
    expect(task.display_status).toBe("queued");

    const again = await handleResourceRequest("tasks", "revive", { id }, taskDeps());
    expect(again.ok).toBe(false);
    expect((again as { ok: false; error: string }).error).toContain("Can only revive a settled task");
  });

  it("tasks/pause and tasks/resume-from-pause flip the paused flag", async () => {
    const id = seedTask("active");
    const paused = await handleResourceRequest("tasks", "pause", { id }, taskDeps());
    expect((paused as { ok: true; data: Record<string, unknown> }).data).toMatchObject({
      status: "active",
      paused: true,
      display_status: "paused",
    });

    const resumed = await handleResourceRequest("tasks", "resume-from-pause", { id }, taskDeps());
    expect((resumed as { ok: true; data: Record<string, unknown> }).data).toMatchObject({
      status: "active",
      paused: false,
    });

    const again = await handleResourceRequest("tasks", "resume-from-pause", { id }, taskDeps());
    expect(again.ok).toBe(false);
    expect((again as { ok: false; error: string }).error).toContain("not paused");
  });

  it("tasks/set-memory flips the flag, backfills on enable, and the projection carries it", async () => {
    const id = seedTask("active");
    const backfilled: string[] = [];
    const d = taskDeps({ taskMemory: { backfill: (taskId: string) => { backfilled.push(taskId); return 2; } } });

    const before = await handleResourceRequest("tasks", "read", { id }, d);
    expect(before.ok && (before.data as { memory_enabled: boolean }).memory_enabled).toBe(false);

    const on = await handleResourceRequest("tasks", "set-memory", { id, on: "true" }, d);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const onData = on.data as { task: { memory_enabled: boolean }; memory_enabled: boolean; backfilled: number };
    expect(onData.memory_enabled).toBe(true);
    expect(onData.backfilled).toBe(2);
    expect(onData.task.memory_enabled).toBe(true);
    expect(backfilled).toEqual([id]);

    const listed = await handleResourceRequest("tasks", "list", {}, d);
    expect(listed.ok && (listed.data as { memory_enabled: boolean }[])[0]!.memory_enabled).toBe(true);

    const off = await handleResourceRequest("tasks", "set-memory", { id, on: false }, d);
    expect(off.ok && (off.data as { memory_enabled: boolean; backfilled: number }).backfilled).toBe(0);
    expect(backfilled.length).toBe(1);
    const after = await handleResourceRequest("tasks", "read", { id }, d);
    expect(after.ok && (after.data as { memory_enabled: boolean }).memory_enabled).toBe(false);

    const missing = await handleResourceRequest("tasks", "set-memory", { on: true }, d);
    expect(missing.ok).toBe(false);
  });

  it("recurring/set-memory sets the series mode, backfills runs, and runs refuse tasks/set-memory", async () => {
    const db = getDb();
    db.prepare("INSERT INTO teams (id, name) VALUES ('team-r', 'Rec Team')").run();
    db.prepare("INSERT INTO scheduled_tasks (id, title, team_id, working_directory, status) VALUES ('ser-1', 'Nightly', 'team-r', '/tmp', 'approved')").run();
    db.prepare("INSERT INTO tasks (id, title, team_id, status, working_directory, source_scheduled_task_id) VALUES ('run-1', 'Nightly (1)', 'team-r', 'active', '/tmp', 'ser-1')").run();
    const backfilled: string[] = [];
    const cleared: string[] = [];
    const d = taskDeps({
      scheduledTaskScheduler: new ScheduledTaskScheduler(db),
      taskMemory: {
        backfill: () => 0,
        backfillSeries: (id: string) => { backfilled.push(id); return 4; },
        clearScope: (scope: string) => { cleared.push(scope); return 2; },
        prune: () => 0,
      },
    });

    const refused = await handleResourceRequest("tasks", "set-memory", { id: "run-1", on: true }, d);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("recurring/set-memory");

    const set = await handleResourceRequest("recurring", "set-memory", { id: "ser-1", mode: "shared", retentionDays: 30 }, d);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.data).toMatchObject({ id: "ser-1", memoryMode: "shared", memoryRetentionDays: 30, backfilled: 4 });
    expect(backfilled).toEqual(["ser-1"]);

    const listed = await handleResourceRequest("recurring", "list", {}, d);
    expect(listed.ok && (listed.data as { memoryMode: string; memorySummary: unknown }[])[0]).toMatchObject({ memoryMode: "shared" });
    expect(listed.ok && (listed.data as { memorySummary: { scope_id: string } }[])[0]!.memorySummary.scope_id).toBe("series:ser-1");

    // The run now reads shared + the detail summary says so.
    const run = await handleResourceRequest("tasks", "read", { id: "run-1" }, d);
    expect(run.ok && (run.data as { memory_enabled: boolean; memory_summary: { mode: string } }).memory_enabled).toBe(true);
    expect(run.ok && (run.data as { memory_summary: { mode: string } }).memory_summary.mode).toBe("shared");

    const bad = await handleResourceRequest("recurring", "set-memory", { id: "ser-1", mode: "sometimes" }, d);
    expect(bad.ok).toBe(false);

    const clr = await handleResourceRequest("recurring", "clear-memory", { id: "ser-1" }, d);
    expect(clr.ok && (clr.data as { cleared: number }).cleared).toBe(2);
    const runClr = await handleResourceRequest("tasks", "clear-memory", { id: "run-1" }, d);
    expect(runClr.ok).toBe(true);
    expect(cleared).toEqual(["series:ser-1", "series:ser-1"]);
  });

  it("tasks/create accepts memoryEnabled and the projection reflects it", async () => {
    const db = getDb();
    db.prepare("INSERT INTO teams (id, name) VALUES ('team-m', 'Mem Team')").run();
    const d = taskDeps();
    const created = await handleResourceRequest("tasks", "create", { title: "with memory", teamId: "team-m", memoryEnabled: "on" }, d);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = db.prepare("SELECT task_config FROM tasks WHERE title = 'with memory'").get() as { task_config: string };
    expect(JSON.parse(row.task_config).memory_enabled).toBe(true);
    const plain = await handleResourceRequest("tasks", "create", { title: "no memory", teamId: "team-m" }, d);
    expect(plain.ok).toBe(true);
    const row2 = db.prepare("SELECT task_config FROM tasks WHERE title = 'no memory'").get() as { task_config: string };
    expect(JSON.parse(row2.task_config).memory_enabled).toBeUndefined();
  });

  it("retired v2 actions error and name their replacement", async () => {
    const id = seedTask("active");
    const cases: Array<[string, string]> = [
      ["iterate", "tasks/input"],
      ["retry", "tasks/revive"],
      ["resume", "tasks/resume-from-pause"],
      ["reopen", "tasks/revive"],
      ["complete", "tasks/settle"],
    ];
    for (const [action, replacement] of cases) {
      const result = await handleResourceRequest("tasks", action, { id, text: "x" }, taskDeps());
      expect(result.ok).toBe(false);
      const error = (result as { ok: false; error: string }).error;
      expect(error).toContain("removed in protocol v3");
      expect(error).toContain(replacement);
    }
  });
});

describe("connect artifacts publish actions", () => {
  it("publish generates a public URL when connect is configured", async () => {
    const db = getDb();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid-123"));
    setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "wss://connect.example.com");
    const { artifactId } = seedArtifact();

    const result = await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { publishedAt: string; publicUrl: string } }).data;
    expect(data.publishedAt).toBeTruthy();
    expect(data.publicUrl).toStartWith(`https://connect.example.com/p/guid-123/${artifactId}?key=`);
  });

  it("publish resolves by taskId+name and returns null publicUrl without a connect key", async () => {
    const { taskId } = seedArtifact();

    const result = await handleResourceRequest("artifacts", "publish", { taskId, name: "doc" }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { publishedAt: string; publicUrl: string | null } }).data;
    expect(data.publishedAt).toBeTruthy();
    expect(data.publicUrl).toBeNull();
  });

  it("unpublish clears publishedAt", async () => {
    const { artifactId } = seedArtifact();
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);

    const result = await handleResourceRequest("artifacts", "unpublish", { id: artifactId }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { publishedAt: string | null; publicUrl: string | null } }).data;
    expect(data.publishedAt).toBeNull();
    expect(data.publicUrl).toBeNull();
  });

  it("read-published returns the body for a valid key", async () => {
    const { artifactId } = seedArtifact("<h1>hello</h1>");
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const key = artifactManager.getArtifactById(artifactId)!.publish_key!;

    const result = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { body: string; contentType: string } }).data;
    expect(data.body).toBe("<h1>hello</h1>");
    expect(data.contentType).toBe("text/html; charset=utf-8");
  });

  it("read-published labels non-HTML bodies as plain text", async () => {
    const { artifactId } = seedArtifact("# markdown heading");
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const key = artifactManager.getArtifactById(artifactId)!.publish_key!;

    const result = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key }, deps);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; data: { contentType: string } }).data.contentType).toBe("text/plain; charset=utf-8");
  });

  it("read-published returns one opaque error for wrong key, unknown id, and unpublished", async () => {
    const { artifactId } = seedArtifact();
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const key = artifactManager.getArtifactById(artifactId)!.publish_key!;

    const wrongKey = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key: "wrong" }, deps);
    const unknownId = await handleResourceRequest("artifacts", "read-published", { id: "nope", key }, deps);
    await handleResourceRequest("artifacts", "unpublish", { id: artifactId }, deps);
    const unpublished = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key }, deps);

    for (const result of [wrongKey, unknownId, unpublished]) {
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toBe("Not found or not published");
    }
  });

  it("read on an artifact includes publish state", async () => {
    const { artifactId } = seedArtifact();
    const before = await handleResourceRequest("artifacts", "read", { id: artifactId }, deps);
    expect((before as { ok: true; data: { publishedAt: string | null } }).data.publishedAt).toBeNull();

    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const after = await handleResourceRequest("artifacts", "read", { id: artifactId }, deps);
    const data = (after as { ok: true; data: { publishedAt: string; publicUrl: string | null } }).data;
    expect(data.publishedAt).toBeTruthy();
  });
});

describe("getPublicArtifactUrl", () => {
  it("encodes the key and converts ws scheme to http", () => {
    const db = getDb();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid 1"));
    setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "ws://localhost:8080/");

    const url = getPublicArtifactUrl(db, { id: "art-1", publish_key: "k/1" });
    expect(url).toBe("http://localhost:8080/p/guid%201/art-1?key=k%2F1");
  });

  it("returns null without a connect key or without a publish key", () => {
    const db = getDb();
    expect(getPublicArtifactUrl(db, { id: "art-1", publish_key: "k" })).toBeNull();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid-123"));
    expect(getPublicArtifactUrl(db, { id: "art-1", publish_key: null })).toBeNull();
  });
});

describe("gidFromConnectKey", () => {
  it("reads the gid claim from a JWT-shaped key", () => {
    expect(gidFromConnectKey(fakeConnectKey("abc-123"))).toBe("abc-123");
  });

  it("returns null for malformed keys", () => {
    expect(gidFromConnectKey("")).toBeNull();
    expect(gidFromConnectKey("not-a-jwt")).toBeNull();
    expect(gidFromConnectKey("a.%%%.c")).toBeNull();
    const noGid = `x.${Buffer.from(JSON.stringify({ kind: "connect" })).toString("base64url")}.y`;
    expect(gidFromConnectKey(noGid)).toBeNull();
  });
});

describe("state snapshot", () => {
  it("returns projected tasks, open escalations, reviews, and counts", async () => {
    const db = getDb();
    db.prepare("INSERT INTO teams (id, name, phases) VALUES ('team-s', 'Snap Team', ?)").run(
      JSON.stringify([{ name: "P1", prompt: "a" }, { name: "P2", prompt: "b" }, { name: "P3", prompt: "c" }]),
    );
    db.prepare(
      "INSERT INTO tasks (id, title, team_id, status, needs_review, current_phase) VALUES ('t-1', 'Running', 'team-s', 'active', 1, 1)",
    ).run();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t-2', 'Draft', 'draft')").run();
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('agent-s', 'Snap Agent', 'claude-code')").run();
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question, status) VALUES ('e-open', 'agent-s', 't-1', 'question', 'help?', 'open')",
    ).run();
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question, status, response) VALUES ('e-done', 'agent-s', 't-1', 'question', 'done?', 'resolved', 'yes')",
    ).run();

    const result = await handleResourceRequest("state", "snapshot", {}, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: Record<string, unknown> }).data;

    expect(data.protocolVersion).toBe(3);
    const tasks = data.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    const running = tasks.find((t) => t.id === "t-1")!;
    expect(running).toMatchObject({
      title: "Running",
      status: "active",
      // An open escalation outranks the review gate in deriveDisplayStatus.
      display_status: "blocked",
      mode: "workflow",
      paused: false,
      team_name: "Snap Team",
      current_phase: 1,
      phase_count: 3,
      needs_review: true,
    });
    expect(running).not.toContainKeys([
      "result",
      "orchestration_state",
      "description",
      "task_config",
      "task_type",
      "iteration_count",
      "unified_status",
    ]);
    expect(tasks.find((t) => t.id === "t-2")).toMatchObject({ phase_count: null, needs_review: false });

    const escalations = data.escalations as Record<string, unknown>[];
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ id: "e-open", taskId: "t-1", agentName: "Snap Agent", status: "open" });

    const reviews = data.reviews as Record<string, unknown>[];
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.id).toBe("t-1");

    expect(data.counts).toEqual({ openEscalations: 1, pendingReviews: 1 });
  });

  it("rejects unknown state actions", async () => {
    const result = await handleResourceRequest("state", "list", {}, deps);
    expect(result).toEqual({ ok: false, error: "Unknown state action: list" });
  });
});

describe("webhooks trigger", () => {
  function seedApprovedScheduled(): { id: string; key: string } {
    const db = getDb();
    db.prepare("INSERT INTO agents (id, name, type, model) VALUES ('wh-agent', 'WH Agent', 'claude-code', 'default')").run();
    db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES ('wh-team', 'WH Team', 'wh-agent')").run();
    const scheduledTaskScheduler = new ScheduledTaskScheduler(db);
    const st = scheduledTaskScheduler.createScheduledTask({
      title: "Nightly audit",
      teamId: "wh-team",
      workingDirectory: "/tmp",
    });
    scheduledTaskScheduler.approveScheduledTask(st.id);
    const enabled = scheduledTaskScheduler.enableWebhook(st.id);
    return { id: st.id, key: enabled.webhook_key! };
  }

  function webhookDeps(): ResourceDeps {
    const db = getDb();
    return {
      taskScheduler: new TaskScheduler(db),
      scheduledTaskScheduler: new ScheduledTaskScheduler(db),
    } as unknown as ResourceDeps;
  }

  it("fires a run and injects the payload into the run input", async () => {
    const { id, key } = seedApprovedScheduled();
    const result = await handleResourceRequest(
      "webhooks",
      "trigger",
      { id, key, payload: { ref: "refs/heads/main", pusher: "corrie" } },
      webhookDeps(),
    );
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { triggered: boolean; taskId: string } }).data;
    expect(data.triggered).toBe(true);

    const db = getDb();
    const row = db
      .prepare("SELECT status, run_input, source_scheduled_task_id FROM tasks WHERE id = ?")
      .get(data.taskId) as { status: string; run_input: string | null; source_scheduled_task_id: string };
    expect(row.status).toBe("active");
    expect(row.source_scheduled_task_id).toBe(id);
    expect(row.run_input).toContain("Webhook payload:");
    expect(row.run_input).toContain('"pusher":"corrie"');
  });

  it("fires without a payload (empty POST)", async () => {
    const { id, key } = seedApprovedScheduled();
    const result = await handleResourceRequest("webhooks", "trigger", { id, key }, webhookDeps());
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { taskId: string } }).data;
    const row = getDb().prepare("SELECT run_input FROM tasks WHERE id = ?").get(data.taskId) as { run_input: string | null };
    expect(row.run_input).toBeNull();
  });

  it("returns one opaque error for wrong key, unknown id, and disabled webhook", async () => {
    const { id, key } = seedApprovedScheduled();
    const deps = webhookDeps();

    const wrongKey = await handleResourceRequest("webhooks", "trigger", { id, key: "wrong" }, deps);
    expect(wrongKey).toEqual({ ok: false, error: "Not found" });

    const unknownId = await handleResourceRequest("webhooks", "trigger", { id: "ghost", key }, deps);
    expect(unknownId).toEqual({ ok: false, error: "Not found" });

    const missingKey = await handleResourceRequest("webhooks", "trigger", { id }, deps);
    expect(missingKey).toEqual({ ok: false, error: "Not found" });

    new ScheduledTaskScheduler(getDb()).disableWebhook(id);
    const disabled = await handleResourceRequest("webhooks", "trigger", { id, key }, deps);
    expect(disabled).toEqual({ ok: false, error: "Not found" });
  });

  it("surfaces the real error to a valid key holder when the task is not approved", async () => {
    const { id, key } = seedApprovedScheduled();
    const sts = new ScheduledTaskScheduler(getDb());
    sts.unapproveScheduledTask(id);

    const result = await handleResourceRequest("webhooks", "trigger", { id, key }, webhookDeps());
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("approved");
  });

  it("debounces a second trigger inside the window and allows it after quiet", async () => {
    const { id, key } = seedApprovedScheduled();
    const deps = webhookDeps();

    const first = await handleResourceRequest("webhooks", "trigger", { id, key }, deps);
    expect(first.ok).toBe(true);

    const second = await handleResourceRequest("webhooks", "trigger", { id, key }, deps);
    expect(second.ok).toBe(false);
    expect((second as { ok: false; error: string }).error).toContain("Debounced");

    // Backdate the stamp past the default 1-minute window; the trigger fires again.
    getDb()
      .prepare("UPDATE scheduled_tasks SET webhook_last_event_at = datetime('now', '-2 minutes') WHERE id = ?")
      .run(id);
    const third = await handleResourceRequest("webhooks", "trigger", { id, key }, deps);
    expect(third.ok).toBe(true);
  });
});

describe("connect realtime input", () => {
  function realtimeDeps(): { deps: ResourceDeps; manager: RealtimeSessionManager } {
    const db = getDb();
    const manager = new RealtimeSessionManager(db, artifactManager, null);
    return {
      deps: { ...deps, taskScheduler: new TaskScheduler(db), realtimeSessionManager: manager } as ResourceDeps,
      manager,
    };
  }

  function seedActiveTask(): string {
    getDb().prepare("INSERT INTO tasks (id, title, status) VALUES ('rt-1', 'Live', 'active')").run();
    return "rt-1";
  }

  it("accepts a text ingest with no clientId and lands a timeline entry", async () => {
    const taskId = seedActiveTask();
    const { deps: rtDeps, manager } = realtimeDeps();

    const result = await handleResourceRequest(
      "realtime",
      "ingest",
      { taskId, data: "typed from the phone", format: "text" },
      rtDeps,
    );
    expect(result).toEqual({ ok: true, data: { accepted: true } });

    const rows = getDb()
      .prepare("SELECT source_type, content_body FROM task_input_streams WHERE task_id = ?")
      .all(taskId) as Array<{ source_type: string; content_body: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_type: "text", content_body: "typed from the phone" });

    manager.dispose?.();
  });

  it("still requires clientId for audio ingest, acquire and release", async () => {
    const taskId = seedActiveTask();
    const { deps: rtDeps, manager } = realtimeDeps();

    const audio = await handleResourceRequest("realtime", "ingest", { taskId, data: "AAAA", format: "webm" }, rtDeps);
    expect(audio).toEqual({ ok: false, error: "clientId is required" });

    const acquire = await handleResourceRequest("realtime", "acquire", { taskId }, rtDeps);
    expect(acquire).toEqual({ ok: false, error: "clientId is required" });

    const release = await handleResourceRequest("realtime", "release", { taskId }, rtDeps);
    expect(release).toEqual({ ok: false, error: "clientId is required" });

    manager.dispose?.();
  });
});

describe("connect timeline list", () => {
  function seedEntry(id: string, taskId: string, entryType: string, content: string, fed: number, createdAt: string): void {
    getDb()
      .prepare(
        `INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, entryType, content, fed, createdAt);
  }

  function seedTask(): string {
    getDb().prepare("INSERT INTO tasks (id, title, status) VALUES ('tl-1', 'Live', 'active')").run();
    return "tl-1";
  }

  it("returns projected entries oldest first with the pending flag", async () => {
    const taskId = seedTask();
    seedEntry("e-2", taskId, "summary", "audio digest", 0, "2026-01-01 10:00:02");
    seedEntry("e-1", taskId, "text", "typed input", 1, "2026-01-01 10:00:01");
    seedEntry("e-3", taskId, "error", "transcription failed", 1, "2026-01-01 10:00:03");

    const result = await handleResourceRequest("timeline", "list", { taskId }, deps);
    expect(result.ok).toBe(true);
    const entries = (result as { ok: true; data: Array<Record<string, unknown>> }).data;
    expect(entries.map((e) => e.id)).toEqual(["e-1", "e-2", "e-3"]);
    expect(entries[0]).toEqual({
      id: "e-1",
      taskId,
      entryType: "text",
      content: "typed input",
      fedToSkipper: true,
      createdAt: "2026-01-01 10:00:01",
    });
    // an undelivered entry is flagged so clients can tag it as queued
    expect(entries[1]!.fedToSkipper).toBe(false);
    expect(entries[1]!.entryType).toBe("summary");
    expect(entries[2]!.entryType).toBe("error");
  });

  it("carries source + authorName on the artifact ref of image/file entries", async () => {
    const taskId = seedTask();
    const db = getDb();
    db.prepare("INSERT INTO agents (id, name, type, model) VALUES ('worker-1', 'Worker One', 'claude-code', 'default')").run();
    const insertArtifact = db.prepare(
      `INSERT INTO task_artifacts (id, task_id, name, version, kind, description, body, format, created_by_agent_id,
         storage, mime, bytes, sha256, width, height, source)
       VALUES (?, ?, ?, 1, 'upload', NULL, '', NULL, NULL, 'file', 'image/png', 10, 'abc', 4, 4, ?)`,
    );
    insertArtifact.run("art-op", taskId, "op.png", "operator");
    insertArtifact.run("art-ag", taskId, "ag.png", "worker-1");
    db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper, artifact_id, created_at)
       VALUES ('e-op', ?, 'image', 'op.png', 0, 'art-op', '2026-01-01 10:00:01'),
              ('e-ag', ?, 'image', 'ag.png', 1, 'art-ag', '2026-01-01 10:00:02')`,
    ).run(taskId, taskId);

    const result = await handleResourceRequest("timeline", "list", { taskId }, deps);
    const entries = (result as { ok: true; data: Array<{ id: string; artifact?: Record<string, unknown> }> }).data;
    expect(entries.map((e) => e.id)).toEqual(["e-op", "e-ag"]);
    expect(entries[0]!.artifact).toMatchObject({ id: "art-op", source: "operator", authorName: null });
    expect(entries[1]!.artifact).toMatchObject({ id: "art-ag", source: "worker-1", authorName: "Worker One" });
  });

  it("caps with limit, keeping the most recent entries in oldest-first order", async () => {
    const taskId = seedTask();
    seedEntry("e-1", taskId, "text", "one", 1, "2026-01-01 10:00:01");
    seedEntry("e-2", taskId, "text", "two", 1, "2026-01-01 10:00:02");
    seedEntry("e-3", taskId, "text", "three", 1, "2026-01-01 10:00:03");

    const result = await handleResourceRequest("timeline", "list", { taskId, limit: 2 }, deps);
    const entries = (result as { ok: true; data: Array<Record<string, unknown>> }).data;
    expect(entries.map((e) => e.id)).toEqual(["e-2", "e-3"]);
  });

  it("returns an empty list for an unknown task and requires taskId", async () => {
    const unknown = await handleResourceRequest("timeline", "list", { taskId: "ghost" }, deps);
    expect(unknown).toEqual({ ok: true, data: [] });

    const missing = await handleResourceRequest("timeline", "list", {}, deps);
    expect(missing).toEqual({ ok: false, error: "taskId is required" });

    const badAction = await handleResourceRequest("timeline", "read", { taskId: "tl-1" }, deps);
    expect(badAction).toEqual({ ok: false, error: "Unknown timeline action: read" });
  });
});

describe("getWebhookTriggerUrl", () => {
  it("builds the /wh URL from connect settings and the task secret", () => {
    const db = getDb();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid-9"));
    setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "wss://connect.example.com");

    const url = getWebhookTriggerUrl(db, { id: "sched-1", webhook_key: "sekret/1" });
    expect(url).toBe("https://connect.example.com/wh/guid-9/sched-1?key=sekret%2F1");
  });

  it("returns null when disabled or connect is unconfigured", () => {
    const db = getDb();
    expect(getWebhookTriggerUrl(db, { id: "sched-1", webhook_key: "k" })).toBeNull();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid-9"));
    setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "wss://connect.example.com");
    expect(getWebhookTriggerUrl(db, { id: "sched-1", webhook_key: null })).toBeNull();
  });
});

describe("connect paging cursors", () => {
  it("timeline/list pages older entries with `before`", async () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('pg-1', 'Paged', 'active')").run();
    const ins = db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper, created_at) VALUES (?, 'pg-1', 'text', ?, 1, ?)`,
    );
    ins.run("e-1", "one", "2026-01-01 10:00:01");
    ins.run("e-2", "two", "2026-01-01 10:00:02");
    ins.run("e-3", "three", "2026-01-01 10:00:03");
    const result = await handleResourceRequest("timeline", "list", { taskId: "pg-1", before: "2026-01-01 10:00:03", limit: 1 }, deps);
    const entries = (result as { ok: true; data: Array<Record<string, unknown>> }).data;
    expect(entries.map((e) => e.id)).toEqual(["e-2"]);
  });

  it("messages/list honours `limit` and pages older messages with `before`", async () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('pg-2', 'Paged', 'active')").run();
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('ag-pg', 'Msg Agent', 'claude-code')").run();
    const ins = db.prepare(
      `INSERT INTO task_messages (id, task_id, agent_id, content, created_at) VALUES (?, 'pg-2', 'ag-pg', ?, ?)`,
    );
    ins.run("m-1", "first", "2026-01-01 10:00:01.000");
    ins.run("m-2", "second", "2026-01-01 10:00:02.000");
    ins.run("m-3", "third", "2026-01-01 10:00:03.000");
    const newest = await handleResourceRequest("messages", "list", { taskId: "pg-2", limit: 1 }, deps);
    expect((newest as { ok: true; data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(["m-3"]);
    const older = await handleResourceRequest("messages", "list", { taskId: "pg-2", before: "2026-01-01 10:00:03.000" }, deps);
    expect((older as { ok: true; data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(["m-2", "m-1"]);
  });

  it("outputs/list pages older rows with `beforeId`", async () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('pg-3', 'Paged', 'active')").run();
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('ag-out', 'Out Agent', 'claude-code')").run();
    db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('in-out', 'pg-3', 'ag-out', 'running')").run();
    const ins = db.prepare("INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES ('in-out', 'stdout', ?, ?)");
    const ids = [1, 2, 3].map((i) => Number(ins.run(`line ${i}`, i).lastInsertRowid));
    const newest = await handleResourceRequest("outputs", "list", { taskId: "pg-3", limit: 2 }, deps);
    const rows = (newest as { ok: true; data: Array<{ id: number; content: string; agentName: string | null }> }).data;
    expect(rows.map((r) => r.content)).toEqual(["line 3", "line 2"]);
    expect(rows[0]!.id).toBe(ids[2]);
    expect(rows[0]!.agentName).toBe("Out Agent");
    const older = await handleResourceRequest("outputs", "list", { taskId: "pg-3", beforeId: ids[1] }, deps);
    expect((older as { ok: true; data: Array<{ content: string }> }).data.map((r) => r.content)).toEqual(["line 1"]);
  });
});

describe("connect file artifacts (upload-* / read-bytes)", () => {
  const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const { pngBytes } = require("../orchestrator/image-fixtures") as typeof import("../orchestrator/image-fixtures");

  let root: string;
  let fileDeps: ResourceDeps;
  let fileArtifacts: ArtifactManager;
  let sessions: RealtimeSessionManager;
  let wakes: string[];

  function seedActiveTask(): string {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES ('team-f', 'Files')").run();
    db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-f', 'File task', 'team-f', 'active')").run();
    return "task-f";
  }

  beforeEach(() => {
    const db = getDb();
    root = mkdtempSync(join(tmpdir(), "skipper-connect-files-"));
    fileArtifacts = new ArtifactManager(db, { artifactsRoot: root });
    wakes = [];
    const scheduler = new TaskScheduler(db);
    (scheduler as unknown as { requestWake: (id: string) => void }).requestWake = (id: string) => { wakes.push(id); };
    sessions = new RealtimeSessionManager(db, fileArtifacts, null, scheduler);
    fileDeps = { artifactManager: fileArtifacts, taskScheduler: scheduler, realtimeSessionManager: sessions } as unknown as ResourceDeps;
  });

  afterEach(() => {
    sessions.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("upload-begin/chunk/commit creates the artifact, lands a timeline entry, wakes the task and returns both projections", async () => {
    const taskId = seedActiveTask();
    const bytes = pngBytes(1024, 768, 700 * 1024);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const begin = await handleResourceRequest("artifacts", "upload-begin", {
      taskId, name: "phone photo.png", mime: "image/png", bytes: bytes.byteLength, sha256, description: "from the phone", clientId: "ios-1",
    }, fileDeps);
    expect(begin.ok).toBe(true);
    const { uploadId, chunkBytes } = (begin as { ok: true; data: { uploadId: string; chunkBytes: number } }).data;
    expect(chunkBytes).toBe(256 * 1024);

    let index = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const chunk = await handleResourceRequest("artifacts", "upload-chunk", {
        uploadId, index, data: Buffer.from(bytes.subarray(offset, offset + chunkBytes)).toString("base64"),
      }, fileDeps);
      expect(chunk.ok).toBe(true);
      expect((chunk as { ok: true; data: { received: number } }).data.received).toBe(Math.min(offset + chunkBytes, bytes.byteLength));
      index++;
    }

    const commit = await handleResourceRequest("artifacts", "upload-commit", { uploadId }, fileDeps);
    expect(commit.ok).toBe(true);
    const data = (commit as { ok: true; data: { artifact: Record<string, unknown>; entry: Record<string, unknown>; delivered: string } }).data;
    expect(data.artifact.storage).toBe("file");
    expect(data.artifact.kind).toBe("upload");
    expect(data.artifact.name).toBe("phone_photo.png");
    expect(data.artifact.mime).toBe("image/png");
    expect(data.artifact.width).toBe(1024);
    expect(data.artifact.sha256).toBe(sha256);
    expect("body" in data.artifact).toBe(false);
    expect(data.entry.entryType).toBe("image");
    expect(data.entry.content).toBe("from the phone");
    expect(data.entry.fedToSkipper).toBe(false);
    expect((data.entry.artifact as Record<string, unknown>).id).toBe(data.artifact.id);
    expect((data.entry.artifact as Record<string, unknown>).mime).toBe("image/png");
    expect(data.delivered).toBe("queued");
    expect(wakes).toEqual([taskId]);

    const stored = fileArtifacts.getArtifactById(String(data.artifact.id))!;
    expect(stored.source).toBe("connect:ios-1");
    expect(fileArtifacts.readArtifactBytes(stored.id)!.bytes).toEqual(bytes);

    // list + read carry the file metadata and never a body
    const list = await handleResourceRequest("artifacts", "list", { taskId }, fileDeps);
    const row = (list as { ok: true; data: Array<Record<string, unknown>> }).data.find((a) => a.id === stored.id)!;
    expect(row.storage).toBe("file");
    expect(row.bytes).toBe(bytes.byteLength);
    expect(row.height).toBe(768);
    const read = await handleResourceRequest("artifacts", "read", { id: stored.id }, fileDeps);
    const readData = (read as { ok: true; data: Record<string, unknown> }).data;
    expect(readData.storage).toBe("file");
    expect("body" in readData).toBe(false);
    expect(readData.description).toBe("from the phone");

    // timeline/list carries the artifact ref
    const timeline = await handleResourceRequest("timeline", "list", { taskId }, fileDeps);
    const entries = (timeline as { ok: true; data: Array<Record<string, unknown>> }).data;
    expect(entries).toHaveLength(1);
    expect((entries[0]!.artifact as Record<string, unknown>).name).toBe("phone_photo.png");
  });

  it("read-bytes pages a file artifact in base64 ranges capped at 512 KB", async () => {
    const taskId = seedActiveTask();
    const bytes = pngBytes(2, 2, 600 * 1024);
    const artifact = fileArtifacts.createFileArtifact({ taskId, name: "big.png", kind: "upload", bytes, source: "operator" });

    const first = await handleResourceRequest("artifacts", "read-bytes", { id: artifact.id, offset: 0, length: 1024 * 1024 }, fileDeps);
    const firstData = (first as { ok: true; data: { mime: string; bytes: number; offset: number; length: number; data: string } }).data;
    expect(firstData.mime).toBe("image/png");
    expect(firstData.bytes).toBe(bytes.byteLength);
    expect(firstData.length).toBe(512 * 1024);
    expect(Buffer.from(firstData.data, "base64")).toEqual(Buffer.from(bytes.subarray(0, 512 * 1024)));

    const rest = await handleResourceRequest("artifacts", "read-bytes", { id: artifact.id, offset: 512 * 1024, length: 512 * 1024 }, fileDeps);
    const restData = (rest as { ok: true; data: { length: number; data: string } }).data;
    expect(restData.length).toBe(bytes.byteLength - 512 * 1024);
    expect(Buffer.from(restData.data, "base64")).toEqual(Buffer.from(bytes.subarray(512 * 1024)));

    const inline = artifactManager.createArtifact({ taskId, name: "text", kind: "plan", body: "x" });
    expect((await handleResourceRequest("artifacts", "read-bytes", { id: inline.id }, fileDeps)).ok).toBe(false);
  });

  it("rejects bad uploads: unknown task, oversize chunk, checksum mismatch, and abort", async () => {
    const taskId = seedActiveTask();
    const sha256 = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
    const missing = await handleResourceRequest("artifacts", "upload-begin", { taskId: "nope", name: "x", bytes: 3, sha256 }, fileDeps);
    expect(missing).toEqual({ ok: false, error: "Task not found" });

    const begin = await handleResourceRequest("artifacts", "upload-begin", { taskId, name: "x.bin", bytes: 3, sha256: "0".repeat(64) }, fileDeps);
    const uploadId = (begin as { ok: true; data: { uploadId: string } }).data.uploadId;
    const tooBig = await handleResourceRequest("artifacts", "upload-chunk", { uploadId, index: 0, data: Buffer.alloc(256 * 1024 + 1).toString("base64") }, fileDeps);
    expect(tooBig.ok).toBe(false);
    await handleResourceRequest("artifacts", "upload-chunk", { uploadId, index: 0, data: Buffer.from([1, 2, 3]).toString("base64") }, fileDeps);
    const commit = await handleResourceRequest("artifacts", "upload-commit", { uploadId }, fileDeps);
    expect(commit.ok).toBe(false);
    expect((commit as { ok: false; error: string }).error).toContain("checksum");

    const again = await handleResourceRequest("artifacts", "upload-begin", { taskId, name: "y.bin", bytes: 3, sha256 }, fileDeps);
    const id2 = (again as { ok: true; data: { uploadId: string } }).data.uploadId;
    expect(await handleResourceRequest("artifacts", "upload-abort", { uploadId: id2 }, fileDeps)).toEqual({ ok: true, data: { aborted: true } });
    expect((await handleResourceRequest("artifacts", "upload-commit", { uploadId: id2 }, fileDeps)).ok).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM task_artifacts WHERE task_id = ?").get(taskId)).toEqual({ c: 0 });
  });
});
