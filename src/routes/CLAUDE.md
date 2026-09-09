# src/routes

HTTP handlers. Registered in `index.ts` against `server.ts` router. Each gets `ManagerDaemon` facade.

| file | use |
|---|---|
| `tasks.ts` | Task CRUD + lifecycle (approve/unapprove/pause/resume/settle/revive/cancel (legacy archive/unarchive shims); `POST /api/tasks/:id/input` is the unified input verb — `daemon.inputTask` — replacing iterate/retry/resume; those legacy routes are shims or 410). Realtime session/stream routes work for ANY active task. Detail/fragments. Health diag. Stale runtime cleanup. **File artifacts:** `POST /api/tasks/:id/artifacts/upload` (multipart `file` one-or-more + optional `description`; `ArtifactManager.createFileArtifact` with source `operator`, then `RealtimeSessionManager.ingestArtifactUpload` for the timeline entry + wake; JSON 201 with the `artifactToJson` projection + `delivered`, or for `HX-Request` callers the re-rendered rail list fragment; 400 on missing file / bad image / cap, 404 unknown task), `GET /api/artifacts/:id/file` (bytes; `Content-Type` = mime, `Cache-Control: public, max-age=31536000, immutable`, `Content-Disposition: inline` for images else `attachment; filename=`), `GET /api/artifacts/:id/meta` (metadata JSON). `GET /api/tasks/:id/artifacts/:name` (and the `/data` twin) never returns a body for a file artifact: `artifactToJson` swaps it for `description` + `file_url` |
| `teams.ts` | Team CRUD (teams embed their own agents + phases) under `/api/teams`, plus `/api/teams/export` + `/api/teams/import` |
| `daemon.ts` | Pause/resume/status + dashboard refresh fragment |
| `pages.ts` | Server-rendered HTML pages + polling fragments. Custom agents live on `/custom-agents` and `/custom-agents/:id` (experimental; `/agents` is the agent terminal). Dashboard, tasks, escalations, logs, events, config. Teams live on `/teams`, `/teams/new`, `/teams/:id` (index grid + interactive team map). The old config-page team form is gone; `/config/teams/new`, `/config/teams/:id/edit` and `/local-teams` redirect to the new pages |
| `realtime.ts` | Legacy input-pipeline API kept for embedded JS + iOS: session start/stop/resume/close, text input, timeline/notes/agents/pipeline reads, per-task agent assign, global transcription config. No type guards — valid for any active task. Create/edit/list of conversational tasks goes through the unified task routes |
| `realtime-ws.ts` | WebSocket endpoint for the input pipeline (audio/text ingest + session events) — any task |
| `skipper.ts` | Skipper config `GET/PUT` w/ agent-type+model validate. Optional HTML fragment render |
| `scheduled-tasks.ts` | CRUD for scheduled (cron) tasks + webhook trigger lifecycle (`/api/scheduled-tasks/:id/webhook/{enable,regenerate,disable}`) |
| `utils.ts` | HTML response + body parse (form/json) helpers |
| `api-keys.ts` | API-key CRUD under `/api/api-keys` (sk-… keys, hash-stored). Keys gate external MCP and the `/data/*` API |
| `custom-agents.ts` | Experimental (404 without `--experimental`): CRUD under `/api/custom-agents` for in-process agent definitions, plus `POST /api/custom-agents/probe` (reachability + model discovery against the configured endpoint). Also the MCP server registry under `/api/custom-agent-servers` — create/update connect to the server and cache its tool list, and every mutation returns the re-rendered config panel for an htmx swap. Secrets are redacted on the way out and blank-means-unchanged on the way in. See [../custom-agents/CLAUDE.md](../custom-agents/CLAUDE.md) |
| `task-memory.ts` | Experimental (404 without `--experimental`): `POST /api/tasks/:id/memory` (one-off toggle; enable backfills existing rows; 400 on a recurring run, whose memory is set on the series), `POST /api/tasks/:id/memory/clear`, `POST /api/scheduled-tasks/:id/memory` (series mode off\|run\|shared + `retention_days`; shared backfills every run) and `/memory/clear`, `POST /api/config/task-memory` (embeddings settings), `GET /api/config/task-memory/status` (status fragment, polled while downloading), `POST /api/config/task-memory/download|start|stop` (managed local llama-server). `buildTaskMemoryPanelData` feeds the config page through `pages.ts:setTaskMemoryPanelProvider`. See [../task-memory/CLAUDE.md](../task-memory/CLAUDE.md) |
| `custom-tools.ts` | Experimental (404 without `--experimental`): CRUD under `/api/custom-tools` for operator-defined tools, plus `POST /api/custom-tools/test` which runs a body from the form's values through the real worker and timeout. See [../custom-tools/CLAUDE.md](../custom-tools/CLAUDE.md) |
| `dictation.ts` | Experimental (404 without `--experimental`): `POST /api/dictation/transcribe` (base64 clip → realtime transcription adapter → text) + `/api/dictation/cleanup` (LLM rewrite, falls back to raw). UI: `public/dictation.js` mic button on task-description fields |
| `data/` | JSON data API (`{ok, data\|error}` envelope — shared helpers in `data/envelope.ts`, don't re-declare). Every route requires `Authorization: Bearer <api-key>` — register via `data/auth.ts:addDataRoute()`, never raw `addRoute` (auth.test.ts walks the route table and fails unguarded `/data/*`). Resources: tasks (CRUD, lifecycle incl. input/archive/unarchive (legacy names)/pause/resume-from-pause, review approve/reject, notes, artifacts, forensics, escalation history), teams (list/detail/members + CRUD via `teams/team-input.ts`), agents (+steer), escalations (list/detail/resolve/dismiss), dashboard, daemon, realtime tasks, global-store, scheduled tasks, logs/events. Read queries come from `src/data`, not inline SQL |

## Activity feed paging (`pages.ts`)

`GET /workspace/task/:id/activity` renders the rail's Activity tab from
`data/queries.ts:fetchTaskOutputPage` (cursor = `terminal_outputs.id`, never the
per-instance `sequence`): no cursor → newest 100 rows plus a load-more sentinel
(`hx-trigger="intersect once"`, swaps itself for the next page); `?before=<id>`
→ the older page; `?after=<id>` → every newer row, no sentinel, empty body when
nothing is new (the WS poke path, see [../ws/CLAUDE.md](../ws/CLAUDE.md)). Rows
carry `data-sk-activity-id` only; `GET /workspace/activity/:outputId` returns the
raw frame as text for the detail modal.
