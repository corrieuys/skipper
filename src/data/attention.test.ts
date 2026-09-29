import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { resetConfigStore } from "../config/store";
import { createLocalTeam } from "../teams/local-teams";
import { stageSkillSuggestion } from "../improvements/manager";
import { fetchAttentionCounts } from "./attention";
import { attentionIndicator } from "../html/fragments/attention.fragment";

let db: Database;

beforeEach(() => {
  resetConfigStore();
  db = new Database(":memory:");
  initializeDatabase(db);
  createLocalTeam(db, { id: "alpha", name: "Alpha", phases: [], agents: [] });
});

afterEach(() => {
  db.close();
  resetConfigStore();
});

describe("attention counts", () => {
  it("counts pending improvements, review gates and open escalations on active tasks only", () => {
    expect(attentionIndicator(fetchAttentionCounts(db))).toBe('<span id="sk-attention" class="sk-attention"></span>');

    stageSkillSuggestion(db, { teamId: "alpha", skillName: "pdf", problem: "p", suggestion: "s" });
    db.prepare("INSERT INTO tasks (id, title, team_id, status, needs_review) VALUES ('t1', 'a', 'alpha', 'active', 1)").run();
    db.prepare("INSERT INTO tasks (id, title, team_id, status, needs_review) VALUES ('t2', 'b', 'alpha', 'settled', 1)").run();
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('ag', 'Ag', 'claude-code')").run();
    db.prepare("INSERT INTO escalations (id, task_id, agent_id, type, question, status) VALUES ('e1', 't1', 'ag', 'question', 'q', 'open')").run();
    db.prepare("INSERT INTO escalations (id, task_id, agent_id, type, question, status) VALUES ('e2', 't2', 'ag', 'question', 'q', 'open')").run();

    const counts = fetchAttentionCounts(db);
    expect(counts).toEqual({ improvements: 1, reviews: { count: 1, taskId: "t1" }, escalations: { count: 1, taskId: "t1" } });
    const html = attentionIndicator(counts);
    expect(html).toContain('href="/improvements"');
    expect(html).toContain("Review");
    expect(html).toContain('href="/?task=t1"');
  });
});
