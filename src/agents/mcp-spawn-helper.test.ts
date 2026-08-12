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
    // Distinct URL string (query marker) so grok does not collapse skipper-daemon
    // into an operator `skipper` server that points at the same /mcp endpoint.
    expect(overrides.extraEnv.SKIPPER_DAEMON_URL).toBe("http://localhost:5099/mcp?client=skipper-daemon");

    const configPath = join(workDir, ".grok", "config.toml");
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.skipper-daemon]");
    expect(content).toContain('url = "http://localhost:5099/mcp?client=skipper-daemon"');
    expect(content).toContain('Authorization = "Bearer ${SKIPPER_AGENT_TOKEN}"');
    // Token comes from env expansion, never inlined
    expect(content).not.toContain("runtime-1");

    expect(overrides.restoreFiles).toHaveLength(1);
    expect(overrides.restoreFiles![0]!.content).toBeNull();
    expect(overrides.restoreFiles![0]!.removeParentDirIfEmpty).toBe(true);
  });

  it("gives grok a URL distinct from the plain /mcp endpoint (collision avoidance)", () => {
    // Grok collapses two MCP servers that share one URL; operators often already
    // have a `skipper` server at the same http://host:port/mcp (grok scans
    // ~/.claude.json / Cursor). The daemon must carry a marker so grok keeps it
    // as its own connection with its own (daemon) tool surface.
    const grok = injectDaemonMcpServer(freshOverrides(), "r", "grok", 5005, workDir);
    const grokUrl = readFileSync(join(workDir, ".grok", "config.toml"), "utf-8")
      .match(/url = "([^"]+)"/)![1]!;
    expect(grokUrl).toContain("?client=skipper-daemon");
    expect(grokUrl).not.toBe("http://localhost:5005/mcp");

    // claude-code keys MCP servers by name, not URL, so it keeps the plain URL.
    const cc = injectDaemonMcpServer(freshOverrides(), "r", "claude-code", 5005, workDir);
    const ccPath = cc.extraArgs[cc.extraArgs.indexOf("--mcp-config") + 1]!;
    expect(readFileSync(ccPath, "utf-8")).toContain('"http://localhost:5005/mcp"');
    rmSync(ccPath, { force: true });
  });

  it("passes --trust so the repo-local server is actually started", () => {
    // Without it grok skips project-scoped MCP servers in an untrusted folder
    // outright — no connection attempt, no tools, no error the agent can see.
    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-1", "grok", 5099, workDir);
    expect(overrides.extraArgs).toContain("--trust");
  });

  it("does not trust a folder when there is no working directory to patch", () => {
    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-1", "grok", 5099, undefined);
    expect(overrides.extraArgs).not.toContain("--trust");
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

describe("injectDaemonMcpServer (opencode)", () => {
  it("adds skipper-daemon via an isolated OPENCODE_CONFIG temp file", () => {
    const overrides = injectDaemonMcpServer(freshOverrides(), "runtime-oc", "opencode", 5005, "/whatever");

    const cfgPath = overrides.extraEnv.OPENCODE_CONFIG!;
    expect(cfgPath).toBeTruthy();
    expect(overrides.cleanupPaths).toContain(cfgPath);
    expect(overrides.extraEnv.SKIPPER_AGENT_TOKEN).toBe("runtime-oc");

    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const server = cfg.mcp["skipper-daemon"];
    expect(server.type).toBe("remote");
    expect(server.url).toBe("http://localhost:5005/mcp");
    expect(server.enabled).toBe(true);
    // Token is env-substituted by opencode at load, never written to disk.
    expect(server.headers.Authorization).toBe("Bearer {env:SKIPPER_AGENT_TOKEN}");
    expect(readFileSync(cfgPath, "utf-8")).not.toContain("runtime-oc");

    rmSync(cfgPath, { force: true });
  });

  it("merges rather than replaces — carries only the daemon server", () => {
    // OPENCODE_CONFIG is merged on top of the operator's global config, so the
    // temp file must contain ONLY skipper-daemon (no provider/model keys that
    // would shadow the host's).
    const overrides = injectDaemonMcpServer(freshOverrides(), "r", "opencode", 5005, undefined);
    const cfg = JSON.parse(readFileSync(overrides.extraEnv.OPENCODE_CONFIG!, "utf-8"));
    expect(Object.keys(cfg.mcp)).toEqual(["skipper-daemon"]);
    expect(cfg.provider).toBeUndefined();
    rmSync(overrides.extraEnv.OPENCODE_CONFIG!, { force: true });
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
