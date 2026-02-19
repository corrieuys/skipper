import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseToml } from "smol-toml";

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  type?: string;
  scope: "user" | "project" | "cloud";
  enabled: boolean;
}

export interface McpServersByProvider {
  claudeCode: McpServerEntry[];
  codex: McpServerEntry[];
}

const PROJECT_ROOT = process.cwd();

export function readClaudeCodeMcpServers(): McpServerEntry[] {
  const entries: McpServerEntry[] = [];

  // User-level: ~/.claude.json
  const userConfigPath = join(homedir(), ".claude.json");
  if (existsSync(userConfigPath)) {
    try {
      const raw = readFileSync(userConfigPath, "utf-8");
      const data = JSON.parse(raw);

      // Standard user-level MCP servers
      const servers: Record<string, unknown> = data.mcpServers ?? {};
      for (const [name, cfg] of Object.entries(servers)) {
        const c = cfg as Record<string, unknown>;
        entries.push({
          name,
          command: (c.command as string) ?? "",
          args: (c.args as string[]) ?? [],
          env: (c.env as Record<string, string>) ?? {},
          type: c.type as string | undefined,
          scope: "user",
          enabled: true,
        });
      }

      // Cloud-managed integrations: claudeAiMcpEverConnected
      const cloudConnected: string[] = data.claudeAiMcpEverConnected ?? [];
      for (const name of cloudConnected) {
        entries.push({
          name,
          command: "",
          args: [],
          env: {},
          type: "cloud",
          scope: "cloud",
          enabled: true,
        });
      }

      // Per-project MCP servers from projects.<cwd>.mcpServers
      const projectKey = process.cwd();
      const projectServers: Record<string, unknown> =
        (data.projects?.[projectKey] as Record<string, unknown> | undefined)
          ?.mcpServers as Record<string, unknown> ?? {};
      for (const [name, cfg] of Object.entries(projectServers)) {
        const c = cfg as Record<string, unknown>;
        entries.push({
          name,
          command: (c.command as string) ?? "",
          args: (c.args as string[]) ?? [],
          env: (c.env as Record<string, string>) ?? {},
          type: c.type as string | undefined,
          scope: "project",
          enabled: true,
        });
      }
    } catch {
      // Gracefully handle parse errors
    }
  }

  // Cloud integrations available but needing auth: ~/.claude/mcp-needs-auth-cache.json
  const authCachePath = join(homedir(), ".claude", "mcp-needs-auth-cache.json");
  if (existsSync(authCachePath)) {
    try {
      const raw = readFileSync(authCachePath, "utf-8");
      const authCache = JSON.parse(raw) as Record<string, unknown>;
      for (const name of Object.keys(authCache)) {
        if (!entries.some((e) => e.name === name && e.scope === "cloud")) {
          entries.push({
            name,
            command: "",
            args: [],
            env: {},
            type: "cloud",
            scope: "cloud",
            enabled: false,
          });
        }
      }
    } catch {
      // Gracefully handle parse errors
    }
  }

  // Project-level: ./.mcp.json
  const projectConfigPath = join(PROJECT_ROOT, ".mcp.json");
  if (existsSync(projectConfigPath)) {
    try {
      const raw = readFileSync(projectConfigPath, "utf-8");
      const data = JSON.parse(raw);
      const servers: Record<string, unknown> = data.mcpServers ?? {};
      for (const [name, cfg] of Object.entries(servers)) {
        const c = cfg as Record<string, unknown>;
        entries.push({
          name,
          command: (c.command as string) ?? "",
          args: (c.args as string[]) ?? [],
          env: (c.env as Record<string, string>) ?? {},
          type: c.type as string | undefined,
          scope: "project",
          enabled: true,
        });
      }
    } catch {
      // Gracefully handle parse errors
    }
  }

  return entries;
}

export function readCodexMcpServers(): McpServerEntry[] {
  const entries: McpServerEntry[] = [];

  // User-level: ~/.codex/config.toml
  const userConfigPath = join(homedir(), ".codex", "config.toml");
  if (existsSync(userConfigPath)) {
    try {
      const raw = readFileSync(userConfigPath, "utf-8");
      const data = parseToml(raw) as Record<string, unknown>;
      const servers = (data.mcp_servers ?? {}) as Record<string, unknown>;
      for (const [name, cfg] of Object.entries(servers)) {
        const c = cfg as Record<string, unknown>;
        entries.push({
          name,
          command: (c.command as string) ?? "",
          args: (c.args as string[]) ?? [],
          env: (c.env as Record<string, string>) ?? {},
          scope: "user",
          enabled: c.enabled !== false,
        });
      }
    } catch {
      // Gracefully handle parse/read errors
    }
  }

  // Project-level: ./.codex/config.toml
  const projectConfigPath = join(PROJECT_ROOT, ".codex", "config.toml");
  if (existsSync(projectConfigPath)) {
    try {
      const raw = readFileSync(projectConfigPath, "utf-8");
      const data = parseToml(raw) as Record<string, unknown>;
      const servers = (data.mcp_servers ?? {}) as Record<string, unknown>;
      for (const [name, cfg] of Object.entries(servers)) {
        const c = cfg as Record<string, unknown>;
        entries.push({
          name,
          command: (c.command as string) ?? "",
          args: (c.args as string[]) ?? [],
          env: (c.env as Record<string, string>) ?? {},
          scope: "project",
          enabled: c.enabled !== false,
        });
      }
    } catch {
      // Gracefully handle parse/read errors
    }
  }

  return entries;
}

export function readAllMcpServers(): McpServersByProvider {
  return {
    claudeCode: readClaudeCodeMcpServers(),
    codex: readCodexMcpServers(),
  };
}
