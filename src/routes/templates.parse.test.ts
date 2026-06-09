import { describe, expect, test } from "bun:test";
import { parsePhaseRowsFromForm } from "./templates";

// Builds a real FormData the way the browser submits the template form: one
// phaseName per phase block, two always-present prompt textareas, and the
// override/worktree checkboxes that only appear when checked (value = phase name).
function form(entries: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("parsePhaseRowsFromForm", () => {
  test("override checkbox checked persists override_prompt=1 and uses the full-replace textarea", () => {
    const rows = parsePhaseRowsFromForm(form([
      ["phaseName", "plan"],
      ["phasePrompt", "append text"],
      ["phasePromptOverride", "FULL REPLACE"],
      ["phaseOverridePrompt", "plan"], // checkbox checked → value is the phase name
      ["phaseReviewOverride", "inherit"],
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.override_prompt).toBe(1);
    expect(rows[0]!.prompt).toBe("FULL REPLACE");
  });

  test("override checkbox unchecked persists override_prompt=0 and uses the append textarea", () => {
    const rows = parsePhaseRowsFromForm(form([
      ["phaseName", "plan"],
      ["phasePrompt", "append text"],
      ["phasePromptOverride", "FULL REPLACE"],
      // no phaseOverridePrompt entry → unchecked
      ["phaseReviewOverride", "inherit"],
    ]));
    expect(rows[0]!.override_prompt).toBe(0);
    expect(rows[0]!.prompt).toBe("append text");
  });

  test("per-phase override flag keyed by name, not position (only second phase checked)", () => {
    const rows = parsePhaseRowsFromForm(form([
      ["phaseName", "plan"],
      ["phasePrompt", "a"],
      ["phasePromptOverride", "A-FULL"],
      ["phaseName", "build"],
      ["phasePrompt", "b"],
      ["phasePromptOverride", "B-FULL"],
      ["phaseOverridePrompt", "build"], // only "build" checked
      ["phaseReviewOverride", "inherit"],
      ["phaseReviewOverride", "inherit"],
    ]));
    expect(rows.map(r => [r.phase_name, r.override_prompt, r.prompt])).toEqual([
      ["plan", 0, "a"],
      ["build", 1, "B-FULL"],
    ]);
  });

  test("review override maps enabled/disabled/inherit to JSON true/false/null", () => {
    const rows = parsePhaseRowsFromForm(form([
      ["phaseName", "p1"], ["phasePrompt", ""], ["phasePromptOverride", ""], ["phaseReviewOverride", "enabled"],
      ["phaseName", "p2"], ["phasePrompt", ""], ["phasePromptOverride", ""], ["phaseReviewOverride", "disabled"],
      ["phaseName", "p3"], ["phasePrompt", ""], ["phasePromptOverride", ""], ["phaseReviewOverride", "inherit"],
    ]));
    expect(rows.map(r => r.review_override)).toEqual(["true", "false", null]);
  });

  test("consensus override mode builds config JSON; disabled and inherit handled", () => {
    const rows = parsePhaseRowsFromForm(form([
      ["phaseName", "p1"], ["phasePrompt", ""], ["phasePromptOverride", ""], ["phaseReviewOverride", "inherit"],
      ["phaseConsensusMode", "override"],
      ["phaseConsensusAgentCount", "3"],
      ["phaseConsensusStrategy", "merge"],
      ["phaseConsensusWorktree", "p1"], // checked
      ["phaseConsensusReviewerAgentId", "rev-1"],

      ["phaseName", "p2"], ["phasePrompt", ""], ["phasePromptOverride", ""], ["phaseReviewOverride", "inherit"],
      ["phaseConsensusMode", "disabled"],
      ["phaseConsensusAgentCount", "2"],
      ["phaseConsensusStrategy", "best_of"],
      ["phaseConsensusReviewerAgentId", ""],

      ["phaseName", "p3"], ["phasePrompt", ""], ["phasePromptOverride", ""], ["phaseReviewOverride", "inherit"],
      ["phaseConsensusMode", "inherit"],
      ["phaseConsensusAgentCount", "2"],
      ["phaseConsensusStrategy", "best_of"],
      ["phaseConsensusReviewerAgentId", ""],
    ]));
    expect(JSON.parse(rows[0]!.consensus_override!)).toEqual({
      agent_count: 3, strategy: "merge", worktree: true, reviewer_agent_id: "rev-1",
    });
    expect(JSON.parse(rows[1]!.consensus_override!)).toEqual({ disabled: true });
    expect(rows[2]!.consensus_override).toBeNull();
  });

  test("blank phase names are skipped", () => {
    const rows = parsePhaseRowsFromForm(form([
      ["phaseName", "  "], ["phasePrompt", "x"], ["phasePromptOverride", ""], ["phaseReviewOverride", "inherit"],
      ["phaseName", "real"], ["phasePrompt", "y"], ["phasePromptOverride", ""], ["phaseReviewOverride", "inherit"],
    ]));
    expect(rows.map(r => r.phase_name)).toEqual(["real"]);
  });
});
