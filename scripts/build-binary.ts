#!/usr/bin/env bun
/**
 * Build standalone Skipper binaries with `bun build --compile`.
 *
 * Regenerates the embedded-asset manifest first (so newly added prompts/config/
 * public files are baked in), then cross-compiles one self-contained executable
 * per target into `dist/`. Each binary embeds the Bun runtime + all assets, so
 * it runs with no Bun install and no repo checkout.
 *
 *   bun run scripts/build-binary.ts            # all targets
 *   bun run scripts/build-binary.ts macos-arm64 linux-x64   # a subset
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const ENTRY = join(REPO, "bin", "cli.ts");
const DIST = join(REPO, "dist");

const pkg = (await Bun.file(join(REPO, "package.json")).json()) as { version: string };
// CI (release workflow) sets SKIPPER_VERSION from the git tag so the tag is the
// single source of version truth — the baked-in version matches the published
// release, which is what `skipper update` compares against. Falls back to
// package.json for local/dev builds.
const VERSION = process.env.SKIPPER_VERSION?.replace(/^v/, "") || pkg.version;

interface Target {
  label: string; // dist filename suffix
  bunTarget: string; // --target value
}

const TARGETS: Target[] = [
  { label: "macos-arm64", bunTarget: "bun-darwin-arm64" },
  { label: "linux-x64", bunTarget: "bun-linux-x64" },
  { label: "linux-arm64", bunTarget: "bun-linux-arm64" },
];

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: REPO });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

const wanted = process.argv.slice(2);
const targets = wanted.length
  ? TARGETS.filter((t) => wanted.includes(t.label))
  : TARGETS;
if (targets.length === 0) {
  console.error(`no matching targets. known: ${TARGETS.map((t) => t.label).join(", ")}`);
  process.exit(1);
}

// 1. Refresh the embedded-asset manifest.
console.log("→ regenerating embedded-asset manifest");
run("bun", ["run", join(REPO, "scripts", "gen-assets.ts")]);

// 2. Cross-compile each target.
mkdirSync(DIST, { recursive: true });
for (const t of targets) {
  const outfile = join(DIST, `skipper-${t.label}`);
  console.log(`\n→ building ${t.label} (${t.bunTarget}) v${VERSION}`);
  run("bun", [
    "build",
    "--compile",
    "--minify",
    `--target=${t.bunTarget}`,
    "--define",
    `__SKIPPER_VERSION__=${JSON.stringify(VERSION)}`,
    ENTRY,
    "--outfile",
    outfile,
  ]);
  const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ dist/skipper-${t.label}  (${mb} MB)`);
}

console.log(`\nDone. ${targets.length} binary(ies) in dist/ (v${VERSION}).`);
