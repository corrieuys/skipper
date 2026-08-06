import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import { tool } from "ai";
import { z } from "zod";
import { resolveWithinWorkingDir } from "./paths";
import type { ToolContext } from "./types";

/**
 * Replace an exact string in a file — this is both the write tool and the edit
 * tool, as in grok-build's `search_replace`.
 *
 * Two rules carry the safety, and both are enforced rather than merely described:
 * `old_string` must match exactly once (otherwise the model is guessing which
 * occurrence it meant), and an empty `old_string` creates a file but will not
 * overwrite an existing non-empty one (grok gates that behind an opt-in flag;
 * clobbering a file on an empty match is not a default worth having).
 */
export function searchReplaceTool(ctx: ToolContext) {
  return tool({
    description: [
      "Replace an exact string in a file.",
      "",
      "- `read_file` prefixes each line with \"LINE_NUMBER→\". That prefix is not part of the file: match only what comes after the arrow, with its exact indentation.",
      "- `old_string` must match exactly one place in the file. If it appears more than once, add surrounding lines to make it unique, or set `replace_all` to change every occurrence (handy for renaming an identifier).",
      "- To create a new file, set `old_string` to an empty string. An empty `old_string` cannot overwrite an existing non-empty file.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z.string().describe(
        "The path to the file to modify. Relative to the working directory, or absolute.",
      ),
      old_string: z.string().describe("The text to replace"),
      new_string: z.string().describe("The text to replace it with (must be different from old_string)"),
      replace_all: z.boolean().optional().describe("Replace all occurrences of old_string (default false)"),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all }) => {
      const target = resolveWithinWorkingDir(ctx.workingDir, file_path);

      if (old_string === new_string) {
        throw new Error("old_string and new_string are identical — nothing to do");
      }

      const exists = existsSync(target);
      if (exists && statSync(target).isDirectory()) {
        throw new Error(`${file_path} is a directory`);
      }

      if (old_string === "") {
        if (exists && readFileSync(target, "utf-8") !== "") {
          throw new Error(
            `${file_path} already exists and is not empty. An empty old_string cannot overwrite it — read the file and replace a specific string instead.`,
          );
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, new_string, "utf-8");
        return `Created ${file_path} (${new_string.split("\n").length} lines).`;
      }

      if (!exists) throw new Error(`${file_path} does not exist`);
      const content = readFileSync(target, "utf-8");

      let occurrences = 0;
      let idx = content.indexOf(old_string);
      while (idx !== -1) {
        occurrences++;
        idx = content.indexOf(old_string, idx + old_string.length);
      }

      if (occurrences === 0) {
        throw new Error(
          `old_string was not found in ${file_path}. Read the file again — it may have changed, or the indentation may differ.`,
        );
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string matches ${occurrences} places in ${file_path}. Add surrounding lines to make it unique, or set replace_all to true.`,
        );
      }

      const updated = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);
      writeFileSync(target, updated, "utf-8");

      return replace_all
        ? `Replaced ${occurrences} occurrence(s) in ${file_path}.`
        : `Replaced 1 occurrence in ${file_path}.`;
    },
  });
}
