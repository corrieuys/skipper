import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../../db/connection";
import { taskTimelineFragment } from "./task-timeline.fragment";

let db: Database;

function seedFileEntry(id: string, source: string, entryType: "image" | "file", caption: string): void {
  db.prepare(
    `INSERT INTO task_artifacts (id, task_id, name, version, kind, description, body, format, created_by_agent_id,
       storage, mime, bytes, sha256, width, height, source)
     VALUES (?, 'task-1', ?, 1, 'upload', ?, ?, NULL, NULL, 'file', ?, 10, 'abc', NULL, NULL, ?)`,
  ).run(`art-${id}`, `${id}.${entryType === "image" ? "png" : "pdf"}`, caption, caption, entryType === "image" ? "image/png" : "application/pdf", source);
  db.prepare(
    `INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper, artifact_id)
     VALUES (?, 'task-1', ?, ?, 1, ?)`,
  ).run(`tl-${id}`, entryType, caption, `art-${id}`);
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-1', 'T', 'team-1', 'active')").run();
  db.prepare("INSERT INTO agents (id, name, type, model, config) VALUES ('worker-1', 'Worker One', 'claude-code', 'default', '{\"color\":\"#336699\"}')").run();
});

afterEach(() => {
  db.close();
});

describe("taskTimelineFragment file artifact cards", () => {
  it("labels an operator upload as You", () => {
    seedFileEntry("op", "operator", "image", "my screenshot");
    const html = taskTimelineFragment(db, "task-1");
    expect(html).toContain('<span class="tc-entry__who">You</span>');
    expect(html).toContain("tc-entry--input");
    expect(html).toContain("my screenshot");
    expect(html).not.toContain("Worker One");
  });

  it("labels an agent-attached file with the agent's name and color, and drops the input styling", () => {
    seedFileEntry("ag", "worker-1", "file", "build log");
    const html = taskTimelineFragment(db, "task-1");
    expect(html).toContain("Worker One");
    expect(html).toContain('style="color:#336699"');
    expect(html).toContain("tc-entry--agent-upload");
    expect(html).toContain("file v1");
    expect(html).not.toContain('<span class="tc-entry__who">You</span>');
    expect(html).not.toContain("queued for agent");
  });

  it("falls back to the raw source id when the agent row is gone", () => {
    seedFileEntry("gone", "deleted-agent", "image", "old shot");
    const html = taskTimelineFragment(db, "task-1");
    expect(html).toContain("deleted-agent");
  });
});
