import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { unlinkSync } from "fs";
import {
  getTaskTemplateId,
  getTemplateSkipperPrompt,
  getTemplatePhasePrompt,
  getTemplatePhaseOverrides,
  resolvePhaseConfig,
} from "./helpers";
import type { ConsensusConfig, Phase } from "../teams/manager";

const TEST_DB = "test-template-helpers.db";

let db: Database;

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB); } catch { /* ignore */ }
});

function seedTemplate(opts: {
  id: string;
  teamId?: string;
  skipperPrompt?: string;
  deletedAt?: string | null;
  phases?: Array<{
    name: string;
    prompt: string;
    override_prompt?: number;
    review_override?: string | null;
    consensus_override?: string | null;
  }>;
}): void {
  db.prepare(
    "INSERT INTO task_templates (id, template_name, team_id, skipper_prompt, deleted_at) VALUES (?, ?, ?, ?, ?)",
  ).run(opts.id, `tpl-${opts.id}`, opts.teamId ?? "team-1", opts.skipperPrompt ?? "", opts.deletedAt ?? null);
  for (const phase of opts.phases ?? []) {
    db.prepare(
      "INSERT INTO task_template_phases (id, task_template_id, phase_name, prompt, override_prompt, review_override, consensus_override) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(), opts.id, phase.name, phase.prompt,
      phase.override_prompt ?? 0,
      phase.review_override ?? null,
      phase.consensus_override ?? null,
    );
  }
}

const BASE_PHASE: Phase = { name: "plan", prompt: "base plan prompt" };
const BASE_PHASE_WITH_REVIEW: Phase = { name: "plan", prompt: "base plan prompt", review: true };
const BASE_CONSENSUS: ConsensusConfig = { agent_count: 3, strategy: "best_of", worktree: true };
const BASE_PHASE_WITH_CONSENSUS: Phase = { name: "plan", prompt: "base", consensus: BASE_CONSENSUS };

describe("getTaskTemplateId", () => {
  it("returns the template_id from a JSON task_config object", () => {
    expect(getTaskTemplateId({ template_id: "abc" })).toBe("abc");
  });

  it("returns undefined when task_config is null/undefined/empty", () => {
    expect(getTaskTemplateId(null)).toBeUndefined();
    expect(getTaskTemplateId(undefined)).toBeUndefined();
    expect(getTaskTemplateId({})).toBeUndefined();
  });

  it("returns undefined when template_id is not a string", () => {
    expect(getTaskTemplateId({ template_id: 123 })).toBeUndefined();
    expect(getTaskTemplateId({ template_id: null })).toBeUndefined();
  });

  it("returns undefined when task_config is not an object", () => {
    expect(getTaskTemplateId("not-an-object")).toBeUndefined();
    expect(getTaskTemplateId(42)).toBeUndefined();
  });
});

describe("getTemplateSkipperPrompt", () => {
  it("returns null for undefined template id", () => {
    expect(getTemplateSkipperPrompt(db, undefined)).toBeNull();
  });

  it("returns the trimmed skipper prompt for a live template", () => {
    seedTemplate({ id: "t1", skipperPrompt: "  follow the rules.  " });
    expect(getTemplateSkipperPrompt(db, "t1")).toBe("follow the rules.");
  });

  it("returns null when the template has been soft-deleted", () => {
    seedTemplate({ id: "t2", skipperPrompt: "ghost prompt", deletedAt: "2026-01-01 00:00:00" });
    expect(getTemplateSkipperPrompt(db, "t2")).toBeNull();
  });

  it("returns null when the template id does not match any row", () => {
    expect(getTemplateSkipperPrompt(db, "missing")).toBeNull();
  });

  it("returns null when the skipper prompt is empty/whitespace (no useful append)", () => {
    seedTemplate({ id: "t3", skipperPrompt: "   " });
    expect(getTemplateSkipperPrompt(db, "t3")).toBeNull();
  });
});

describe("getTemplatePhasePrompt", () => {
  it("returns the prompt for a specific phase name on a live template", () => {
    seedTemplate({
      id: "t4",
      phases: [
        { name: "plan", prompt: "draft the plan." },
        { name: "execute", prompt: "carry it out." },
      ],
    });
    expect(getTemplatePhasePrompt(db, "t4", "plan")).toBe("draft the plan.");
    expect(getTemplatePhasePrompt(db, "t4", "execute")).toBe("carry it out.");
  });

  it("returns null for an unknown phase name on a live template", () => {
    seedTemplate({ id: "t5", phases: [{ name: "plan", prompt: "x" }] });
    expect(getTemplatePhasePrompt(db, "t5", "review")).toBeNull();
  });

  it("returns null when the template is soft-deleted, even if the phase row exists", () => {
    seedTemplate({
      id: "t6",
      deletedAt: "2026-01-01 00:00:00",
      phases: [{ name: "plan", prompt: "stale plan." }],
    });
    expect(getTemplatePhasePrompt(db, "t6", "plan")).toBeNull();
  });

  it("returns null for undefined template id", () => {
    expect(getTemplatePhasePrompt(db, undefined, "plan")).toBeNull();
  });

  it("returns null when phase prompt is empty/whitespace", () => {
    seedTemplate({ id: "t7", phases: [{ name: "plan", prompt: "  " }] });
    expect(getTemplatePhasePrompt(db, "t7", "plan")).toBeNull();
  });
});

