import { readdirSync, statSync } from "fs";
import { join } from "path";
import { tool } from "ai";
import { z } from "zod";
import { displayPath, resolveWithinWorkingDir } from "./paths";
import type { ToolContext } from "./types";

/** Output budget, matching grok-build's list_dir default. */
const MAX_OUTPUT_CHARS = 10_000;

/** Contract ported from grok-build's `list_dir`: one directory, char-budgeted. */
export function listDirTool(ctx: ToolContext) {
  return tool({
    description:
      "List the contents of a directory. Not recursive — call again on a subdirectory, or use glob to match paths across the tree.",
    inputSchema: z.object({
      target_directory: z.string().describe(
        "Path to the directory to list, relative to the working directory or absolute. Use \".\" for the working directory itself.",
      ),
    }),
    execute: async ({ target_directory }) => {
      const target = resolveWithinWorkingDir(ctx.workingDir, target_directory || ".");
      if (!statSync(target).isDirectory()) throw new Error(`${target_directory} is not a directory`);

      const entries = readdirSync(target, { withFileTypes: true })
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const lines: string[] = [`${displayPath(ctx.workingDir, target)}/`];
      let chars = lines[0]!.length;
      let shown = 0;
      for (const entry of entries) {
        let rendered: string;
        if (entry.isDirectory()) {
          rendered = `  ${entry.name}/`;
        } else {
          let size = 0;
          try { size = statSync(join(target, entry.name)).size; } catch { /* raced away */ }
          rendered = `  ${entry.name} (${formatSize(size)})`;
        }
        if (chars + rendered.length > MAX_OUTPUT_CHARS) break;
        lines.push(rendered);
        chars += rendered.length + 1;
        shown++;
      }

      if (shown < entries.length) {
        lines.push(`  … ${entries.length - shown} more entr(ies) not shown`);
      }
      if (entries.length === 0) lines.push("  (empty)");
      return lines.join("\n");
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
