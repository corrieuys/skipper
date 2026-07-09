import { describe, it, expect } from "bun:test";
import { forensicsTimeline } from "./forensicsTimeline";
import type { ForensicsTimelineEntry } from "./components";

describe("forensicsTimeline", () => {
  it("renders a known source with its label", () => {
    const html = forensicsTimeline([
      { source: "checkpoint", checkpoint_type: "REGRESSION", created_at: "2026-07-09 10:00:00" } as ForensicsTimelineEntry,
    ]);
    expect(html).toContain("Checkpoint: REGRESSION");
  });

  // Regression: icon/label were only assigned inside the source if/else
  // chain — an unknown source rendered the literal string "undefined".
  it("falls back gracefully for an unknown source", () => {
    const html = forensicsTimeline([
      { source: "mystery", event_type: "cosmic_ray", created_at: "2026-07-09 10:00:00" } as unknown as ForensicsTimelineEntry,
    ]);
    expect(html).toContain("cosmic_ray");
    expect(html).not.toContain("undefined");
  });
});
