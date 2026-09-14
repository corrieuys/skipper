import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
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

  test("resolves the theme symlink, wallpaper and a version that tracks both", () => {
    const themeA = join(dir, "themes", "a");
    mkdirSync(themeA, { recursive: true });
    writeFileSync(join(themeA, "colors.toml"), TOKYO);
    symlinkSync(themeA, join(dir, "theme"));
    expect(isOmarchyAvailable()).toBe(true);

    const noWallpaper = getOmarchyState()!;
    expect(noWallpaper.palette.background).toBe("#1a1b26");
    expect(noWallpaper.background).toBeNull();

    const img = join(dir, "themes", "a", "1.png");
    writeFileSync(img, "png");
    symlinkSync(img, join(dir, "background"));
    invalidateOmarchyState();
    const withWallpaper = getOmarchyState()!;
    expect(withWallpaper.background).toBe(realpathSync(img));
    expect(withWallpaper.version).not.toBe(noWallpaper.version);

    // Cached until invalidated.
    expect(getOmarchyState()).toBe(withWallpaper);
  });

  test("ignores a non-image background target", () => {
    const theme = join(dir, "t");
    mkdirSync(theme, { recursive: true });
    writeFileSync(join(theme, "colors.toml"), TOKYO);
    symlinkSync(theme, join(dir, "theme"));
    writeFileSync(join(theme, "notes.txt"), "x");
    symlinkSync(join(theme, "notes.txt"), join(dir, "background"));
    expect(getOmarchyState()!.background).toBeNull();
  });
});
