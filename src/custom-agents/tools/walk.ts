import { readdir } from "fs/promises";
import { join } from "path";

/**
 * Directories never worth walking. Deliberately a small fixed list rather than a
 * .gitignore parser: these tools run on the daemon's event loop, so the cost that
 * matters is the walk itself, and node_modules/.git are what make it unbounded.
 */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "target", "vendor",
  ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage", ".bun",
]);

export interface WalkOptions {
  /** Stop after this many files have been yielded to the visitor. */
  maxFiles: number;
  /** Do not descend past this depth below the root. */
  maxDepth?: number;
}

/**
 * Breadth-first file walk under `root`, yielding absolute paths. Stops as soon as
 * `maxFiles` files have been visited, so a caller can bound its own output
 * without walking a whole monorepo first.
 */
export async function walkFiles(
  root: string,
  options: WalkOptions,
  visit: (absolutePath: string) => void | Promise<void>,
): Promise<{ visited: number; truncated: boolean }> {
  const maxDepth = options.maxDepth ?? 20;
  let visited = 0;
  let queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of queue) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable dir — skip rather than fail the whole search
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (depth + 1 <= maxDepth) next.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        if (visited >= options.maxFiles) return { visited, truncated: true };
        visited++;
        await visit(full);
      }
    }
    queue = next;
  }
  return { visited, truncated: false };
}

/** Glob-to-RegExp supporting `*`, `**`, `?` and `{a,b}`, anchored whole-path. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` spans any number of directories, including none.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
      } else {
        const alts = pattern.slice(i + 1, end).split(",").map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${alts.join("|")})`;
        i = end;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}
