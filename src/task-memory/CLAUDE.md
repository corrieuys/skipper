# src/task-memory

Per-task memory (experimental). A task whose memory scope is on keeps a copy of
every operator-facing exchange on it, embedded, so any agent on the task can ask
"what happened before me" through the `query_task_memory` MCP tool. Written by
the daemon only; agents read, and may soft-delete a wrong entry
(`delete_task_memory`), but never write.

## Scopes (one-off vs recurring)

`scope.ts` decides where a task's memory lives (`resolveMemoryScope`):

| task | setting | scope |
|---|---|---|
| one-off | `task_config.memory_enabled` (Memory pill / checkbox) | `task:<id>` |
| run of a recurring task | the **series'** `scheduled_tasks.task_config.memory_mode`: `off` / `run` / `shared` (+ `memory_retention_days`) | `run` → `task:<run id>`; `shared` → `series:<scheduled_task_id>` |

Runs read the series live (not their spawn-time config snapshot), so flipping
the series applies to runs in flight and a run can never diverge; the run's own
pill is a link to the series. Rows are owned by the scope: no FK on `task_id`
(recurring-run retention must not erase shared memory), `run_label` captured at
write time so attribution survives run deletion, `TaskScheduler.deleteTask`
removes only `task:<id>`, `ScheduledTaskScheduler.deleteScheduledTask` removes
`series:<id>`. Series retention (`memory_retention_days`, 0 = keep) prunes the
shared scope on every write and backfill (`prune`). Turning a series off stops
writes and keeps rows; Clear memory (`clearScope`) is the separate destructive
step. The v1 (FK) shape is rebuilt by `legacy-migrations.ts:migrateTaskMemoryScope`.

