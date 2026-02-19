import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("build-text-dataset", () => {
    it("moves successfully packed files to processed and leaves failed files behind", async () => {
        const tempDir = mkdtempSync("/tmp/build-text-dataset-");
        tempDirs.push(tempDir);

        writeFileSync(join(tempDir, "good-1.txt"), "input one\noutput one\n", "utf-8");
        writeFileSync(join(tempDir, "good-2.txt"), "input two\noutput two\n", "utf-8");
        writeFileSync(join(tempDir, "bad-1.txt"), "broken only one line\n", "utf-8");

        const proc = Bun.spawn(["bun", "run", "helpers/scripts/build-text-dataset.ts", tempDir], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Wrote 2 examples");
        expect(stdout).toContain("Moved 2 processed files");
        expect(stderr).toContain("bad-1.txt: model output is empty");

        expect(existsSync(join(tempDir, "messages.dataset.jsonl"))).toBe(true);
        expect(readdirSync(join(tempDir, "processed")).sort()).toEqual(["good-1.txt", "good-2.txt"]);
        expect(existsSync(join(tempDir, "bad-1.txt"))).toBe(true);
        expect(existsSync(join(tempDir, "good-1.txt"))).toBe(false);
        expect(existsSync(join(tempDir, "good-2.txt"))).toBe(false);
    });
});
