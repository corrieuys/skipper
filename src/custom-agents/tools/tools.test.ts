import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildLocalTools, LOCAL_TOOLS, localToolIds } from "./registry";
import { resolveWithinWorkingDir } from "./paths";
import { globToRegExp } from "./walk";

let root: string;

/** Invoke a tool the way the AI SDK does, bypassing its call-options plumbing. */
async function call(id: string, input: unknown): Promise<string> {
  const tools = buildLocalTools(localToolIds(), { workingDir: root });
  const tool = tools[id];
  if (!tool?.execute) throw new Error(`tool ${id} has no execute`);
  const result = await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {});
  return String(result);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skipper-tools-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("path containment", () => {
  it("resolves relative and absolute paths inside the working directory", () => {
    expect(resolveWithinWorkingDir(root, "a/b.txt")).toBe(join(root, "a/b.txt"));
    expect(resolveWithinWorkingDir(root, join(root, "a/b.txt"))).toBe(join(root, "a/b.txt"));
  });

  it("refuses to leave the working directory", () => {
    expect(() => resolveWithinWorkingDir(root, "../outside.txt")).toThrow(/escapes the working directory/);
    expect(() => resolveWithinWorkingDir(root, "a/../../outside.txt")).toThrow(/escapes the working directory/);
    expect(() => resolveWithinWorkingDir(root, "/etc/passwd")).toThrow(/escapes the working directory/);
  });

  // `..foo` is a normal name, not a traversal — the guard must key on the
  // separator, not on the string starting with two dots.
  it("allows a path whose name merely starts with dots", () => {
    expect(resolveWithinWorkingDir(root, "..foo")).toBe(join(root, "..foo"));
  });

  it("rejects an empty path", () => {
    expect(() => resolveWithinWorkingDir(root, "  ")).toThrow(/empty/);
  });
});

describe("read_file", () => {
  it("prefixes every line with its number", async () => {
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    const out = await call("read_file", { path: "a.txt" });
    expect(out).toBe("1→one\n2→two\n3→three");
  });

  it("honours offset and limit and reports what is left", async () => {
    writeFileSync(join(root, "a.txt"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
    const out = await call("read_file", { path: "a.txt", offset: 10, limit: 2 });
    expect(out).toContain("10→line 10");
    expect(out).toContain("11→line 11");
    expect(out).not.toContain("12→line 12");
    expect(out).toContain("39 more line(s)");
    expect(out).toContain("offset 12");
  });

  it("reports an offset past the end rather than returning nothing", async () => {
    writeFileSync(join(root, "a.txt"), "one\n");
    expect(await call("read_file", { path: "a.txt", offset: 99 })).toContain("past the end");
  });

  it("refuses a path outside the working directory", async () => {
    await expect(call("read_file", { path: "../secrets.txt" })).rejects.toThrow(/escapes the working directory/);
  });

  it("points at list_dir when handed a directory", async () => {
    mkdirSync(join(root, "sub"));
    await expect(call("read_file", { path: "sub" })).rejects.toThrow(/list_dir/);
  });
});

describe("search_replace", () => {
  it("replaces a unique match", async () => {
    writeFileSync(join(root, "a.txt"), "hello world\n");
    await call("search_replace", { file_path: "a.txt", old_string: "world", new_string: "there" });
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("hello there\n");
  });

  it("refuses an ambiguous match unless replace_all is set", async () => {
    writeFileSync(join(root, "a.txt"), "x\nx\n");
    await expect(call("search_replace", { file_path: "a.txt", old_string: "x", new_string: "y" }))
      .rejects.toThrow(/matches 2 places/);

    await call("search_replace", { file_path: "a.txt", old_string: "x", new_string: "y", replace_all: true });
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("y\ny\n");
  });

  it("creates a file from an empty old_string, including missing parents", async () => {
    await call("search_replace", { file_path: "deep/nested/new.txt", old_string: "", new_string: "hi\n" });
    expect(readFileSync(join(root, "deep/nested/new.txt"), "utf-8")).toBe("hi\n");
  });

  // The rule that stops an "create this file" call from silently wiping work.
  it("will not overwrite an existing non-empty file with an empty old_string", async () => {
    writeFileSync(join(root, "a.txt"), "important\n");
    await expect(call("search_replace", { file_path: "a.txt", old_string: "", new_string: "gone" }))
      .rejects.toThrow(/cannot overwrite/);
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("important\n");
  });

  it("reports a missing match instead of writing nothing silently", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n");
    await expect(call("search_replace", { file_path: "a.txt", old_string: "nope", new_string: "x" }))
      .rejects.toThrow(/was not found/);
  });

  it("rejects a no-op replacement", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n");
    await expect(call("search_replace", { file_path: "a.txt", old_string: "hello", new_string: "hello" }))
      .rejects.toThrow(/identical/);
  });

  it("refuses a path outside the working directory", async () => {
    await expect(call("search_replace", { file_path: "../evil.txt", old_string: "", new_string: "x" }))
      .rejects.toThrow(/escapes the working directory/);
  });
});

