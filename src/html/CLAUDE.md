# src/html

Server-side HTML rendering. No framework — string templates from TS.

## Subdirs

| dir | use |
|---|---|
| `atoms/` | Smallest helpers: `escape-html`, `render-inline-markdown` (safe inline md → HTML for the activity feed: escapes first, then a fixed `<strong>`/`<em>`/`<code>` allowlist; unrecognised/unbalanced markers stay plain text), `format-timestamp`, `format-tokens`, `sniff-html` |
| `fragments/` | Single-element snippets (badge, metric, task-row, tree-node, phase-step…). Also the v2-UI composite fragments: `task-timeline.fragment.ts` (unified timeline: agent prose + operator messages as cards, tool frames grouped into `<details>`, escalations inline via `escalationCardPanel`; drops duplicate `result` frames) and `artifact-list.fragment.ts` (per-name rows, main link opens latest, expandable version sub-list) — both shared by the fragment routes and `ws/ui-push.ts` |
| `panels/` | Larger composite cards (steer panel, active mission, task queue, phase stepper, escalation bar/card, iterate, metrics bar, artifacts, notes) |
| `pages/` | Full-page renderers (command-center, task-list, task-create, config, logs, grug, agent-terminal, teams, team-map). Recurring tasks use the same task-create form (Task Type = Recurring) |

## v2 UI (`--v2ui` flag / `SKIPPER_V2UI=1`)

Opt-in command-center redesign, gated by `isV2UI()` (feature-flags). Classic
dock UI stays the default; realtime, draft and scheduled views are unchanged
either way. When on:

- **Sidebar** (`renderSidebarListBodyV2`) is one scrolling list sectioned by
  liveness, not tabs: **Needs you** (tasks with `has_attention`, always visible,
  never collapsible) → **Active** (running/approved/paused/draft, any kind) →
  **Recurring** (one series row per recurring task: name opens the detail view,
  last 5 runs as status squares via `vm.scheduledRuns` /
  `data/command-center.ts:fetchRecentScheduledRuns`, expanding lists those runs
  as direct links into each run's task view + "All runs") → **Teams** (each team
  a `<details data-tc-team>` with its 8 most recent tasks; team name links to
  `pickTeamLandingTask` = running > approved > paused > latest) → a "Task
  history" link to `/tasks`. Section and series collapse state persists through
  the same `data-tc-team` toggle store in `skipper.js` (keys `sec:<name>` /
  `rec:<id>`) because WS pushes re-render the list blind. `/?team=<id>` opens a
  team's landing task.
- **Task view** (`taskMainContentV2`): full-width task header (stepper, orbs,
  lifecycle actions), attention slot (review/recovery/iterate/result), then
  `.tc-work` = timeline column + draggable divider (`data-tc-divider`; rail
  width % persisted as `tcRailWidthPct`, default 50/50) + artifacts/notes rail.
  No escalations/messages tabs — both live in the timeline. Notes input lives
  only in the rail.
- **Timeline** `/workspace/task/:id/timeline` → `fragments/task-timeline.fragment.ts`,
  container `#mc-timeline-<id>` / inner `#mc-timeline-inner-<id>`; scroll sticks
  to bottom (`tcStickTimeline` in skipper.js). WS pushes re-render it on
  agent:output (debounced), task:message_posted, escalation:created/resolved.
- **Artifacts** rail uses `fragments/artifact-list.fragment.ts`; the detail
  opens fullscreen via the existing `#sk-artifact-detail-window` ids restyled as
  `.tc-artifact-overlay`.
- Styles in `styles/team-center.ts` (`tc-` prefix), theme-token based.
| `shell/` | Layout + navbar wrappers |
| `view-models/` | Data shape feeding renderers (e.g. `command-center.vm.ts`). Pure assemblers — SQL lives in `src/data` (`command-center.ts`), never here |
| `styles/` | CSS strings |
| `public/` | Static assets served by Bun |

## Top-level files

Lots of legacy flat `*Fragment.ts` files at this level — pre-reorg into `fragments/panels/pages/`. Two coexist for now. Prefer new subdir layout for new code.

| file | use |
|---|---|
| `components.ts` | Big top-level renderer for standard pages. Wire DTO types (TaskData, ForensicsData, …) moved to `src/contracts/types.ts` — re-exported here for legacy importers |
| `realtime-components.ts` | Realtime task pages (list, detail, timeline, notes, pipeline, agent assign) |
| `layout.ts`, `baseStyles.ts` | Shared shell + base CSS |
| `forensics*.ts` | Forensics tab on task detail (timeline, instance tree, delegations, escalations, token usage, terminal tails) |
| `dashboard*Fragment.ts` | Dashboard polling fragments |
| `terminalJsonSummary.ts` | One JSON stdout frame → one activity-feed line, per provider shape (claude-code `message.content`, codex `item`, grok `{type:"text"\|"thought",data}`, opencode `{type:"text",part:{text}}`, `result`, errors). **A shape it doesn't know summarises to `""`, and the activity feed drops empty rows** — so an unhandled provider looks like it produced no output at all, not like it rendered badly. Add a case here (and to the two `parseTerminalActivity`/`recentActivityFragment` classifiers) when adding a provider |

## Custom agent pages

`pages/custom-agents.page.ts` (index) + `pages/custom-agent-form.page.ts` (editor),
on `/custom-agents` and `/custom-agents/:id`, experimental only. The index also
carries the two panels that define what an agent can be granted — `mcpServersPanel`
and `customToolsPanel` — so the supply and the ticking sit on one page rather than
across Config. The editor works
like the team map: one client-side `AGENT` object, every field a mutation, nothing
persisted until Save POSTs the whole thing as JSON. Tool and skill checkboxes are
rendered from `custom-agents/tools/registry.ts` and
`custom-agents/mcp-catalogue.ts`, so adding a tool needs no page change.

## Teams pages

`pages/teams.page.ts` (index grid) + `pages/team-map.page.ts` (map editor), styled
by `styles/team-map.ts` (`tm-` prefix). Registered on `/teams`, `/teams/new` and
`/teams/:id` — the primary team interface; Config no longer carries a team panel
and the old `local-team-form.page.ts` is gone. The map renders the
whole team client-side from one `TEAM` object — phase flow (nodes joined by
connectors, review gate = diamond) above a flat crew line (Skipper plus the
team's agents as peer cards; there is no reporting hierarchy). Every edit
mutates `TEAM` and re-renders; nothing persists until Save POSTs the whole team
as JSON to `/api/teams` (create) or `/api/teams/:id/update`.
