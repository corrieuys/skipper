# src/config-readers

Parsers for external config files NOT owned by Skipper.

| file | use |
|---|---|
| `mcp.ts` | Read claude/codex MCP server configs from `~/.claude.json`, `~/.codex/config.toml`, project dirs |
| `skills.ts` | Discover skills from `~/.claude/plugins/cache/**` etc. |

Used to populate spawn-time MCP config + skill catalogues.
