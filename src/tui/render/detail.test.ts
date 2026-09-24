import { describe, expect, test } from "bun:test";
import { activityLines } from "./detail";
import type { ActivityRow } from "../model/types";

const row = (text: string, kind: ActivityRow["kind"] = "message"): ActivityRow => ({
  agent_id: "a1",
  agent_name: "Skipper",
  task_id: "t1",
  kind,
  text,
  created_at: "2026-09-15T10:20:00.000Z",
});

describe("activityLines", () => {
  test("short rows stay on one line with the time + tag prefix", () => {
    const lines = activityLines(row("hello"), 60);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.prefix!.text).toMatch(/^\d\d:\d\d ▓ $/);
    expect(lines[0]!.text).toBe("Skipper hello");
  });

  test("long rows wrap to the width with continuation lines indented under the text", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const lines = activityLines(row(words), 50);
    expect(lines.length).toBeGreaterThan(1);
    const prefixW = lines[0]!.prefix!.text.length;
    for (const l of lines) {
      expect(l.prefix!.text.length).toBe(prefixW);
      expect(prefixW + l.text.length).toBeLessThanOrEqual(50);
    }
    expect(lines[1]!.prefix!.text.trim()).toBe("");
    expect(lines.map((l) => l.text).join(" ")).toContain("word39");
  });

  test("very long rows fold after the cap with a count", () => {
    const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const lines = activityLines(row(words, "tool"), 40);
    expect(lines).toHaveLength(8);
    expect(lines[7]!.text).toMatch(/^… \d+ more lines$/);
  });

  test("newlines and runs of whitespace collapse before wrapping", () => {
    const lines = activityLines(row("a\n\n   b    c"), 60);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("Skipper a b c");
  });
});
