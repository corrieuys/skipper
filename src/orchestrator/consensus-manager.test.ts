import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ConsensusManager } from "./consensus-manager";

describe("ConsensusManager.finishConsensus", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  // Regression: the review-gated branch referenced `phases` outside the try
  // block that declared it — a ReferenceError at runtime whenever a consensus
  // phase had review: true.
  it("sets needs_review with the phase name when the consensus phase is review-gated", async () => {
    const phases = [
      { name: "Build", prompt: "build it" },
      { name: "Verify", prompt: "verify it", review: true },
    ];
    db.prepare("INSERT INTO teams (id, name, phases) VALUES ('team-1', 'Team', ?)")
      .run(JSON.stringify(phases));
    db.prepare(
      "INSERT INTO tasks (id, title, status, team_id, current_phase) VALUES ('task-1', 'T', 'running', 'team-1', 1)",
    ).run();

    const setNeedsReview = mock(() => {});
    const completeTask = mock(() => {});
    const advancePhase = mock(() => {});
    const checkpoints: string[] = [];

    const cm = new ConsensusManager(
      db,
      {} as never,
      {} as never,
      {
        getTask: () => ({ id: "task-1", status: "running", team_id: "team-1", task_config: {} }),
        setNeedsReview,
        completeTask,
        advancePhase,
      } as never,
      { cleanupAllForGroup: async () => {} } as never,
      {} as never,
      () => {},
      (_taskId: string, type: string) => { checkpoints.push(type); },
    );

    const meta = {
      groupId: "group-1",
      taskId: "task-1",
      phaseIndex: 1,
      totalPhases: 2,
      phaseName: "Verify",
      entrypointAgentId: "agent-1",
      consensus: { agent_count: 2, worktree: false },
    };

    await (cm as unknown as {
      finishConsensus: (g: string, m: typeof meta, method: string, picked: string | null) => Promise<void>;
    }).finishConsensus("group-1", meta, "pick", null);

    expect(setNeedsReview).toHaveBeenCalledWith("task-1", true, { phaseName: "Verify", phaseIndex: 1 });
    expect(checkpoints).toContain("PHASE_REVIEW_PENDING");
    expect(completeTask).not.toHaveBeenCalled();
    expect(advancePhase).not.toHaveBeenCalled();
  });
});
