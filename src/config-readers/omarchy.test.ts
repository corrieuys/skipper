import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseColorsToml, paletteFromToml, getOmarchyState, invalidateOmarchyState, isOmarchyAvailable } from "./omarchy";

const TOKYO = `
accent = "#7aa2f7"
cursor = "#c0caf5"
foreground = "#a9b1d6"
background = "#1a1b26" # trailing comment
selection_foreground = "#c0caf5"
selection_background = "#7aa2f7"

color0 = "#32344a"
color1 = "#f7768e"
color2 = "#9ece6a"
color3 = "#e0af68"
color4 = "#7aa2f7"
color5 = "#ad8ee6"
color6 = "#449dab"
color7 = "#787c99"
color8 = "#444b6a"
color9 = "#ff7a93"
color10 = "#b9f27c"
color11 = "#ff9e64"
color12 = "#7da6ff"
color13 = "#bb9af7"
color14 = "#0db9d7"
color15 = "#acb0d0"
`;

describe("parseColorsToml", () => {
  test("reads quoted values, skips comments and blank lines", () => {
    const kv = parseColorsToml(TOKYO);
    expect(kv.background).toBe("#1a1b26");
    expect(kv.color15).toBe("#acb0d0");
    expect(kv.accent).toBe("#7aa2f7");
  });

  test("tolerates unquoted values and inline comments", () => {
    const kv = parseColorsToml('mode = light # marker\nfoo = "bar"');
    expect(kv.mode).toBe("light");
    expect(kv.foo).toBe("bar");
  });
});

describe("paletteFromToml", () => {
  test("maps the palette and defaults mode to dark", () => {
    const p = paletteFromToml(TOKYO);
    expect(p.background).toBe("#1a1b26");
    expect(p.foreground).toBe("#a9b1d6");
    expect(p.accent).toBe("#7aa2f7");
    expect(p.colors).toHaveLength(16);
    expect(p.colors[6]).toBe("#449dab");
    expect(p.mode).toBe("dark");
  });

  test("falls back for missing or malformed colours", () => {
    const p = paletteFromToml('background = "#000"\ncolor1 = "nope"');
    expect(p.background).toBe("#000000");
    expect(p.foreground).toBe("#ffffff");
    expect(p.accent).toBe("#ffffff");
    expect(p.colors[1]).toBe("#ffffff");
  });

  test("aliases semantic names to colorN for staged themes without colorN keys", () => {
    // Real staged themes (e.g. Catppuccin) ship semantic names only.
    const p = paletteFromToml(`
background = "#1e1e2e"
foreground = "#cdd6f4"
accent = "#89b4fa"
muted = "#585b70"
red = "#f38ba8"
green = "#a6e3a1"
yellow = "#f9e2af"
blue = "#89b4fa"
magenta = "#f5c2e7"
cyan = "#94e2d5"
bright_red = "#f38ba8"
bright_green = "#a6e3a1"
bright_yellow = "#f9e2af"
bright_blue = "#89b4fa"
bright_magenta = "#f5c2e7"
bright_cyan = "#94e2d5"
bright_foreground = "#cdd6f4"
`);
    expect(p.colors[0]).toBe("#1e1e2e");
    expect(p.colors[1]).toBe("#f38ba8");
    expect(p.colors[2]).toBe("#a6e3a1");
    expect(p.colors[3]).toBe("#f9e2af");
    expect(p.colors[4]).toBe("#89b4fa");
    expect(p.colors[5]).toBe("#f5c2e7");
    expect(p.colors[6]).toBe("#94e2d5");
    expect(p.colors[7]).toBe("#cdd6f4");
    expect(p.colors[8]).toBe("#585b70");
    expect(p.colors[14]).toBe("#94e2d5");
    expect(p.colors[15]).toBe("#cdd6f4");
  });

  test("light.mode marker or mode key flags light", () => {
    expect(paletteFromToml(TOKYO, true).mode).toBe("light");
    expect(paletteFromToml(`${TOKYO}\nmode = "light"`).mode).toBe("light");
  });
});

describe("getOmarchyState", () => {
  let dir: string;
  const prev = process.env.OMARCHY_CURRENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omarchy-"));
    process.env.OMARCHY_CURRENT_DIR = dir;
    invalidateOmarchyState();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.OMARCHY_CURRENT_DIR;
    else process.env.OMARCHY_CURRENT_DIR = prev;
    invalidateOmarchyState();
    rmSync(dir, { recursive: true, force: true });
  });

  test("null when no theme is selected", () => {
    expect(isOmarchyAvailable()).toBe(false);
    expect(getOmarchyState()).toBeNull();
  });

  test("resolves the theme symlink and versions the palette", () => {
    const themeA = join(dir, "themes", "a");
    mkdirSync(themeA, { recursive: true });
    writeFileSync(join(themeA, "colors.toml"), TOKYO);
    symlinkSync(themeA, join(dir, "theme"));
    expect(isOmarchyAvailable()).toBe(true);

    const first = getOmarchyState()!;
    expect(first.palette.background).toBe("#1a1b26");
    expect(first.palette.colors[6]).toBe("#449dab");

    // Cached until invalidated.
    expect(getOmarchyState()).toBe(first);

    // A theme content change bumps the version.
    invalidateOmarchyState();
    writeFileSync(join(themeA, "colors.toml"), TOKYO.replace("#1a1b26", "#000000"));
    const second = getOmarchyState()!;
    expect(second.palette.background).toBe("#000000");
    expect(second.version).not.toBe(first.version);
  });

  test("ignores a stray background symlink", () => {
    const theme = join(dir, "t");
    mkdirSync(theme, { recursive: true });
    writeFileSync(join(theme, "colors.toml"), TOKYO);
    symlinkSync(theme, join(dir, "theme"));
    writeFileSync(join(theme, "notes.txt"), "x");
    symlinkSync(join(theme, "notes.txt"), join(dir, "background"));
    const state = getOmarchyState()!;
    expect(state.palette.background).toBe("#1a1b26");
    expect("background" in state).toBe(false);
  });
});
