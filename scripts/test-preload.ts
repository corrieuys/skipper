import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CLEANUP_PATTERNS = [
  /^test-.*\.db(?:-(?:shm|wal|journal))?$/,
];

function cleanupTestDatabases(): void {
  const cwd = process.cwd();
  for (const name of readdirSync(cwd)) {
    if (!CLEANUP_PATTERNS.some((pattern) => pattern.test(name))) continue;
    try {
      unlinkSync(join(cwd, name));
    } catch {
      // best-effort cleanup
    }
  }
}

// Run once before tests start to clear stale files from prior crashes/runs.
cleanupTestDatabases();

// Also run at process end so direct `bun test` invocations clean up too.
process.on("exit", cleanupTestDatabases);
