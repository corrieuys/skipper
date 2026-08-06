import { tool } from "ai";
import { z } from "zod";
import { displayPath, resolveWithinWorkingDir } from "./paths";
import { globToRegExp, walkFiles } from "./walk";
import type { ToolContext } from "./types";

const MAX_RESULTS = 200;
const MAX_FILES_SCANNED = 20_000;

/** Find files by path pattern. Paired with grep, which searches their contents. */
export function globTool(ctx: ToolContext) {
  return tool({
    description: [
      "Find files whose path matches a glob pattern, e.g. `src/**/*.ts` or `**/{README,CHANGELOG}.md`.",
      "Supports `*`, `**`, `?` and `{a,b}`. Matches against the path relative to the working directory.",
      "Common build and dependency directories (.git, node_modules, dist, …) are skipped.",
    ].join("\n"),
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern to match paths against."),
      path: z.string().optional().describe(
        "Directory to search in, relative to the working directory. Defaults to the working directory.",
      ),
    }),
    execute: async ({ pattern, path }) => {
      const root = resolveWithinWorkingDir(ctx.workingDir, path || ".");
      const re = globToRegExp(pattern);
      const matches: string[] = [];

      const { truncated } = await walkFiles(root, { maxFiles: MAX_FILES_SCANNED }, (file) => {
        if (matches.length >= MAX_RESULTS) return;
        const rel = displayPath(ctx.workingDir, file);
        if (re.test(rel) || re.test(displayPath(root, file))) matches.push(rel);
      });

      if (matches.length === 0) {
        return `No files match ${pattern}${truncated ? " (search stopped at the scan limit — narrow the path)" : ""}.`;
      }
      matches.sort();
      const head = matches.slice(0, MAX_RESULTS);
      const note = matches.length > MAX_RESULTS || truncated
        ? `\n\n[showing ${head.length} results; narrow the pattern to see more]`
        : "";
      return head.join("\n") + note;
    },
  });
}