| file | use |
|---|---|
| `manager.ts` | `TaskMemoryManager`. `start()` subscribes to `task:note_added`, `task:message_posted`, `realtime:timeline_updated` and copies the source row into `task_memory` when the task's flag is on (`recordNote` / `recordMessage` / `recordTimelineEntry`; live events stamp the daemon clock, see `normalizeTimestamp`). `backfill(taskId)` copies what already exists when the toggle flips on (idempotent via the `(task_id, ref_id)` unique index). Background embedding queue (`scheduleFlush` / `flushEmbeddings` / `flushAll`, 32 rows per call, 30 s retry on failure); rows embedded under another `embedding_model` are re-embedded and hidden until then. `query()` = the semantic tool: flush, embed the query, cosine over the scope's live rows in JS (unit vectors, dot product), top-N (default `DEFAULT_QUERY_LIMIT` 10, max 50), returned **oldest first**, each hit with `id`, `created_at`, author/kind/agent and `run { id, label, this_run }`. Shared scope: `scope: "run"` restricts to the caller's run, `runId` to one run, `since` to a time window; without a run filter at most `MAX_HITS_PER_RUN` (3) hits per run so one repeated line cannot fill a result. Throws when memory is off or no embedder resolves; there is deliberately no keyword fallback. `deleteEntry()` = `delete_task_memory`: soft delete (`deleted_at/deleted_by/delete_reason`, hidden from queries + flush) of an entry in the caller's scope, plus an audit `task_notes` row on the calling task ("Deleted memory entry <id>: <reason> ...") emitted as `task:note_added`, so the operator sees it (and it lands in memory itself). `backfillSeries(seriesId)` copies every run still in the DB into the shared scope. `searchContent()` = the separate keyword tool over one source (`notes` live rows, `artifacts` latest version per name incl. file captions, `messages`); `keywordScore` (distinct term hits weigh most) + `snippetAround` |
| `embeddings.ts` | `resolveEmbedder(db, server)` → `Embedder` or `{ reason }`. Both backends are OpenAI-compatible `/v1/embeddings` via `@ai-sdk/openai-compatible` `.embeddingModel` + `embedMany`: **local** (the managed llama-server; `ready()` starts it lazily) or **custom** (base URL + `${ENV}` key + model id). `modelKey` names the vector space (`local:<id>` / `custom:<url>:<model>`). Vectors are normalised on the way in. Documents are cut to the model's `docMaxChars` |
| `local-server.ts` | `EmbeddingServerManager`. Installs and runs `llama-server` under `<data dir>/llama/` (never the source tree, so the compiled binary works): `installBinary()` scans the llama.cpp GitHub releases for the newest `b<build>` tag carrying this platform's asset (`llamaAssetSuffix`: macos-arm64 / macos-x64 / ubuntu-x64 / ubuntu-arm64; the `latest` pointer has no binaries), downloads + `tar -xzf`, records `binary.json`; `installModel(id)` streams the GGUF from Hugging Face with a byte-count check. `ensureRunning(modelId)` spawns `llama-server --embedding --pooling <model> -c/-ub/-b <ctx> --no-webui` on `127.0.0.1:8089` (`SKIPPER_EMBED_PORT`), health-polls `/health`, restarts when the model changes, kills on exit. `getStatus()` feeds the config panel (download progress included). `SKIPPER_EMBED_LOG=1` echoes server output |
| `catalogue.ts` | `LOCAL_EMBEDDING_MODELS`: curated GGUF models (bge-small default, MiniLM, bge-base, nomic) with URL, size, dims, pooling, ctx, `docMaxChars`, nomic's query/document prefixes |
| `scope.ts` | `MemoryMode`, `resolveMemoryScope(db, taskId)` (series live, else the task's own flag), `readSeriesMemoryConfig`, `seriesScopeId`/`taskScopeId`, `runLabelFor` |
| `summary.ts` | `taskMemorySummary(db, taskId)` / `scopeSummary(db, scopeId, meta)`: mode, scope, runs (distinct contributing runs), live entries, vectors, pending, deleted, models, dims, stored sizes via SQL `length()` aggregates (metadata reads, so no per-row size column), retention. Shown as the **Memory** row in the task Details modal (with a link to the series for runs), the series **Memory** panel, and as `memory_summary` on connect `tasks/read` |
| `settings.ts` | Machine-scoped `app_settings` keys (`task_memory_*`): endpoint local|custom, local model id, custom base URL / API key (`${ENV_VAR}` resolved at call time) / model id. `getTaskMemoryConfig`, `saveTaskMemoryConfig` |

## What is recorded

| kind | source | author |
|---|---|---|
| `message` | `task_messages` (`post_message`) | agent |
| `input` | `realtime_timeline` type `text` (typed operator input) | user |
| `summary` | `realtime_timeline` type `summary` (audio digest; raw transcripts are not stored) | user |
| `note` | `task_notes` (`source` column decides) | agent or user |

Images, files, pipeline errors and raw agent stdout are not memory.

## Surfaces

- Toggle: `memoryEnabled` checkbox on the three create forms, the **Memory** pill
  beside Autopilot on the task view (`POST /api/tasks/:id/memory`, backfills on
  enable), `TaskScheduler.setMemoryEnabled`. Field on `TaskSummary.memory_enabled`.
- Recurring: tri-state + retention on the create form (Schedule = Recurring), the
  draft Configuration form, and the approved detail's **Memory** panel
  (`renderSeriesMemoryPanel`: summary + Clear memory; `POST
  /api/scheduled-tasks/:id/memory` backfills every run when set to shared,
  `/memory/clear` hard-deletes the series scope). `POST /api/tasks/:id/memory`
  refuses runs (400).
- Prompt: `prompts/task-memory.md` is injected (root, delegated, solo) only when
  the scope is on: query early, judge hits by their timestamp, note any
  contradictory/stale entry (`create_note`) and delete it with
  `delete_task_memory` when clearly wrong. `task-memory-shared.md` is appended
  for a shared scope (hits carry their run, prefer newest, verify earlier runs'
  claims). The tool catalogues list all three tools.
- Config page **Task Memory** panel (`html/fragments/task-memory-config.fragment.ts`,
  routes in `routes/task-memory.ts`): endpoint + model, download / start / stop,
  status fragment polled every 2 s while a download or a server start runs (Start returns at once in the "starting" state).
- MCP: `query_task_memory`, `delete_task_memory`, `search_task_content` (all on every internal session;
  in the custom-agent catalogue and `SOLO_ESSENTIAL_TOOLS`). `DaemonDeps.taskMemoryManager`
  is optional; without it the tools answer "not available".
- Storage: `task_memory` (migration `0025_task_memory.sql`, no FK; see Scopes
  above for who deletes what).
