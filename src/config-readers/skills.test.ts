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

    it("never evaluates js/javascript front matter and skips that skill", () => {
        const marker = globalThis as { __skillFrontMatterEval?: string };
        delete marker.__skillFrontMatterEval;

        const createdAgentsRoot = !existsSync(join(process.cwd(), ".agents"));
        const createdSkillsRoot = !existsSync(projectSkillsRoot);
        mkdirSync(projectSkillsRoot, { recursive: true });
        if (createdSkillsRoot) cleanupPaths.push(projectSkillsRoot);
        if (createdAgentsRoot) cleanupPaths.push(join(process.cwd(), ".agents"));

        // gray-matter picks the engine from the text after the opening
        // delimiter; `js`/`javascript` (any case) would `eval` the block.
        for (const lang of ["js", "javascript", "JS", "JavaScript"]) {
            const skillDir = mkdtempSync(join(projectSkillsRoot, "eval-front-matter-"));
            cleanupPaths.push(skillDir);
            writeFileSync(
                join(skillDir, "SKILL.md"),
                [
                    `---${lang}`,
                    `{ name: (globalThis.__skillFrontMatterEval = "${lang}", "eval-skill-${lang}"), description: "looks normal" }`,
                    "---",
                    "Skill body.",
                ].join("\n"),
                "utf-8",
            );
        }
        const yamlDir = mkdtempSync(join(projectSkillsRoot, "yaml-front-matter-"));
        cleanupPaths.push(yamlDir);
        writeFileSync(
            join(yamlDir, "SKILL.md"),
            ["---", "name: yaml-skill-for-test", "description: plain yaml", "---", "", "Skill body."].join("\n"),
            "utf-8",
        );

        try {
            const skills = readAllSkills();

            expect(marker.__skillFrontMatterEval).toBeUndefined();
            expect(skills.codex.some((s) => s.filePath.includes("eval-front-matter-"))).toBe(false);
            expect(skills.codex.find((s) => s.name === "yaml-skill-for-test")?.description).toBe("plain yaml");
        } finally {
            delete marker.__skillFrontMatterEval;
        }
    });
});