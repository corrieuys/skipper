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

describe("taskTimelineFragment window on a long task", () => {
  const base = Date.UTC(2026, 0, 1);
  const at = (minute: number, withMs = false) =>
    new Date(base + minute * 60_000).toISOString().replace("T", " ").slice(0, withMs ? 23 : 19);

  function seedInputs(count: number): void {
    const ins = db.prepare(
      "INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper, created_at) VALUES (?, 'task-1', 'text', ?, 1, ?)",
    );
    for (let i = 0; i < count; i++) ins.run(`tl-${i}`, `input-number-${i}-end`, at(i));
  }

  it("renders the newest operator input and drops the oldest past the cap", () => {
    seedInputs(310);
    const html = taskTimelineFragment(db, "task-1");
    expect(html).toContain("input-number-309-end");
    expect(html).toContain("input-number-10-end");
    expect(html).not.toContain("input-number-9-end");
    expect(html).not.toContain("input-number-0-end");
    // Still chronological, oldest first.
    expect(html.indexOf("input-number-10-end")).toBeLessThan(html.indexOf("input-number-309-end"));
  });

  it("renders the newest operator messages and drops the oldest past the cap", () => {
    const ins = db.prepare(
      "INSERT INTO task_messages (id, task_id, agent_id, content, created_at) VALUES (?, 'task-1', 'worker-1', ?, ?)",
    );
    for (let i = 0; i < 210; i++) ins.run(`msg-${i}`, `message-number-${i}-end`, at(i, true));
    const html = taskTimelineFragment(db, "task-1");
    expect(html).toContain("message-number-209-end");
    expect(html).toContain("message-number-10-end");
    expect(html).not.toContain("message-number-9-end");
    expect(html.indexOf("message-number-10-end")).toBeLessThan(html.indexOf("message-number-209-end"));
  });

  it("still pins an open escalation that falls out of the window", () => {
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question, status, created_at) VALUES ('esc-old', 'worker-1', 'task-1', 'question', 'old open question', 'open', ?)",
    ).run(at(-5));
    seedInputs(310);
    const html = taskTimelineFragment(db, "task-1");
    expect(html).toContain('data-esc-open="esc-old"');
    expect(html.indexOf('data-esc-open="esc-old"')).toBeLessThan(html.indexOf("input-number-10-end"));
    expect(html).toContain("input-number-309-end");
  });
});
