import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import { fetchTaskForensics, buildTeamAgentTiles, fetchRecentActivity, fetchTaskOutputPage, fetchTaskOutputRow } from "./queries";

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
  // WAL mode leaves -wal/-shm sidecars; a stale pair next to a fresh db file
  // causes intermittent "disk I/O error" on the next open.
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      unlinkSync(f);
    } catch {
      // no-op
    }
  }
});

describe("forensics token usage queries", () => {
  it("forensics token usage includes step_finish and prompt/completion token fields", () => {
    insertAgent("agent-coder", "Coder");
    db.prepare("INSERT INTO tasks (id, title, status, started_at) VALUES ('task-2', 'Task 2', 'active', datetime('now'))").run();
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

describe("fetchRecentActivity", () => {
  it("returns newest-first, dedupes exact-duplicate frames, and excludes result frames", () => {
    insertAgent("agent-coder", "Coder");
    db.prepare("INSERT INTO tasks (id, title, status, started_at) VALUES ('task-ra', 'RA', 'active', datetime('now'))").run();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-ra', 'task-ra', 'agent-coder', 'running')",
    ).run();

    const ins = db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence, created_at) VALUES ('inst-ra', 'stdout', ?, ?, ?)",
    );
    const dup = JSON.stringify({ type: "assistant", message: { text: "hello" } });
    ins.run(dup, 1, "2026-08-31 09:00:00");
    ins.run(dup, 2, "2026-08-31 09:00:00"); // exact duplicate (same data + second) → collapsed
    ins.run(JSON.stringify({ type: "assistant", message: { text: "world" } }), 3, "2026-08-31 09:00:01");
    ins.run(JSON.stringify({ type: "result", result: "done" }), 4, "2026-08-31 09:00:02"); // excluded

    const rows = fetchRecentActivity(db, 250);
    const texts = rows.map((r) => r.data);
    expect(rows.length).toBe(2); // dup collapsed, result excluded
    expect(texts[0]).toContain("world"); // newest first
    expect(texts.some((d) => d.includes('"type":"result"'))).toBe(false);
  });
});

describe("buildTeamAgentTiles identity", () => {
  it("carries each agent's chosen color + character from agents.config", () => {
    db.prepare(
      `INSERT INTO agents (id, name, type, model, config, capabilities)
       VALUES ('team-a:coder', 'Coder', 'claude-code', 'default',
               '{"instruction":"x","color":"#7bd88f","character":"pod"}', '[]')`,
    ).run();
    // A second member with no identity → nulls (falls back to the cube + name hash).
    db.prepare(
      `INSERT INTO agents (id, name, type, model, config, capabilities)
       VALUES ('team-a:writer', 'Writer', 'claude-code', 'default', '{}', '[]')`,
    ).run();
    db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES ('team-a', 'A', 'team-a:coder')").run();
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, level) VALUES ('m1', 'team-a', 'team-a:coder', 1)").run();
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, level) VALUES ('m2', 'team-a', 'team-a:writer', 2)").run();
    db.prepare("INSERT INTO tasks (id, title, status, started_at, team_id) VALUES ('t-tiles', 'T', 'active', datetime('now'), 'team-a')").run();
    // One running instance of the coder → active.
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('i1', 't-tiles', 'team-a:coder', 'running')",
    ).run();

    const tiles = buildTeamAgentTiles(db, "t-tiles");
    const coder = tiles.find((t) => t.template_agent_id === "team-a:coder")!;
    const writer = tiles.find((t) => t.template_agent_id === "team-a:writer")!;

    expect(coder.color).toBe("#7bd88f");
    expect(coder.character).toBe("pod");
    expect(coder.is_active).toBe(true);
    expect(writer.color).toBeNull();
    expect(writer.character).toBeNull();
    expect(writer.is_active).toBe(false);
  });
});

describe("fetchTaskOutputPage", () => {
  function seedOutputs(): number[] {
    insertAgent("agent-page", "Pager");
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-p', 'Paged', 'active')").run();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-q', 'Other', 'active')").run();
    db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-p1', 'task-p', 'agent-page', 'completed')").run();
    db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-p2', 'task-p', 'agent-page', 'running')").run();
    db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-q', 'task-q', 'agent-page', 'running')").run();
    const ins = db.prepare("INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)");
    const ids: number[] = [];
    // Interleave two instances (per-instance `sequence` collides on purpose)
    // plus a row from another task that must never show up.
    for (let i = 1; i <= 6; i++) {
      const r = ins.run(i % 2 ? "inst-p1" : "inst-p2", `frame-${i}`, i);
      ids.push(Number(r.lastInsertRowid));
      if (i === 3) ins.run("inst-q", "other-task", i);
    }
    return ids;
  }

  it("returns the newest page first, ordered by global id across instances", () => {
    const ids = seedOutputs();
    const page = fetchTaskOutputPage(db, "task-p", { limit: 4 });
    expect(page.map((r) => r.data)).toEqual(["frame-6", "frame-5", "frame-4", "frame-3"]);
    expect(page.map((r) => r.id)).toEqual([ids[5], ids[4], ids[3], ids[2]]);
    expect(page[0]!.agent_name).toBe("Pager");
    expect(page.some((r) => r.data === "other-task")).toBe(false);
  });

  it("pages older rows with beforeId and newer rows with afterId", () => {
    const ids = seedOutputs();
    const older = fetchTaskOutputPage(db, "task-p", { limit: 10, beforeId: ids[2] });
    expect(older.map((r) => r.data)).toEqual(["frame-2", "frame-1"]);
    const newer = fetchTaskOutputPage(db, "task-p", { limit: 10, afterId: ids[3] });
    expect(newer.map((r) => r.data)).toEqual(["frame-6", "frame-5"]);
    expect(fetchTaskOutputPage(db, "task-p", { limit: 10, afterId: ids[5] })).toEqual([]);
    expect(fetchTaskOutputPage(db, "task-missing", { limit: 10 })).toEqual([]);
  });

  it("fetches one row by id with its owning task", () => {
    const ids = seedOutputs();
    const row = fetchTaskOutputRow(db, ids[0]!);
    expect(row?.data).toBe("frame-1");
    expect(row?.task_id).toBe("task-p");
    expect(fetchTaskOutputRow(db, 999_999)).toBeNull();
  });
});
