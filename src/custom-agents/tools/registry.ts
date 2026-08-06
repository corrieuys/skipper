import type { Tool } from "ai";
import { readFileTool } from "./read-file";
import { searchReplaceTool } from "./search-replace";
import { listDirTool } from "./list-dir";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import type { ToolContext } from "./types";

export interface LocalToolSpec {
  /** Stable id — persisted in `custom_agents.enabled_tools`, so never rename one. */
  id: string;
  label: string;
  /** One line for the agent editor checkbox. */
  description: string;
  /** True when the tool can change the filesystem — the UI flags these. */
  writes: boolean;
  factory: (ctx: ToolContext) => Tool;
}

/**
 * Every tool Skipper implements itself, in the order the agent editor shows them.
 *
 * Adding one is a single entry here: the agent editor renders from this list and
 * the runner filters against it, so nothing else needs to know the tool exists.
 * Contracts for the file tools are ported from xAI's grok-build (Apache-2.0).
 */
export const LOCAL_TOOLS: LocalToolSpec[] = [
  {
    id: "read_file",
    label: "Read file",
    description: "Read a file with line numbers, with offset and limit for large files.",
    writes: false,
    factory: readFileTool,
  },
  {
    id: "search_replace",
    label: "Write / edit file",
    description: "Replace an exact string in a file, or create a new file. This is both write and edit.",
    writes: true,
    factory: searchReplaceTool,
  },
  {
    id: "list_dir",
    label: "List directory",
    description: "List the contents of one directory.",
    writes: false,
    factory: listDirTool,
  },
  {
    id: "glob",
    label: "Find files",
    description: "Find files by path pattern, e.g. src/**/*.ts.",
    writes: false,
    factory: globTool,
  },
  {
    id: "grep",
    label: "Search contents",
    description: "Search file contents with a regular expression.",
    writes: false,
    factory: grepTool,
  },
];

export function localToolIds(): string[] {
  return LOCAL_TOOLS.map((t) => t.id);
}

/**
 * Build the local tool map for a run, containing ONLY the enabled ids.
 *
 * The filter is applied here rather than through the AI SDK's `activeTools`
 * because a disabled tool must not reach the request at all — `activeTools`
 * narrows what the model may call, but still describes what exists.
 */
export function buildLocalTools(enabledIds: string[], ctx: ToolContext): Record<string, Tool> {
  const enabled = new Set(enabledIds);
  const tools: Record<string, Tool> = {};
  for (const spec of LOCAL_TOOLS) {
    if (enabled.has(spec.id)) tools[spec.id] = spec.factory(ctx);
  }
  return tools;
}
