import { readFile } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { displayPath, resolveWithinWorkingDir } from "./paths";
import { globToRegExp, walkFiles } from "./walk";
import type { ToolContext } from "./types";

const MAX_MATCHES = 100;
const MAX_FILES_SCANNED = 5_000;
/** Skip anything this large — a match inside a bundle or a lockfile is noise. */
const MAX_FILE_BYTES = 1_000_000;

/** Search file contents by regex. Paired with glob, which searches their paths. */
export function grepTool(ctx: ToolContext) {
  return tool({
    description: [
      "Search file contents with a regular expression and return matching lines with their file and line number.",
      "Use `include` to restrict the search by path glob, e.g. `**/*.ts`.",
      "Common build and dependency directories (.git, node_modules, dist, …) are skipped, as are files over 1 MB.",
    ].join("\n"),
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for."),
      path: z.string().optional().describe(
        "Directory to search in, relative to the working directory. Defaults to the working directory.",
      ),
      include: z.string().optional().describe("Only search files whose path matches this glob, e.g. `**/*.ts`."),
      case_sensitive: z.boolean().optional().describe("Match case-sensitively (default false)."),
    }),
    execute: async ({ pattern, path, include, case_sensitive }) => {
      const root = resolveWithinWorkingDir(ctx.workingDir, path || ".");

      let re: RegExp;
      try {
        re = new RegExp(pattern, case_sensitive ? "" : "i");
      } catch (err) {
        throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
      }
      const includeRe = include ? globToRegExp(include) : null;

      const hits: string[] = [];
      let filesWithHits = 0;

      const { truncated } = await walkFiles(root, { maxFiles: MAX_FILES_SCANNED }, async (file) => {
        if (hits.length >= MAX_MATCHES) return;
        const rel = displayPath(ctx.workingDir, file);
        if (includeRe && !includeRe.test(rel) && !includeRe.test(displayPath(root, file))) return;

        let content: string;
        try {
          const buf = await readFile(file);
          if (buf.byteLength > MAX_FILE_BYTES) return;
          // Skip binaries: a NUL in the first block is the usual heuristic.
          if (buf.subarray(0, 8000).includes(0)) return;
          content = buf.toString("utf-8");
        } catch {
          return;
        }

        let fileHad = false;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= MAX_MATCHES) break;
          const line = lines[i]!;
          if (!re.test(line)) continue;
          fileHad = true;
          const text = line.length > 300 ? `${line.slice(0, 300)}…` : line;
          hits.push(`${rel}:${i + 1}: ${text.trim()}`);
        }
        if (fileHad) filesWithHits++;
      });

      if (hits.length === 0) {
        return `No matches for /${pattern}/${truncated ? " (search stopped at the scan limit — narrow the path or include)" : ""}.`;
      }
      const note = hits.length >= MAX_MATCHES || truncated
        ? `\n\n[showing the first ${hits.length} matches across ${filesWithHits} file(s); narrow the search to see more]`
        : `\n\n[${hits.length} match(es) across ${filesWithHits} file(s)]`;
      return hits.join("\n") + note;
    },
  });
}