// Simulates the orchestrator call-site contract: when the template phase prompt
// is empty/whitespace, the runtime must skip injection and the agent receives only
// the base team phase prompt. Locks the ternary pattern in task-runner.ts,
// phase-manager.ts, recovery-manager.ts, and consensus-manager.ts against regressions.
describe("runtime injection contract", () => {
  function applyTemplate(basePhasePrompt: string, templateId: string | undefined, phaseName: string): string {
    const templatePhasePrompt = getTemplatePhasePrompt(db, templateId, phaseName);
    return templatePhasePrompt ? `${basePhasePrompt}\n\n${templatePhasePrompt}` : basePhasePrompt;
  }

  it("skips appending when the template's phase prompt is empty", () => {
    seedTemplate({ id: "t-empty", phases: [{ name: "plan", prompt: "" }] });
    expect(applyTemplate("BASE", "t-empty", "plan")).toBe("BASE");
  });

  it("skips appending when the template's phase prompt is whitespace-only", () => {
    seedTemplate({ id: "t-ws", phases: [{ name: "plan", prompt: "   \n  \t" }] });
    expect(applyTemplate("BASE", "t-ws", "plan")).toBe("BASE");
  });

  it("skips appending when no template_id is set on the task", () => {
    expect(applyTemplate("BASE", undefined, "plan")).toBe("BASE");
  });

  it("skips appending when the named phase is not configured on the template", () => {
    seedTemplate({ id: "t-otherphase", phases: [{ name: "review", prompt: "review notes" }] });
    expect(applyTemplate("BASE", "t-otherphase", "plan")).toBe("BASE");
  });

  it("appends with two newlines when the prompt has actual content", () => {
    seedTemplate({ id: "t-real", phases: [{ name: "plan", prompt: "extra plan guidance" }] });
    expect(applyTemplate("BASE", "t-real", "plan")).toBe("BASE\n\nextra plan guidance");
  });
});

describe("getTemplatePhaseOverrides", () => {
  it("returns null for undefined template id", () => {
    expect(getTemplatePhaseOverrides(db, undefined, "plan")).toBeNull();
  });

  it("returns null when no phase row exists for this template+phase", () => {
    seedTemplate({ id: "tpo-1" });
    expect(getTemplatePhaseOverrides(db, "tpo-1", "plan")).toBeNull();
  });

  it("returns overrides with defaults when phase row exists with no overrides set", () => {
    seedTemplate({ id: "tpo-2", phases: [{ name: "plan", prompt: "some prompt" }] });
    const result = getTemplatePhaseOverrides(db, "tpo-2", "plan");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("some prompt");
    expect(result!.override_prompt).toBe(false);
    expect(result!.review_override).toBeNull();
    expect(result!.consensus_override).toBeUndefined();
  });

  it("returns override_prompt=true when column is 1", () => {
    seedTemplate({ id: "tpo-3", phases: [{ name: "plan", prompt: "full prompt", override_prompt: 1 }] });
    const result = getTemplatePhaseOverrides(db, "tpo-3", "plan");
    expect(result!.override_prompt).toBe(true);
  });

  it("parses review_override=true from JSON string", () => {
    seedTemplate({ id: "tpo-4", phases: [{ name: "plan", prompt: "", review_override: "true" }] });
    expect(getTemplatePhaseOverrides(db, "tpo-4", "plan")!.review_override).toBe(true);
  });

  it("parses review_override=false from JSON string", () => {
    seedTemplate({ id: "tpo-5", phases: [{ name: "plan", prompt: "", review_override: "false" }] });
    expect(getTemplatePhaseOverrides(db, "tpo-5", "plan")!.review_override).toBe(false);
  });

  it("parses consensus_override as disabled when disabled=true", () => {
    seedTemplate({ id: "tpo-6", phases: [{ name: "plan", prompt: "", consensus_override: '{"disabled":true}' }] });
    expect(getTemplatePhaseOverrides(db, "tpo-6", "plan")!.consensus_override).toBeNull();
  });

  it("parses consensus_override as ConsensusConfig when full config provided", () => {
    const cfg: ConsensusConfig = { agent_count: 2, strategy: "best_of", worktree: false };
    seedTemplate({ id: "tpo-7", phases: [{ name: "plan", prompt: "", consensus_override: JSON.stringify(cfg) }] });
    const result = getTemplatePhaseOverrides(db, "tpo-7", "plan");
    expect(result!.consensus_override).toMatchObject({ agent_count: 2, strategy: "best_of", worktree: false });
  });

  it("returns null for a soft-deleted template", () => {
    seedTemplate({ id: "tpo-8", deletedAt: "2026-01-01", phases: [{ name: "plan", prompt: "x" }] });
    expect(getTemplatePhaseOverrides(db, "tpo-8", "plan")).toBeNull();
  });
});

