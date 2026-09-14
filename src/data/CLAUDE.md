# src/data

Read-only DB queries shared by every output surface (HTML routes, `/data` JSON
API, WS push, connect). One definition per query — route files and `ui-push`
must import from here instead of re-declaring SQL.

| file | use |
|---|---|
| `queries.ts` | Big bag of typed query fns. Tasks, forensics, agents, teams, escalations, dashboard (running instances, metrics, recent activity, poll interval, daemon-paused). `fetchTaskOutputPage(db, taskId, {beforeId?, afterId?, limit})` is THE way to read a task's terminal output (activity route, connect `outputs/list`, output-tail backfill): newest-first on `terminal_outputs.id`, two-step (ids off the covering index, then bodies by PK) so a 300MB task pages in ~1ms instead of sorting every frame body; `fetchTaskOutputRow(db, id)` for one frame |
| `command-center.ts` | Row fetchers behind the command-center view-model (`html/view-models/command-center.vm.ts` assembles them; a JSON endpoint can reuse them as-is) |
| `realtime.ts` | Realtime-task reads: timeline, notes, task agents, running agents, pipeline status + counters |
| `glyph.ts` | Glyph renderer reads: `fetchGlyphTaskSummary` (title, display status, mode, phases, review flag, open escalation count) and `fetchGlyphDelta(db, taskId, cursor)` — notes / operator messages / artifacts (text body, never file bytes; plus storage/mime/format/size so the prompt can say which are showable images or html pages) and the task working directory / operator input (`realtime_timeline` `text`/`transcript`/`summary` rows) / new + resolved + open escalations since a per-register **rowid** cursor, plus the next cursor. Never terminal output. See [../glyph/CLAUDE.md](../glyph/CLAUDE.md) |

Return types are the wire DTOs in [src/contracts/types.ts](../contracts/types.ts)
(or plain local row interfaces) — never types from `src/html`. Keep everything
JSON-serializable and keep mutations out — read-shape only. Mutations belong in
the domain managers (`src/tasks`, `src/teams`, …).
