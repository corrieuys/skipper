import { afterEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readAllSkills } from "./skills";

const projectSkillsRoot = join(process.cwd(), ".agents", "skills");

const cleanupPaths: string[] = [];

afterEach(() => {
    while (cleanupPaths.length > 0) {
        const path = cleanupPaths.pop();
        if (!path) continue;
        try {
            rmSync(path, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup for test artifacts.
        }
    }
});

describe("readAllSkills", () => {
    it("includes skills from symlinked project skill directories", () => {
        const targetDir = mkdtempSync(join(tmpdir(), "skill-target-"));
        cleanupPaths.push(targetDir);

        const skillDir = join(targetDir, "linked-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
            join(skillDir, "SKILL.md"),
            [
                "---",
                "name: symlinked-skill-for-test",
                "description: discovered through a symlink",
                "---",
                "",
                "Skill body.",
            ].join("\n"),
            "utf-8",
        );

        const createdAgentsRoot = !existsSync(join(process.cwd(), ".agents"));
        const createdSkillsRoot = !existsSync(projectSkillsRoot);
        if (createdSkillsRoot) {
            mkdirSync(projectSkillsRoot, { recursive: true });
        }

        const symlinkPath = join(projectSkillsRoot, "symlinked-skill-entry");
        symlinkSync(skillDir, symlinkPath, "dir");

        cleanupPaths.push(symlinkPath);
        if (createdSkillsRoot) cleanupPaths.push(projectSkillsRoot);
        if (createdAgentsRoot) cleanupPaths.push(join(process.cwd(), ".agents"));

        const skills = readAllSkills();
        const found = skills.codex.find((s) => s.name === "symlinked-skill-for-test");

        expect(found).toBeDefined();
        expect(found?.scope).toBe("project");
    });
});