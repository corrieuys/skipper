import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { stampTaskSlackOrigin, readTaskSlackOrigin } from "./slash-command";

let db: Database;

/** `task_config` is NOT NULL DEFAULT '{}', so an unset config is an empty object. */
function seedTask(id: string, taskConfig: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO tasks (id, title, status, task_config) VALUES (?, 'Nightly report', 'running', ?)").run(
    id,
    JSON.stringify(taskConfig),
  );
}

function rawConfig(id: string): Record<string, unknown> {
  const row = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(id) as { task_config: string | null };
  return JSON.parse(row.task_config ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.exec("PRAGMA foreign_keys=OFF");
});

afterEach(() => db.close());

describe("stampTaskSlackOrigin", () => {
  it("stamps an origin onto a task that has none", () => {
    seedTask("t1");
    expect(stampTaskSlackOrigin(db, "t1", { channel: "C9", thread_ts: "1.1", source: "agent_message" })).toBe(true);
    expect(readTaskSlackOrigin(db, "t1")).toEqual({
      channel: "C9",
      thread_ts: "1.1",
      user_id: undefined,
      source: "agent_message",
    });
  });

  it("omits thread_ts when the send produced no timestamp", () => {
    seedTask("t1");
    expect(stampTaskSlackOrigin(db, "t1", { channel: "C9", source: "agent_message" })).toBe(true);
    expect(readTaskSlackOrigin(db, "t1")?.thread_ts).toBeUndefined();
  });

  // The whole point of first-write-wins: an agent posting to a second channel
  // later in the run must not move routing out from under an in-flight escalation.
  it("does not overwrite an origin that is already set", () => {
    seedTask("t1");
    stampTaskSlackOrigin(db, "t1", { channel: "C-first", thread_ts: "1.1", source: "agent_message" });
    expect(stampTaskSlackOrigin(db, "t1", { channel: "C-second", thread_ts: "2.2", source: "agent_message" })).toBe(false);
    expect(readTaskSlackOrigin(db, "t1")?.channel).toBe("C-first");
  });

  it("never clobbers a slash-command origin with a later agent post", () => {
    seedTask("t1", { slack_origin: { channel: "C-slash", thread_ts: "1.1", user_id: "U1", source: "slash_command" } });
    expect(stampTaskSlackOrigin(db, "t1", { channel: "C-agent", thread_ts: "2.2", source: "agent_message" })).toBe(false);
    expect(readTaskSlackOrigin(db, "t1")?.source).toBe("slash_command");
  });

  it("preserves the rest of task_config", () => {
    seedTask("t1", { global_store_instructions: "keep a tally", phase_overrides: { "0": "x" } });
    stampTaskSlackOrigin(db, "t1", { channel: "C9", source: "agent_message" });
    const config = rawConfig("t1");
    expect(config.global_store_instructions).toBe("keep a tally");
    expect(config.phase_overrides).toEqual({ "0": "x" });
    expect((config.slack_origin as { channel: string }).channel).toBe("C9");
  });

  it("is a no-op for an unknown task or a blank channel", () => {
    expect(stampTaskSlackOrigin(db, "nope", { channel: "C9" })).toBe(false);
    seedTask("t1");
    expect(stampTaskSlackOrigin(db, "t1", { channel: "" })).toBe(false);
    expect(readTaskSlackOrigin(db, "t1")).toBeNull();
  });

  it("leaves a task whose task_config is not valid JSON alone", () => {
    seedTask("t1");
    db.prepare("UPDATE tasks SET task_config = 'not json' WHERE id = ?").run("t1");
    expect(stampTaskSlackOrigin(db, "t1", { channel: "C9" })).toBe(false);
  });
});

describe("readTaskSlackOrigin", () => {
  // Origins stamped before the field existed could only have come from a command.
  it("defaults a sourceless origin to slash_command", () => {
    seedTask("t1", { slack_origin: { channel: "C42", thread_ts: "1.1" } });
    expect(readTaskSlackOrigin(db, "t1")?.source).toBe("slash_command");
  });

  it("returns null for a task with no origin", () => {
    seedTask("t1", { global_store_instructions: "x" });
    expect(readTaskSlackOrigin(db, "t1")).toBeNull();
  });
});
