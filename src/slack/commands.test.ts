import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { TaskScheduler } from "../tasks/scheduler";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { saveSlackConfig } from "../config/slack-settings";
import { handleSlashCommand } from "./commands";
import type { SlackClient } from "./client";

let db: Database;
let taskScheduler: TaskScheduler;
let scheduled: ScheduledTaskScheduler;

const USER = "U-allowed";

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  clearAgentTypeCache();
  taskScheduler = new TaskScheduler(db);
  scheduled = new ScheduledTaskScheduler(db);
  saveSlackConfig(db, { botToken: "", defaultChannel: "", allowedUsers: [USER] });
});

afterEach(() => {
  db.close();
});

/** Create the shared team row (FK target for tasks) + a local_teams binding. */
function makeTeam(id: string, slashCommand?: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('default-agent', 'Default Agent', 'claude-code', 'default')",
  ).run();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, ?, 'default-agent')",
  ).run(id, "Software Team");
  db.prepare(
    "INSERT OR IGNORE INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, 'default-agent', 'lead', 0)",
  ).run(`ta-${id}`, id);
  db.prepare(
    "INSERT INTO local_teams (id, name, skipper_prompt, hooks, phases, agents, team_config) VALUES (?, ?, '', '[]', '[]', '[]', ?)",
  ).run(id, "Software Team", JSON.stringify(slashCommand ? { slashCommand } : {}));
}

/** A SlackClient stub whose postMessage returns a canned anchor ts. */
function stubClient(ts = "1700.0001"): SlackClient {
  return {
    postMessage: async (channel: string) => ({ channel, ts }),
  } as unknown as SlackClient;
}

