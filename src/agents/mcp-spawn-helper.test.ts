import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  injectDaemonMcpServer,
  restoreMcpConfigFiles,
  stripGrokDaemonBlocks,
  type McpSpawnOverrides,
} from "./mcp-spawn-helper";

let workDir: string;

function freshOverrides(): McpSpawnOverrides {
  return { extraArgs: [], extraEnv: {}, cleanupPaths: [] };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "skipper-grok-mcp-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("injectDaemonMcpServer (grok)", () => {
  it("writes a marker-delimited daemon block into <workingDir>/.grok/config.toml", () => {
    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-1", "grok", 5099, workDir);

    expect(overrides.extraEnv.SKIPPER_AGENT_TOKEN).toBe("runtime-1");
    expect(overrides.extraEnv.SKIPPER_DAEMON_URL).toBe("http://localhost:5099/mcp");

    const configPath = join(workDir, ".grok", "config.toml");
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.skipper-daemon]");
    expect(content).toContain('url = "http://localhost:5099/mcp"');
    expect(content).toContain('Authorization = "Bearer ${SKIPPER_AGENT_TOKEN}"');
    // Token comes from env expansion, never inlined
    expect(content).not.toContain("runtime-1");

    expect(overrides.restoreFiles).toHaveLength(1);
    expect(overrides.restoreFiles![0]!.content).toBeNull();
    expect(overrides.restoreFiles![0]!.removeParentDirIfEmpty).toBe(true);
  });

  it("preserves a pre-existing project config and appends the block", () => {
    const dir = join(workDir, ".grok");
    mkdirSync(dir);
    const original = "[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\n";
    writeFileSync(join(dir, "config.toml"), original, "utf-8");

    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-2", "grok", 5005, workDir);

    const content = readFileSync(join(dir, "config.toml"), "utf-8");
    expect(content).toContain("[mcp_servers.linear]");
    expect(content).toContain("[mcp_servers.skipper-daemon]");
    expect(overrides.restoreFiles![0]!.content).toBe(original);
    expect(overrides.restoreFiles![0]!.removeParentDirIfEmpty).toBe(false);
  });

  it("replaces a stale daemon block instead of stacking a second one", () => {
    injectDaemonMcpServer(freshOverrides(), "runtime-3", "grok", 5005, workDir);
    injectDaemonMcpServer(freshOverrides(), "runtime-4", "grok", 5005, workDir);

    const content = readFileSync(join(workDir, ".grok", "config.toml"), "utf-8");
    const matches = content.match(/\[mcp_servers\.skipper-daemon\]/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("restoreMcpConfigFiles", () => {
  it("deletes a created file and removes the dir we created", () => {
    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-5", "grok", 5005, workDir);
    restoreMcpConfigFiles(overrides.restoreFiles!);

    expect(existsSync(join(workDir, ".grok", "config.toml"))).toBe(false);
    expect(existsSync(join(workDir, ".grok"))).toBe(false);
  });

  it("writes back the original bytes for a pre-existing file", () => {
    const dir = join(workDir, ".grok");
    mkdirSync(dir);
    const original = "# my project config\n[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\n";
    writeFileSync(join(dir, "config.toml"), original, "utf-8");

    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-6", "grok", 5005, workDir);
    restoreMcpConfigFiles(overrides.restoreFiles!);

    expect(readFileSync(join(dir, "config.toml"), "utf-8")).toBe(original);
    expect(existsSync(dir)).toBe(true);
  });

  it("leaves a non-empty created dir in place", () => {
    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-7", "grok", 5005, workDir);
    writeFileSync(join(workDir, ".grok", "other.txt"), "keep", "utf-8");
    restoreMcpConfigFiles(overrides.restoreFiles!);

    expect(existsSync(join(workDir, ".grok", "config.toml"))).toBe(false);
    expect(readFileSync(join(workDir, ".grok", "other.txt"), "utf-8")).toBe("keep");
  });
});

describe("stripGrokDaemonBlocks", () => {
  it("returns content without markers untouched", () => {
    const content = "[mcp_servers.linear]\nurl = \"x\"\n";
    expect(stripGrokDaemonBlocks(content)).toBe(content);
  });

  it("removes an unterminated block to the end of the file", () => {
    const content = "keep me\n# >>> skipper-daemon (auto-generated, removed on agent exit) >>>\n[mcp_servers.skipper-daemon]\n";
    expect(stripGrokDaemonBlocks(content)).toBe("keep me\n");
  });
});
