# src/routes

HTTP handlers. Registered in `index.ts` against `server.ts` router. Each gets `ManagerDaemon` facade.

| file | use |
|---|---|
| `tasks.ts` | Task CRUD + lifecycle (approve/unapprove/cancel/retry/resume/iterate). Detail/fragments. Health diag. Stale runtime cleanup |
| `teams.ts` | Team CRUD (teams embed their own agents + phases) under `/api/teams`, plus `/api/teams/export` + `/api/teams/import` |
| `daemon.ts` | Pause/resume/status + dashboard refresh fragment |
| `pages.ts` | Server-rendered HTML pages + polling fragments. Custom agents live on `/custom-agents` and `/custom-agents/:id` (experimental; `/agents` is the agent terminal). Dashboard, tasks, escalations, logs, events, config. Teams live on `/teams`, `/teams/new`, `/teams/:id` (index grid + interactive team map). The old config-page team form is gone; `/config/teams/new`, `/config/teams/:id/edit` and `/local-teams` redirect to the new pages |
| `realtime.ts` | Realtime task pages + API — create/start/stop/resume/close, text/audio input, timeline/notes/agents/pipeline, per-task agent assign |
| `realtime-ws.ts` | WebSocket endpoint for realtime task event stream |
| `skipper.ts` | Skipper config `GET/PUT` w/ agent-type+model validate. Optional HTML fragment render |
| `scheduled-tasks.ts` | CRUD for scheduled (cron) tasks + webhook trigger lifecycle (`/api/scheduled-tasks/:id/webhook/{enable,regenerate,disable}`) |
| `utils.ts` | HTML response + body parse (form/json) helpers |
| `api-keys.ts` | API-key CRUD under `/api/api-keys` (sk-… keys, hash-stored). Keys gate external MCP and the `/data/*` API |
| `custom-agents.ts` | Experimental (404 without `--experimental`): CRUD under `/api/custom-agents` for in-process agent definitions, plus `POST /api/custom-agents/probe` (reachability + model discovery against the configured endpoint). Also the MCP server registry under `/api/custom-agent-servers` — create/update connect to the server and cache its tool list, and every mutation returns the re-rendered config panel for an htmx swap. Secrets are redacted on the way out and blank-means-unchanged on the way in. See [../custom-agents/CLAUDE.md](../custom-agents/CLAUDE.md) |
| `custom-tools.ts` | Experimental (404 without `--experimental`): CRUD under `/api/custom-tools` for operator-defined tools, plus `POST /api/custom-tools/test` which runs a body from the form's values through the real worker and timeout. See [../custom-tools/CLAUDE.md](../custom-tools/CLAUDE.md) |
| `dictation.ts` | Experimental (404 without `--experimental`): `POST /api/dictation/transcribe` (base64 clip → realtime transcription adapter → text) + `/api/dictation/cleanup` (LLM rewrite, falls back to raw). UI: `public/dictation.js` mic button on task-description fields |
| `data/` | JSON data API (`{ok, data\|error}` envelope). Every route requires `Authorization: Bearer <api-key>` — register via `data/auth.ts:addDataRoute()`, never raw `addRoute` (auth.test.ts walks the route table and fails unguarded `/data/*`). Resources: tasks (CRUD, lifecycle, review approve/reject, notes, artifacts, forensics, escalation history), teams, agents (+steer), escalations (list/detail/resolve/dismiss), dashboard, daemon, realtime tasks, global-store, scheduled tasks, logs/events |
