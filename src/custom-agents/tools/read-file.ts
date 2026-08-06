import { readFileSync, statSync } from "fs";
import { tool } from "ai";
import { z } from "zod";
import { resolveWithinWorkingDir } from "./paths";
import type { ToolContext } from "./types";

export const MAX_LINES_READ = 1000;
const MAX_LINE_CHARS = 2000;
/** Output cap, so one read of a minified bundle cannot blow the context window. */
const MAX_OUTPUT_CHARS = 60_000;

/**
 * Read a file, line-numbered.
 *
 * Contract ported from grok-build's `read_file` (target path, `offset`, `limit`,
 * 1000-line default). One deliberate deviation: grok anchors the line number on
 * the first line and every tenth, and leaves the rest bare. We prefix every line.
 * The sparse form is cheaper in tokens, but `search_replace` matches on exact
 * strings and the model has to strip the prefix itself — an unanchored line is
 * where that goes wrong. Full anchors make the two tools agree.
 */
export function readFileTool(ctx: ToolContext) {
  return tool({
    description: [
      "Read a file.",
      "",
      "Usage:",
      "- `path` can be relative to the working directory or absolute; it must stay inside the working directory",
      `- By default it reads up to ${MAX_LINES_READ} lines from the start of the file`,
      "- Every line is prefixed with `LINE_NUMBER→`. That prefix is not part of the file — when editing, match only what comes after the arrow",
      "- Long lines are truncated; a file longer than the limit reports how much was left",
    ].join("\n"),
    inputSchema: z.object({
      path: z.string().describe(
        "The path of the file to read. Relative to the working directory, or absolute.",
      ),
      offset: z.number().int().optional().describe(
        "The line number to start reading from. Only provide if the file is too large to read at once.",
      ),
      limit: z.number().int().optional().describe(
        "The number of lines to read. Only provide if the file is too large to read at once.",
      ),
    }),
    execute: async ({ path, offset, limit }) => {
      const target = resolveWithinWorkingDir(ctx.workingDir, path);

      const stat = statSync(target);
      if (stat.isDirectory()) throw new Error(`${path} is a directory, not a file. Use list_dir.`);

      const content = readFileSync(target, "utf-8");
      const lines = content.split("\n");
      // A trailing newline produces a final empty field that is not a line.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      const start = Math.max(1, offset ?? 1);
      const count = Math.max(1, Math.min(limit ?? MAX_LINES_READ, MAX_LINES_READ));
      const slice = lines.slice(start - 1, start - 1 + count);

      if (slice.length === 0) {
        return `${path} has ${lines.length} lines; offset ${start} is past the end.`;
      }

      const out: string[] = [];
      let chars = 0;
      let emitted = 0;
      for (let i = 0; i < slice.length; i++) {
        const raw = slice[i] ?? "";
        const text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}… [line truncated]` : raw;
        const rendered = `${start + i}→${text}`;
        if (chars + rendered.length > MAX_OUTPUT_CHARS) break;
        out.push(rendered);
        chars += rendered.length + 1;
        emitted++;
      }

      const lastLine = start + emitted - 1;
      const remaining = lines.length - lastLine;
      if (remaining > 0) {
        out.push("");
        out.push(`[${remaining} more line(s). Read from offset ${lastLine + 1} to continue.]`);
      }
      return out.join("\n");
    },
  });
}
