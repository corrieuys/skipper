import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { DelegationManager } from "./delegation-manager";
import type { TaskWakeFeeder } from "./task-runner";

// Regression: operator input that arrives while a delegation is open must ride
// along when the parent resumes from the delegation result, instead of staying
// "queued for agent" (fed_to_skipper=0) until a whole new run starts.
const TEST_DB = "/tmp/skipper-delegation-feed-drain.db";

function makeDm(
  db: Database,
  opts: {
    parentRunning: boolean;
    feeder: TaskWakeFeeder | null;
    onSend: (msg: string) => void;
  },
): DelegationManager {
  const dm = new DelegationManager(
    db,
    {
      getAgent: (id: string) => ({ id, name: "test", type: "claude-code", config: { instruction: "x" } }),
      getRunningAgent: (id: string) => (opts.parentRunning && id === "parent-1" ? { process: {} } : null),
      getTemplateAgentId: (id: string) => id,
      getSessionId: () => null,
      getEntrypointSessionIdForTask: () => null,
      sendInput: (_id: string, msg: string) => { opts.onSend(msg); },
      sendResumeMessage: () => new Promise(() => { /* never settles this tick */ }),
      killAgent: () => {},
    } as any,
    { buildNotesEnrichmentBlock: () => ({ text: "", noteIds: [] }), recordNoteDelivery: () => {} } as any,
    { getTask: () => ({ id: "task-1", status: "active" }) } as any,
    () => {},
    () => {},
    () => {},
    () => new Set(),
  );
  if (opts.feeder) dm.setWakeFeeder(opts.feeder);
  return dm;
}

describe("delegation resume drains pending operator feed", () => {
  let db: Database;

  beforeEach(() => {
    clearAgentTypeCache();
    try { unlinkSync(TEST_DB); } catch {}
    db = new Database(TEST_DB);
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it("appends the pending feed to the resume payload and commits it", () => {
    let committed = false;
    const feeder: TaskWakeFeeder = {
      hasPendingFeed: () => true,
      feedTask: async () => true,
      consumePendingFeed: () => ({ text: "[INPUT_FEED] ignore Fred/Jannik alerts [END_INPUT_FEED]", commit: () => { committed = true; } }),
    };

    let sent = "";
    const dm = makeDm(db, { parentRunning: true, feeder, onSend: (m) => { sent = m; } });

    const routed = dm.routeResultToParent("parent-1", "child-1", "child says done", "task-1");

    expect(routed).toBe(true);
    expect(sent).toContain("child says done");
    expect(sent).toContain("ignore Fred/Jannik alerts");
    expect(committed).toBe(true);
  });

  it("does NOT commit the feed when delivery fails (input stays queued for the next run)", () => {
    let committed = false;
    const feeder: TaskWakeFeeder = {
      hasPendingFeed: () => true,
      feedTask: async () => true,
      consumePendingFeed: () => ({ text: "[INPUT_FEED] later instruction [END_INPUT_FEED]", commit: () => { committed = true; } }),
    };

    // Parent not running and getAgent still returns a claude-code type, whose
    // resume is async — the synchronous return is false and nothing is
    // committed on this tick.
    const dm = makeDm(db, { parentRunning: false, feeder, onSend: () => {} });

    const routed = dm.routeResultToParent("parent-1", "child-1", "done", "task-1");

    expect(routed).toBe(false);
    expect(committed).toBe(false);
  });

  it("is a no-op when no feeder is wired (backward compatible)", () => {
    let sent = "";
    const dm = makeDm(db, { parentRunning: true, feeder: null, onSend: (m) => { sent = m; } });

    const routed = dm.routeResultToParent("parent-1", "child-1", "plain result", "task-1");

    expect(routed).toBe(true);
    expect(sent).toContain("plain result");
  });
});
