#!/usr/bin/env bun
/**
 * Prepare a release: build the binaries for the CURRENT package.json version,
 * write SHA256SUMS, then print the manual publish commands.
 *
 * Publishing is fully manual by design — this script performs NO git or gh
 * writes (no commit, tag, push, or release create). It only produces artifacts
 * in dist/ and tells you exactly what to run next.
 *
 *   1. bump the version in package.json yourself
 *   2. bun run release          # builds dist/ + prints the publish recipe
 *   3. copy-paste the printed git/gh commands when you're ready
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const REPO_DIR = resolve(import.meta.dir, "..");
const DIST = join(REPO_DIR, "dist");
const GH_REPO = "corrieuys/skipper";
const TARGETS = ["skipper-macos-arm64", "skipper-linux-x64", "skipper-linux-arm64"];

function sh(cmd: string, args: string[], capture = false): string {
  const r = spawnSync(cmd, args, {
    cwd: REPO_DIR,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
  return (r.stdout ?? "").trim();
}

const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8")) as { version: string };
const version = pkg.version;
const tag = `v${version}`;

// Warn (do not block) if this version is already tagged — a nudge to bump first.
const existingTag = sh("git", ["tag", "--list", tag], true);
if (existingTag) {
  console.warn(`⚠ tag ${tag} already exists. Bump the version in package.json before releasing, or delete the tag.\n`);
}

// 1. Build all target binaries (regenerates the embedded-asset manifest inside).
console.log(`→ building binaries for ${tag}`);
sh("bun", ["run", join(REPO_DIR, "scripts", "build-binary.ts")]);

// 2. Checksums.
const sums =
  TARGETS.map((t) => {
    const hash = createHash("sha256").update(readFileSync(join(DIST, t))).digest("hex");
    return `${hash}  ${t}`;
  }).join("\n") + "\n";
writeFileSync(join(DIST, "SHA256SUMS"), sums);
console.log("→ wrote dist/SHA256SUMS");

// 3. Print the manual publish recipe. Nothing below runs automatically.
const assets = [...TARGETS.map((t) => `dist/${t}`), "dist/SHA256SUMS"].join(" ");
console.log(`
Artifacts ready in dist/ for ${tag}. Publish manually when you're ready:

  git add -A
  git commit -m "release ${tag}"
  git tag ${tag}
  git push origin HEAD --tags
  gh release create ${tag} ${assets} --title "${tag}" --generate-notes

Then anyone can install / update:
  curl -fsSL https://raw.githubusercontent.com/${GH_REPO}/main/install.sh | bash
  skipper update
`);
