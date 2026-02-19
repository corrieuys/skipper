import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const run = Bun.spawnSync({
  cmd: ["bun", "test", ...args],
  stdout: "inherit",
  stderr: "inherit",
});

const cleanupPatterns = [
  /^test-.*\.db(?:-(?:shm|wal|journal))?$/,
];

const cwd = process.cwd();
for (const name of readdirSync(cwd)) {
  if (!cleanupPatterns.some((pattern) => pattern.test(name))) continue;
  try {
    unlinkSync(join(cwd, name));
  } catch {
    // best-effort cleanup
  }
}

process.exit(run.exitCode ?? 1);
