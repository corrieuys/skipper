import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { setStringSetting, SETTING_SKIPPER_CONNECT_KEY, SETTING_SKIPPER_CONNECT_URL } from "../config/app-settings";
import { handleResourceRequest, type ResourceDeps } from "./resources";
import { getPublicArtifactUrl, getWebhookTriggerUrl, gidFromConnectKey } from "./public-links";
import { TaskScheduler } from "../tasks/scheduler";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";

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
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES (?, ?, ?, 'running')").run("task-1", "Test Task", "team-1");
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
  });

  it("teams rejects unknown actions", async () => {
    const result = await handleResourceRequest("teams", "update", {}, deps);
    expect(result.ok).toBe(false);
  });

  it("tasks/create persists title, description, team, and task type", async () => {
    const db = getDb();
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run("team-a", "Alpha", "[]");
    const taskScheduler = new TaskScheduler(db);
    const createDeps = { ...deps, taskScheduler } as ResourceDeps;

    const result = await handleResourceRequest("tasks", "create", {
      title: "From the app",
      description: "made remotely",
      teamId: "team-a",
      taskType: "real_time",
    }, createDeps);
    expect(result.ok).toBe(true);
    const task = (result as { ok: true; data: { id: string } }).data;
    const stored = taskScheduler.getTask(task.id)!;
    expect(stored.title).toBe("From the app");
    expect(stored.description).toBe("made remotely");
    expect(stored.team_id).toBe("team-a");
    expect(stored.task_type).toBe("real_time");
    expect(stored.status).toBe("draft");
  });

  it("tasks/create rejects an invalid task type", async () => {
    const taskScheduler = new TaskScheduler(getDb());
    const createDeps = { ...deps, taskScheduler } as ResourceDeps;
    const result = await handleResourceRequest("tasks", "create", { title: "x", taskType: "cron" }, createDeps);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("Invalid taskType");
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
      "INSERT INTO tasks (id, title, team_id, status, needs_review, current_phase) VALUES ('t-1', 'Running', 'team-s', 'running', 1, 1)",
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

    expect(data.protocolVersion).toBe(2);
    const tasks = data.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    const running = tasks.find((t) => t.id === "t-1")!;
    expect(running).toMatchObject({
      title: "Running",
      status: "running",
      team_name: "Snap Team",
      current_phase: 1,
      phase_count: 3,
      needs_review: true,
    });
    expect(running).not.toContainKeys(["result", "orchestration_state", "description", "task_config"]);
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
    expect(row.status).toBe("approved");
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
