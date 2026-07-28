# src/html

Server-side HTML rendering. No framework — string templates from TS.

## Subdirs

| dir | use |
|---|---|
| `atoms/` | Smallest helpers: `escape-html`, `format-timestamp`, `format-tokens`, `sniff-html` |
| `fragments/` | Single-element snippets (badge, metric, task-row, tree-node, phase-step…) |
| `panels/` | Larger composite cards (steer panel, active mission, task queue, phase stepper, escalation bar/card, iterate, metrics bar, artifacts, notes) |
| `pages/` | Full-page renderers (command-center, task-list, task-create, config, logs, grug, agent-terminal, teams, team-map). Recurring tasks use the same task-create form (Task Type = Recurring) |
| `shell/` | Layout + navbar wrappers |
| `view-models/` | Data shape feeding renderers (e.g. `command-center.vm.ts`) |
| `styles/` | CSS strings |
| `public/` | Static assets served by Bun |

## Top-level files

Lots of legacy flat `*Fragment.ts` files at this level — pre-reorg into `fragments/panels/pages/`. Two coexist for now. Prefer new subdir layout for new code.

| file | use |
|---|---|
| `components.ts` | Big top-level renderer for standard pages |
| `realtime-components.ts` | Realtime task pages (list, detail, timeline, notes, pipeline, agent assign) |
| `layout.ts`, `baseStyles.ts` | Shared shell + base CSS |
| `forensics*.ts` | Forensics tab on task detail (timeline, instance tree, delegations, escalations, token usage, terminal tails) |
| `dashboard*Fragment.ts` | Dashboard polling fragments |

## Teams pages (experimental)

`pages/teams.page.ts` (index grid) + `pages/team-map.page.ts` (map editor), styled
by `styles/team-map.ts` (`tm-` prefix). Registered on `/teams`, `/teams/new` and
`/teams/:id` only under `isExperimental()`; without the flag those paths keep
redirecting to Config, which still owns team management. The map renders the
whole team client-side from one `TEAM` object — phase flow (nodes joined by
connectors, review gate = diamond) above a flat crew line (Skipper plus the
team's agents as peer cards; there is no reporting hierarchy). Every edit
mutates `TEAM` and re-renders; nothing persists until Save POSTs the whole team
as JSON to `/api/teams` (create) or `/api/teams/:id/update`.
