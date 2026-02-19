import { writeFileSync, mkdirSync } from "fs";
import { rmSync } from "fs";
import { join } from "path";
import { readAllMcpServers, type McpServerEntry } from "../config-readers/mcp";

export interface McpSpawnOverrides {
  extraArgs: string[];
  extraEnv: Record<string, string>;
  cleanupPaths: string[];
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
  } else {
    // For unknown agent types, provide env vars as generic fallback
    overrides.extraEnv.SKIPPER_DAEMON_URL = daemonUrl;
    overrides.extraEnv.SKIPPER_AGENT_TOKEN = runtimeId;
  }

  return overrides;
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
