# src/config-readers

Parsers for external config files NOT owned by Skipper.

| file | use |
|---|---|
| `mcp.ts` | Read claude/codex MCP server configs from `~/.claude.json`, `~/.codex/config.toml`, project dirs |
| `skills.ts` | Discover skills from `~/.claude/plugins/cache/**` etc. |
| `omarchy.ts` | Active Omarchy OS theme (https://omarchy.org): `getOmarchyState()` reads `~/.config/omarchy/current/theme/colors.toml` (palette: background/foreground/accent/color0..15, mode) + the `current/background` wallpaper symlink into a cached `{palette, background, version}`; `isOmarchyAvailable()`, `invalidateOmarchyState()`, `watchOmarchy(onChange)` (fs.watch on `current/`, debounced, fires only when the version changes). `OMARCHY_CURRENT_DIR` overrides the dir. Feeds the web `omarchy` theme (`html/styles/omarchy-theme.ts`, `routes/omarchy.ts`) and the TUI `ansi` palette auto-select |

Used to populate spawn-time MCP config + skill catalogues.

`mcp.ts` also backs the one-click import in the custom-agent MCP server panel on
/config. Import **copies** an entry into Skipper's own registry
(`custom_agents/servers.ts`); nothing here is ever written back, so editing
Skipper's copy cannot change a user's Claude or Codex config.
