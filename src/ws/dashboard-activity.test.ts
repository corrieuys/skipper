import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { buildDashboardActivity } from "./dashboard-activity";

let db: Database;
let seq = 0;

function out(obj: unknown): void {
  const data = typeof obj === "string" ? obj : JSON.stringify(obj);
  db.prepare("INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES ('inst-1','stdout',?,?)").run(data, ++seq);
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  seq = 0;
  db.prepare("INSERT INTO tasks (id,title,status,started_at) VALUES ('t1','T','active',datetime('now'))").run();
  db.prepare("INSERT INTO agent_instances (id,task_id,template_agent_id,status) VALUES ('inst-1','t1','claude','running')").run();
});

afterEach(() => db.close());

describe("buildDashboardActivity", () => {
  it("keeps assistant prose as a message and tool_use as a tool", () => {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Tracing the token check" }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } });
    const rows = buildDashboardActivity(db, 50);
    const byText = (s: string) => rows.find((r) => r.text.includes(s));
    expect(byText("Tracing the token check")?.kind).toBe("message");
    expect(byText("bun test")?.kind).toBe("tool");
  });

  it("drops plumbing/noise frames instead of dumping raw JSON", () => {
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    out({ type: "system", subtype: "hook_started", hook_name: "SessionStart:resume" });
    out({ type: "system", subtype: "init" });
    out({ type: "totally_unknown_shape", blob: { a: 1 } });
    const rows = buildDashboardActivity(db, 50);
    expect(rows).toHaveLength(0);
    // and crucially, no raw JSON leaked into any text
    expect(rows.every((r) => !r.text.includes("{"))).toBe(true);
  });

  it("keeps task_notification system events", () => {
    out({ type: "system", subtype: "task_notification", status: "completed", summary: "done" });
    const rows = buildDashboardActivity(db, 50);
    expect(rows.some((r) => r.text.includes("done"))).toBe(true);
  });

  it("shows plain (non-JSON) stdout lines verbatim", () => {
    out("building project...");
    const rows = buildDashboardActivity(db, 50);
    expect(rows.some((r) => r.text === "building project...")).toBe(true);
  });

  it("merges create_note entries into the feed as kind:note", () => {
    out({ type: "assistant", message: { content: [{ type: "text", text: "streaming line" }] } });
    db.prepare("INSERT INTO task_notes (id,task_id,agent_id,content) VALUES ('n1','t1','inst-1','Milestone note')").run();
    const rows = buildDashboardActivity(db, 50);
    const note = rows.find((r) => r.kind === "note");
    expect(note?.text).toBe("Milestone note");
    // both streaming output and the note coexist
    expect(rows.some((r) => r.kind === "message" && r.text === "streaming line")).toBe(true);
  });
});
