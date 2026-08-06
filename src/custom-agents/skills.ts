import { tool, type Tool } from "ai";
import { z } from "zod";
import { readAllSkills, type SkillEntry } from "../config-readers/skills";

/**
 * Skills for custom agents, using progressive disclosure: the system prompt
 * carries only each enabled skill's name and one-line description, and the model
 * pulls the body with `load_skill` when it decides one applies.
 *
 * Inlining every body would be simpler but wrong — a handful of skills is tens of
 * thousands of tokens on every turn, most of it never relevant to the task.
 */

/** Every skill on this machine, deduped by name across providers. */
export function listAvailableSkills(): SkillEntry[] {
  const all = readAllSkills();
  const byName = new Map<string, SkillEntry>();
  for (const skill of [...all.claudeCode, ...all.codex]) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function enabledSkills(names: string[]): SkillEntry[] {
  const wanted = new Set(names);
  return listAvailableSkills().filter((s) => wanted.has(s.name));
}

/** The index block appended to the system prompt, or "" when nothing is enabled. */
export function buildSkillsIndex(names: string[]): string {
  const skills = enabledSkills(names);
  if (skills.length === 0) return "";

  const lines = [
    "## Skills",
    "",
    "Reference material available to you. Each entry is a title and a summary; call `load_skill` with the name to read the full instructions before acting on one.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`- **${skill.name}**: ${skill.description || "(no description)"}`);
  }
  return lines.join("\n");
}

/**
 * The `load_skill` tool, or null when the agent has no skills enabled — an agent
 * with nothing to load must not be told the tool exists.
 */
export function buildSkillTool(names: string[]): Record<string, Tool> {
  const skills = enabledSkills(names);
  if (skills.length === 0) return {};

  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    load_skill: tool({
      description: `Read the full instructions for one of the skills listed in your system prompt. Available: ${skills.map((s) => s.name).join(", ")}.`,
      inputSchema: z.object({
        name: z.string().describe("The skill name, exactly as listed in the system prompt."),
      }),
      execute: async ({ name }) => {
        const skill = byName.get(name);
        if (!skill) {
          throw new Error(`Unknown skill "${name}". Available: ${[...byName.keys()].join(", ")}`);
        }
        return skill.content;
      },
    }),
  };
}
