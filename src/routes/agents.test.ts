import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { registerAgentRoutes } from "./agents";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { ManagerDaemon } from "../agents/manager-daemon";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;
let daemon: ManagerDaemon;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  daemon = new ManagerDaemon(db);
  registerAgentRoutes(daemon);

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  daemon.stop();
  daemon.getAgentManager().close();
  server.stop(true);
  resetDb();
});

describe("POST /api/agents/:id/steer", () => {
  it("steers a running runtime via JSON API", async () => {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO agent_types (name, command, args, supports_stdin, supports_resume, resume_flag)
       VALUES (?, 'bash', '["-c","sleep 30"]', 1, 1, '--resume')`,
    ).run("resumable-route");
    db.prepare(
      "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, ?, '{}', '[]')",
    ).run("agent-steer", "Steer Agent", "resumable-route");
    db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, ?, ?, '[]')").run(
      "team-steer",
      "Route Team",
      "agent-steer",
    );
    db.prepare(
      "INSERT INTO tasks (id, title, team_id, status, started_at) VALUES (?, ?, ?, 'running', datetime('now'))",
    ).run("task-steer", "Route Task", "team-steer");

    await daemon.getAgentManager().spawnAgentInstance("agent-steer", "runtime-steer-route", {
      workingDir: process.cwd(),
      taskId: "task-steer",
      parentInstanceId: null,
      rootInstanceId: "runtime-steer-route",
      attempt: 1,
    });
    const running = daemon.getAgentManager().getRunningAgent("runtime-steer-route");
    expect(running).toBeDefined();
    running!.sessionId = "sess-route-1";

    const res = await fetch(`${baseUrl}/api/agents/agent-steer/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: "runtime-steer-route", message: "Use the new plan" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    daemon.getAgentManager().killAgent("runtime-steer-route");
    await daemon.getAgentManager().waitForExit("runtime-steer-route", 2000);
  });

  it("rejects invalid steer payloads", async () => {
    const missingRuntime = await fetch(`${baseUrl}/api/agents/agent-x/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hi" }),
    });
    expect(missingRuntime.status).toBe(400);
    expect((await missingRuntime.json()).error).toContain("runtime_id is required");

    const missingMessage = await fetch(`${baseUrl}/api/agents/agent-x/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: "runtime-x", message: "   " }),
    });
    expect(missingMessage.status).toBe(400);
    expect((await missingMessage.json()).error).toContain("message is required");
  });
});