describe("resolvePhaseConfig", () => {
  it("returns base team config when no template", () => {
    const result = resolvePhaseConfig(db, BASE_PHASE, undefined, undefined);
    expect(result.name).toBe("plan");
    expect(result.prompt).toBe("base plan prompt");
    expect(result.review).toBe(false);
    expect(result.consensus).toBeNull();
  });

  it("returns base review=true when team phase has review:true and no overrides", () => {
    const result = resolvePhaseConfig(db, BASE_PHASE_WITH_REVIEW, undefined, undefined);
    expect(result.review).toBe(true);
  });

  it("appends template prompt (override_prompt=0)", () => {
    seedTemplate({ id: "res-1", phases: [{ name: "plan", prompt: "extra guidance" }] });
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-1", undefined);
    expect(result.prompt).toBe("base plan prompt\n\nextra guidance");
  });

  it("replaces base prompt when override_prompt=1", () => {
    seedTemplate({ id: "res-2", phases: [{ name: "plan", prompt: "full replacement", override_prompt: 1 }] });
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-2", undefined);
    expect(result.prompt).toBe("full replacement");
  });

  it("uses base prompt when template phase prompt is empty (no append)", () => {
    seedTemplate({ id: "res-3", phases: [{ name: "plan", prompt: "" }] });
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-3", undefined);
    expect(result.prompt).toBe("base plan prompt");
  });

  it("template review_override=true overrides team review=false", () => {
    seedTemplate({ id: "res-4", phases: [{ name: "plan", prompt: "", review_override: "true" }] });
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-4", undefined);
    expect(result.review).toBe(true);
  });

  it("template review_override=false overrides team review=true", () => {
    seedTemplate({ id: "res-5", phases: [{ name: "plan", prompt: "", review_override: "false" }] });
    const result = resolvePhaseConfig(db, BASE_PHASE_WITH_REVIEW, "res-5", undefined);
    expect(result.review).toBe(false);
  });

  it("template consensus_override adds consensus to phase that had none", () => {
    const cfg: ConsensusConfig = { agent_count: 2, strategy: "best_of", worktree: true };
    seedTemplate({ id: "res-6", phases: [{ name: "plan", prompt: "", consensus_override: JSON.stringify(cfg) }] });
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-6", undefined);
    expect(result.consensus).toMatchObject({ agent_count: 2, strategy: "best_of", worktree: true });
  });

  it("template consensus_override disabled removes consensus from phase", () => {
    seedTemplate({ id: "res-7", phases: [{ name: "plan", prompt: "", consensus_override: '{"disabled":true}' }] });
    const result = resolvePhaseConfig(db, BASE_PHASE_WITH_CONSENSUS, "res-7", undefined);
    expect(result.consensus).toBeNull();
  });

  it("task-level review override supersedes template override", () => {
    seedTemplate({ id: "res-8", phases: [{ name: "plan", prompt: "", review_override: "false" }] });
    const taskConfig = { template_id: "res-8", phase_overrides: { plan: { review: true } } };
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-8", taskConfig);
    expect(result.review).toBe(true);
  });

  it("task-level consensus override supersedes template override", () => {
    seedTemplate({ id: "res-9", phases: [{ name: "plan", prompt: "", consensus_override: '{"disabled":true}' }] });
    const override: ConsensusConfig = { agent_count: 4, strategy: "merge", worktree: false };
    const taskConfig = { template_id: "res-9", phase_overrides: { plan: { consensus: override } } };
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-9", taskConfig);
    expect(result.consensus).toMatchObject({ agent_count: 4, strategy: "merge" });
  });

  it("task-level consensus override null disables consensus", () => {
    const taskConfig = { phase_overrides: { plan: { consensus: null } } };
    const result = resolvePhaseConfig(db, BASE_PHASE_WITH_CONSENSUS, undefined, taskConfig);
    expect(result.consensus).toBeNull();
  });

  it("task-level overrides do NOT affect prompts", () => {
    seedTemplate({ id: "res-10", phases: [{ name: "plan", prompt: "appended" }] });
    const taskConfig = { template_id: "res-10", phase_overrides: { plan: { review: true } } };
    const result = resolvePhaseConfig(db, BASE_PHASE, "res-10", taskConfig);
    // Prompt still uses template append, not affected by task override
    expect(result.prompt).toBe("base plan prompt\n\nappended");
  });

  it("no template + task-level review override works", () => {
    const taskConfig = { phase_overrides: { plan: { review: true } } };
    const result = resolvePhaseConfig(db, BASE_PHASE, undefined, taskConfig);
    expect(result.review).toBe(true);
    expect(result.prompt).toBe("base plan prompt");
  });
});