describe("list_dir", () => {
  it("lists directories first, then files with sizes", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "12345");
    const out = await call("list_dir", { target_directory: "." });
    expect(out.indexOf("sub/")).toBeLessThan(out.indexOf("a.txt"));
    expect(out).toContain("a.txt (5B)");
  });

  it("says so when the directory is empty", async () => {
    mkdirSync(join(root, "empty"));
    expect(await call("list_dir", { target_directory: "empty" })).toContain("(empty)");
  });
});

describe("glob", () => {
  beforeEach(() => {
    mkdirSync(join(root, "src/deep"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "");
    writeFileSync(join(root, "src/deep/b.ts"), "");
    writeFileSync(join(root, "src/c.js"), "");
    writeFileSync(join(root, "node_modules/skip.ts"), "");
  });

  it("matches across directories and skips dependency dirs", async () => {
    const out = await call("glob", { pattern: "src/**/*.ts" });
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/deep/b.ts");
    expect(out).not.toContain("c.js");
    expect(out).not.toContain("node_modules");
  });

  it("reports no matches rather than an empty string", async () => {
    expect(await call("glob", { pattern: "**/*.rs" })).toContain("No files match");
  });
});

describe("grep", () => {
  beforeEach(() => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "const needle = 1;\nconst other = 2;\n");
    writeFileSync(join(root, "src/b.js"), "// needle here\n");
  });

  it("returns file, line number and the matching line", async () => {
    const out = await call("grep", { pattern: "needle" });
    expect(out).toContain("src/a.ts:1:");
    expect(out).toContain("src/b.js:1:");
    expect(out).toContain("const needle = 1;");
  });

  it("restricts by include glob", async () => {
    const out = await call("grep", { pattern: "needle", include: "**/*.ts" });
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("src/b.js");
  });

  it("is case-insensitive by default and case-sensitive on request", async () => {
    expect(await call("grep", { pattern: "NEEDLE" })).toContain("src/a.ts");
    expect(await call("grep", { pattern: "NEEDLE", case_sensitive: true })).toContain("No matches");
  });

  it("reports a bad regex as a usable error", async () => {
    await expect(call("grep", { pattern: "([" })).rejects.toThrow(/Invalid regular expression/);
  });
});

describe("glob patterns", () => {
  it("handles **, *, ? and alternation", () => {
    expect(globToRegExp("src/**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("**/{README,CHANGELOG}.md").test("docs/README.md")).toBe(true);
    expect(globToRegExp("**/{README,CHANGELOG}.md").test("docs/OTHER.md")).toBe(false);
  });
});

describe("tool registry", () => {
  // The enabled list is a filter on the map handed to the model, so a disabled
  // tool is never described to it — this is the containment the config UI promises.
  it("builds only the enabled tools", () => {
    const tools = buildLocalTools(["read_file"], { workingDir: root });
    expect(Object.keys(tools)).toEqual(["read_file"]);
  });

  it("builds nothing when nothing is enabled", () => {
    expect(Object.keys(buildLocalTools([], { workingDir: root }))).toHaveLength(0);
  });

  it("ignores unknown ids rather than throwing", () => {
    expect(Object.keys(buildLocalTools(["read_file", "nope"], { workingDir: root }))).toEqual(["read_file"]);
  });

  // Ids are persisted in custom_agents.enabled_tools; renaming one silently
  // disables that tool on every agent that had it.
  it("keeps its ids stable", () => {
    expect(LOCAL_TOOLS.map((t) => t.id).sort()).toEqual(
      ["glob", "grep", "list_dir", "read_file", "search_replace"],
    );
  });
});
