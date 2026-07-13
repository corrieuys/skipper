import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { rmSync, rmdirSync } from "fs";
import { join, dirname } from "path";
import { readAllMcpServers, type McpServerEntry } from "../config-readers/mcp";

export interface McpRestoreFile {
  path: string;
  /** Original file bytes to write back on cleanup; null = file did not exist (delete it). */
  content: string | null;
  /** Also remove the parent dir on cleanup if we created it and it is empty after restore. */
  removeParentDirIfEmpty?: boolean;
}

export interface McpSpawnOverrides {
  extraArgs: string[];
  extraEnv: Record<string, string>;
  cleanupPaths: string[];
  /** Files patched in place (not temp files) that must be restored on agent exit. */
  restoreFiles?: McpRestoreFile[];
}

/**
 * Builds MCP spawn overrides for a given agent type.
 *
 * For claude-code: if any servers are disabled in the source config,
 * writes a temp JSON file with only enabled servers and returns
 * --mcp-config <path>.
 *
 * For codex: writes a temp config.toml dir with the codex server list
 * and returns CODEX_HOME env override.
 *
 * Server lists come straight from Claude / Codex configs on disk; the
 * app no longer applies its own overrides.
 */
export function buildMcpSpawnOverrides(agentType: string): McpSpawnOverrides {
  const result: McpSpawnOverrides = {
    extraArgs: [],
    extraEnv: {},
    cleanupPaths: [],
  };

  const allServers = readAllMcpServers();

  if (agentType === "claude-code") {
    // Cloud-managed servers have no local command — exclude them from temp config
    const servers = allServers.claudeCode.filter((s) => s.scope !== "cloud");
    const hasDisabled = servers.some((s) => !s.enabled);
    if (!hasDisabled) return result;

    const enabledServers = servers.filter((s) => s.enabled);
    const mcpServers: Record<string, unknown> = {};
    for (const s of enabledServers) {
      const entry: Record<string, unknown> = {
        command: s.command,
        args: s.args,
      };
      if (Object.keys(s.env).length > 0) entry.env = s.env;
      if (s.type) entry.type = s.type;
      mcpServers[s.name] = entry;
    }

    const tempPath = `/tmp/skipper-mcp-${crypto.randomUUID()}.json`;
    writeFileSync(tempPath, JSON.stringify({ mcpServers }, null, 2), "utf-8");

    result.extraArgs = ["--mcp-config", tempPath];
    result.cleanupPaths = [tempPath];
  } else if (agentType === "codex") {
    // Always create a CODEX_HOME tempdir so injectDaemonMcpServer has a
    // config.toml to append the skipper-daemon entry to.
    const enabledServers = allServers.codex.filter((s) => s.enabled);
    const tempDir = `/tmp/skipper-codex-${crypto.randomUUID()}`;
    mkdirSync(tempDir, { recursive: true });

    const tomlLines = buildCodexConfigToml(enabledServers);
    writeFileSync(join(tempDir, "config.toml"), tomlLines, "utf-8");

    result.extraEnv = { CODEX_HOME: tempDir };
    result.cleanupPaths = [tempDir];
  }

  return result;
}