describe("handleSlashCommand", () => {
  it("denies a user not on the allowlist and creates nothing", async () => {
    makeTeam("team-1", "/software-team");
    const reply = await handleSlashCommand(db, taskScheduler, scheduled, {
      command: "/software-team",
      text: "add a webhook feature",
      user_id: "U-stranger",
    });
    expect(reply.text).toContain("Not authorized");
    const count = (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("creates + auto-approves a task on the bound team, arg text as description", async () => {
    makeTeam("team-1", "/software-team");
    const reply = await handleSlashCommand(db, taskScheduler, scheduled, {
      command: "/software-team",
      text: "add a webhook feature",
      user_id: USER,
    });
    expect(reply.text).toContain("Started task");
    const row = db
      .prepare("SELECT status, team_id, description FROM tasks")
      .get() as { status: string; team_id: string; description: string };
    expect(["approved", "running"]).toContain(row.status);
    expect(row.team_id).toBe("team-1");
    expect(row.description).toBe("add a webhook feature");
  });

  it("matches the binding case-insensitively and ignoring a missing leading slash", async () => {
    makeTeam("team-1", "/software-team");
    const reply = await handleSlashCommand(db, taskScheduler, scheduled, {
      command: "SOFTWARE-TEAM",
      text: "do the thing",
      user_id: USER,
    });
    expect(reply.text).toContain("Started task");
  });

  it("asks for a description when a team command has no text", async () => {
    makeTeam("team-1", "/software-team");
    const reply = await handleSlashCommand(db, taskScheduler, scheduled, {
      command: "/software-team",
      text: "",
      user_id: USER,
    });
    expect(reply.text).toContain("description");
    const count = (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("runs a bound scheduled task now, arg text as run input", async () => {
    makeTeam("team-1");
    const st = scheduled.createScheduledTask({
      title: "Nightly report",
      teamId: "team-1",
      workingDirectory: "/repo",
      taskConfig: { slashCommand: "/nightly-report" },
    });
    scheduled.approveScheduledTask(st.id);

    const reply = await handleSlashCommand(db, taskScheduler, scheduled, {
      command: "/nightly-report",
      text: "focus on errors",
      user_id: USER,
    });
    // No channel_id → no anchor → a single ephemeral reply.
    expect(reply.text).toContain("Started");
    expect(reply.posted).toBeFalsy();
    const run = db
      .prepare("SELECT run_input FROM tasks WHERE source_scheduled_task_id = ?")
      .get(st.id) as { run_input: string | null } | null;
    expect(run).not.toBeNull();
    expect(run!.run_input).toBe("focus on errors");
  });

  it("suppresses the ephemeral reply when it posted a public anchor (single message)", async () => {
    saveSlackConfig(db, { botToken: "xoxb-x", defaultChannel: "", allowedUsers: [USER] });
    makeTeam("team-1", "/software-team");
    const reply = await handleSlashCommand(
      db,
      taskScheduler,
      scheduled,
      { command: "/software-team", text: "ship it", user_id: USER, channel_id: "C42" },
      stubClient("1700.9"),
    );
    expect(reply.posted).toBe(true);
    expect(reply.text).toContain("Started");
  });

  it("refuses to run an unapproved (draft) scheduled task", async () => {
    makeTeam("team-1");
    const st = scheduled.createScheduledTask({
      title: "Nightly report",
      teamId: "team-1",
      workingDirectory: "/repo",
      taskConfig: { slashCommand: "/nightly-report" },
    });
    // left as draft
    const reply = await handleSlashCommand(db, taskScheduler, scheduled, {
      command: "/nightly-report",
      user_id: USER,
    });
    expect(reply.text).toContain("not approved");
  });

  it("reports when no action is bound to the command", async () => {
    const reply = await handleSlashCommand(db, taskScheduler, scheduled, {
      command: "/unknown",
      user_id: USER,
    });
    expect(reply.text).toContain("No Skipper action");
  });
});

describe("handleSlashCommand — Slack origin capture", () => {
  it("stamps slack_origin (channel + thread + user) on a team task when a client posts an anchor", async () => {
    // A bot token makes the anchor post fire.
    saveSlackConfig(db, { botToken: "xoxb-x", defaultChannel: "", allowedUsers: [USER] });
    makeTeam("team-1", "/software-team");
    await handleSlashCommand(
      db,
      taskScheduler,
      scheduled,
      { command: "/software-team", text: "ship it", user_id: USER, channel_id: "C42" },
      stubClient("1700.5"),
    );
    const row = db.prepare("SELECT task_config FROM tasks").get() as { task_config: string };
    const origin = JSON.parse(row.task_config).slack_origin;
    expect(origin).toEqual({ channel: "C42", user_id: USER, thread_ts: "1700.5" });
  });

  it("falls back to a channel-only origin when Slack is unconfigured (no anchor)", async () => {
    makeTeam("team-1", "/software-team");
    await handleSlashCommand(
      db,
      taskScheduler,
      scheduled,
      { command: "/software-team", text: "ship it", user_id: USER, channel_id: "C42" },
      stubClient(),
    );
    const row = db.prepare("SELECT task_config FROM tasks").get() as { task_config: string };
    const origin = JSON.parse(row.task_config).slack_origin;
    expect(origin).toEqual({ channel: "C42", user_id: USER });
  });

  it("stamps slack_origin on a scheduled run", async () => {
    saveSlackConfig(db, { botToken: "xoxb-x", defaultChannel: "", allowedUsers: [USER] });
    makeTeam("team-1");
    const st = scheduled.createScheduledTask({
      title: "Nightly report",
      teamId: "team-1",
      workingDirectory: "/repo",
      taskConfig: { slashCommand: "/nightly-report" },
    });
    scheduled.approveScheduledTask(st.id);
    await handleSlashCommand(
      db,
      taskScheduler,
      scheduled,
      { command: "/nightly-report", text: "errors only", user_id: USER, channel_id: "C7" },
      stubClient("999.1"),
    );
    const row = db
      .prepare("SELECT task_config FROM tasks WHERE source_scheduled_task_id = ?")
      .get(st.id) as { task_config: string };
    const origin = JSON.parse(row.task_config).slack_origin;
    expect(origin.channel).toBe("C7");
    expect(origin.thread_ts).toBe("999.1");
  });

  it("captures no origin when there is no channel_id", async () => {
    makeTeam("team-1", "/software-team");
    await handleSlashCommand(
      db,
      taskScheduler,
      scheduled,
      { command: "/software-team", text: "ship it", user_id: USER },
      stubClient(),
    );
    const row = db.prepare("SELECT task_config FROM tasks").get() as { task_config: string };
    expect(JSON.parse(row.task_config).slack_origin).toBeUndefined();
  });
});
