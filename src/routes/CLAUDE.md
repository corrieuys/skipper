# src/routes

HTTP handlers. Registered in `index.ts` against `server.ts` router. Each gets `ManagerDaemon` facade.

| file | use |
|---|---|
| `agents.ts` | Agent CRUD + UI fragments. Runtime sessions + steer actions |
| `tasks.ts` | Task CRUD + lifecycle (approve/unapprove/cancel/retry/resume/iterate). Detail/fragments. Health diag. Stale runtime cleanup |
| `teams.ts` | Team CRUD, phase edit, membership, config persist |
| `daemon.ts` | Pause/resume/status + dashboard refresh fragment |
| `pages.ts` | Server-rendered HTML pages + polling fragments. Dashboard, tasks, agents, teams, escalations, logs, events, config, help |
| `realtime.ts` | Realtime task pages + API — create/start/stop/resume/close, text/audio input, timeline/notes/agents/pipeline, per-task agent assign |
| `realtime-ws.ts` | WebSocket endpoint for realtime task event stream |
| `skipper.ts` | Skipper config `GET/PUT` w/ agent-type+model validate. Optional HTML fragment render |
| `conversations.ts` | Chat conversation API (see `../conversations/`) |
| `scheduled-tasks.ts` | CRUD for scheduled (cron) tasks |
| `templates.ts` | Task template CRUD |
| `utils.ts` | HTML response + body parse (form/json) helpers |
| `data/` | Data-only route handlers returning JSON |