function buildCodexConfigToml(servers: McpServerEntry[]): string {
  const lines: string[] = [];
  for (const s of servers) {
    lines.push(`[mcp_servers.${s.name}]`);
    lines.push(`command = ${toTomlString(s.command)}`);
    if (s.args.length > 0) {
      lines.push(`args = [${s.args.map(toTomlString).join(", ")}]`);
    }
    lines.push(`enabled = true`);
    if (Object.keys(s.env).length > 0) {
      lines.push(`[mcp_servers.${s.name}.env]`);
      for (const [k, v] of Object.entries(s.env)) {
        lines.push(`${k} = ${toTomlString(v)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function toTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Injects the skipper-daemon MCP server into an agent's MCP config at spawn time.
 * This allows agents to call daemon tools (create_note, delegate, etc.) via MCP
 * instead of stdout signals.
 */
export function injectDaemonMcpServer(
  overrides: McpSpawnOverrides,
  runtimeId: string,
  agentType: string,
  port: number,
  workingDir?: string,
): McpSpawnOverrides {
  const daemonUrl = `http://localhost:${port}/mcp`;

  if (agentType === "claude-code") {
    // If we already have a temp config file, read it and add the daemon server
    if (overrides.extraArgs.length >= 2 && overrides.extraArgs[0] === "--mcp-config") {
      const tempPath = overrides.extraArgs[1];
      try {
        const existing = JSON.parse(require("fs").readFileSync(tempPath, "utf-8"));
        existing.mcpServers = existing.mcpServers || {};
        existing.mcpServers["skipper-daemon"] = {
          type: "http",
          url: daemonUrl,
          headers: { Authorization: `Bearer ${runtimeId}` },
        };
        writeFileSync(tempPath, JSON.stringify(existing, null, 2), "utf-8");
      } catch {
        // If we can't modify the existing file, create a new one
      }
    } else {
      // No existing temp config — create one with just the daemon server
      const tempPath = `/tmp/skipper-mcp-daemon-${crypto.randomUUID()}.json`;
      const config = {
        mcpServers: {
          "skipper-daemon": {
            type: "http",
            url: daemonUrl,
            headers: { Authorization: `Bearer ${runtimeId}` },
          },
        },
      };
      writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf-8");
      overrides.extraArgs.push("--mcp-config", tempPath);
      overrides.cleanupPaths.push(tempPath);
    }
  } else if (agentType === "codex") {
    // Codex reads MCP servers from CODEX_HOME/config.toml. buildMcpSpawnOverrides
    // always sets up that tempdir, so append the skipper-daemon HTTP entry here.
    overrides.extraEnv.SKIPPER_AGENT_TOKEN = runtimeId;
    const codexHome = overrides.extraEnv.CODEX_HOME;
    if (codexHome) {
      const configPath = join(codexHome, "config.toml");
      const daemonToml = [
        "",
        "[mcp_servers.skipper-daemon]",
        `url = ${toTomlString(daemonUrl)}`,
        `bearer_token_env_var = "SKIPPER_AGENT_TOKEN"`,
        "enabled = true",
        "",
      ].join("\n");
      try {
        const existing = require("fs").existsSync(configPath)
          ? require("fs").readFileSync(configPath, "utf-8")
          : "";
        writeFileSync(configPath, existing + daemonToml, "utf-8");
      } catch {
        writeFileSync(configPath, daemonToml, "utf-8");
      }
    }
  } else if (agentType === "grok") {
    // Grok reads MCP servers from <cwd>/.grok/config.toml (highest priority,
    // merged per-server-name with the user's own ~/.grok/config.toml, so the
    // user's servers, auth, and sessions stay untouched). Patch that file with
    // a marker-delimited skipper-daemon block and restore it on agent exit.
    // The bearer token is env-expanded by grok at load time, so the file
    // content is identical for concurrent agents sharing a working dir and no
    // secret lands in the repo.
    overrides.extraEnv.SKIPPER_DAEMON_URL = daemonUrl;
    overrides.extraEnv.SKIPPER_AGENT_TOKEN = runtimeId;
    if (workingDir) {
      try {
        injectGrokDaemonConfig(overrides, workingDir, daemonUrl);
      } catch {
        // Best-effort: the agent still runs, just without daemon MCP tools
      }
    }
  } else {
    // For unknown agent types, provide env vars as generic fallback
    overrides.extraEnv.SKIPPER_DAEMON_URL = daemonUrl;
    overrides.extraEnv.SKIPPER_AGENT_TOKEN = runtimeId;
  }

  return overrides;
}

const GROK_BLOCK_START = "# >>> skipper-daemon (auto-generated, removed on agent exit) >>>";
const GROK_BLOCK_END = "# <<< skipper-daemon <<<";

function grokDaemonBlock(daemonUrl: string): string {
  return [
    GROK_BLOCK_START,
    "[mcp_servers.skipper-daemon]",
    `url = ${toTomlString(daemonUrl)}`,
    "enabled = true",
    "[mcp_servers.skipper-daemon.headers]",
    'Authorization = "Bearer ${SKIPPER_AGENT_TOKEN}"',
    GROK_BLOCK_END,
  ].join("\n");
}

/** Remove any marker-delimited skipper-daemon blocks (stale crash leftovers). */
export function stripGrokDaemonBlocks(content: string): string {
  let out = content;
  for (;;) {
    const start = out.indexOf(GROK_BLOCK_START);
    if (start === -1) return out;
    const endIdx = out.indexOf(GROK_BLOCK_END, start);
    const end = endIdx === -1 ? out.length : endIdx + GROK_BLOCK_END.length;
    out = (out.slice(0, start) + out.slice(end)).replace(/\n{3,}/g, "\n\n");
  }
}

function injectGrokDaemonConfig(
  overrides: McpSpawnOverrides,
  workingDir: string,
  daemonUrl: string,
): void {
  const dir = join(workingDir, ".grok");
  const configPath = join(dir, "config.toml");
  const dirExisted = existsSync(dir);
  const original = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
  const base = original === null ? "" : stripGrokDaemonBlocks(original);
  if (!dirExisted) mkdirSync(dir, { recursive: true });
  const sep = base.length > 0 && !base.endsWith("\n") ? "\n" : "";
  writeFileSync(configPath, base + sep + grokDaemonBlock(daemonUrl) + "\n", "utf-8");
  (overrides.restoreFiles ??= []).push({
    path: configPath,
    content: original,
    removeParentDirIfEmpty: !dirExisted,
  });
}

/**
 * Undo in-place config patches recorded in restoreFiles: write back the
 * original bytes, or delete the file (and the dir we created, if now empty)
 * when it did not exist before spawn.
 */
export function restoreMcpConfigFiles(files: McpRestoreFile[]): void {
  for (const f of files) {
    try {
      if (f.content === null) {
        rmSync(f.path, { force: true });
        if (f.removeParentDirIfEmpty) {
          try {
            rmdirSync(dirname(f.path));
          } catch {
            // Dir not empty or already gone — leave it
          }
        }
      } else {
        writeFileSync(f.path, f.content, "utf-8");
      }
    } catch {
      // Best-effort cleanup — ignore errors
    }
  }
}

export function cleanupMcpTempFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — ignore errors
    }
  }
}
