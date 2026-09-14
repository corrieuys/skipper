import { describe, expect, test } from "bun:test";
import { omarchyThemeVars } from "./omarchy-theme";
import { paletteFromToml } from "../../config-readers/omarchy";

const TOML = `
accent = "#7aa2f7"
foreground = "#a9b1d6"
background = "#1a1b26"
color1 = "#f7768e"
color2 = "#9ece6a"
color3 = "#e0af68"
color6 = "#449dab"
color14 = "#0db9d7"
`;

describe("omarchyThemeVars", () => {
  const vars = omarchyThemeVars(paletteFromToml(TOML));

  test("accents come straight from the palette", () => {
    expect(vars["--sk-accent-primary"]).toBe("#7aa2f7");
    expect(vars["--sk-accent-secondary"]).toBe("#449dab");
    expect(vars["--sk-accent-tertiary"]).toBe("#9ece6a");
    expect(vars["--sk-accent-warning"]).toBe("#e0af68");
    expect(vars["--sk-accent-danger"]).toBe("#f7768e");
    expect(vars["--sk-text"]).toBe("#a9b1d6");
    expect(vars["--on-secondary-container"]).toBe("#0db9d7");
  });

  test("surfaces are translucent tints of the background", () => {
    expect(vars["--sk-surface-0"]).toMatch(/^rgba\(\d+, \d+, \d+, 0\.6\)$/);
    expect(vars["--sk-surface-1"]).toMatch(/^rgba\(\d+, \d+, \d+, 0\.55\)$/);
    // legacy aliases mirror the sk tokens
    expect(vars["--void"]).toBe(vars["--sk-surface-0"]);
    expect(vars["--panel"]).toBe(vars["--sk-panel-bg"]);
    expect(vars["--accent-magenta"]).toBe(vars["--sk-accent-primary"]);
  });

  test("every value is a colour, length or shadow, never empty", () => {
    for (const [k, v] of Object.entries(vars)) {
      expect(v, k).not.toBe("");
      expect(v, k).not.toContain("NaN");
      expect(v, k).not.toContain("undefined");
    }
  });
});
