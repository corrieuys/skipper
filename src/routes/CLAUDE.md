# src/routes

HTTP handlers. Registered in `index.ts` against `server.ts` router. Each gets `ManagerDaemon` facade.

| file | use |
|---|---|
| `tasks.ts` | Task CRUD + lifecycle (approve/unapprove/cancel/retry/resume/iterate). Detail/fragments. Health diag. Stale runtime cleanup |
| `teams.ts` | Team CRUD (teams embed their own agents + phases) under `/api/teams`, plus `/api/teams/export` + `/api/teams/import` |
| `daemon.ts` | Pause/resume/status + dashboard refresh fragment |
| `pages.ts` | Server-rendered HTML pages + polling fragments. Dashboard, tasks, escalations, logs, events, config, help. Teams are managed on `/config`; team forms at `/config/teams/new` and `/config/teams/:id/edit` |
| `realtime.ts` | Realtime task pages + API — create/start/stop/resume/close, text/audio input, timeline/notes/agents/pipeline, per-task agent assign |
| `realtime-ws.ts` | WebSocket endpoint for realtime task event stream |
| `skipper.ts` | Skipper config `GET/PUT` w/ agent-type+model validate. Optional HTML fragment render |
| `conversations.ts` | Chat conversation API (see `../conversations/`) |
| `scheduled-tasks.ts` | CRUD for scheduled (cron) tasks |
| `utils.ts` | HTML response + body parse (form/json) helpers |
| `data/` | Data-only route handlers returning JSON |
