# src/config-readers

Parsers for external config files NOT owned by Skipper.

| file | use |
|---|---|
| `mcp.ts` | Read claude/codex MCP server configs from `~/.claude.json`, `~/.codex/config.toml`, project dirs |
| `skills.ts` | Discover skills from `~/.claude/plugins/cache/**` etc. |

Used to populate spawn-time MCP config + skill catalogues.

`mcp.ts` also backs the one-click import in the custom-agent MCP server panel on
/config. Import **copies** an entry into Skipper's own registry
(`custom_agents/servers.ts`); nothing here is ever written back, so editing
Skipper's copy cannot change a user's Claude or Codex config.
