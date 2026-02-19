import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import matter from "gray-matter";

export interface SkillEntry {
  name: string;
  description: string;
  autoInvoke?: boolean;
  scope: "user" | "project";
  content: string;
  filePath: string;
}

export interface SkillsByProvider {
  claudeCode: SkillEntry[];
  codex: SkillEntry[];
}

const PROJECT_ROOT = process.cwd();

function scanSkillsDir(dir: string, scope: "user" | "project"): SkillEntry[] {
  if (!existsSync(dir)) return [];

  const entries: SkillEntry[] = [];
  let subdirs: string[];
  try {
    subdirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const skillDirName of subdirs) {
    const skillMdPath = join(dir, skillDirName, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const raw = readFileSync(skillMdPath, "utf-8");
      const { data, content } = matter(raw);
      entries.push({
        name: (data.name as string) ?? skillDirName,
        description: (data.description as string) ?? "",
        autoInvoke: data.autoInvoke as boolean | undefined,
        scope,
        content,
        filePath: skillMdPath,
      });
    } catch {
      // Gracefully skip unparseable SKILL.md files
    }
  }

  return entries;
}

export function readAllSkills(): SkillsByProvider {
  const home = homedir();

  const claudeCodeSkills: SkillEntry[] = [
    ...scanSkillsDir(join(home, ".claude", "skills"), "user"),
    ...scanSkillsDir(join(PROJECT_ROOT, ".claude", "skills"), "project"),
  ];

  const codexSkills: SkillEntry[] = [
    ...scanSkillsDir(join(home, ".agents", "skills"), "user"),
    ...scanSkillsDir(join(PROJECT_ROOT, ".agents", "skills"), "project"),
  ];

  return {
    claudeCode: claudeCodeSkills,
    codex: codexSkills,
  };
}

export function buildSkillsPromptAddition(agentProvider: string): string {
  const allSkills = readAllSkills();

  const providerKey: keyof SkillsByProvider = agentProvider === "codex" ? "codex" : "claudeCode";
  const providerSkills = allSkills[providerKey];
  if (providerSkills.length === 0) return "";

  const parts: string[] = ["\n## Skills Guidance", "Consider using the following skills when relevant:"];
  for (const s of providerSkills) {
    parts.push(`- **${s.name}**: ${s.description}`);
  }
  return parts.join("\n");
}
