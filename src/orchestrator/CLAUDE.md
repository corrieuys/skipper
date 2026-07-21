# src/orchestrator

Modules called by `agents/manager-daemon.ts` facade in response to bus events.

| file | use |
|---|---|
| `tick-loop.ts` | 30s reconciliation. Health check, stale recovery, queue process, delegation/escalation cleanup, checkpoint persist, log retention. Hourly `autoDeleteOldTasks` sweep deletes finished (`completed`/`failed`) tasks past a configured age (`updated_at`), with separate day-windows for one-off vs recurring-run tasks (`app_settings.task_retention_days` / `recurring_task_retention_days`, 0 = off); deletes via `TaskScheduler.deleteTask` for the full cascade. 5-min `rotateOversizedLogFile` caps the daemon's stdout/stderr `skipper.log` (snapshot → `.old` + in-place truncate; `SKIPPER_LOG_MAX_BYTES`, default 25 MB) — only when fd 1 is that file, so dev runs are untouched |
| `task-runner.ts` | Pull next approved task. Start it. Launch entrypoint agent with prompt + phase context |
| `phase-manager.ts` | `[PHASE_COMPLETE]` + `[PHASE_REGRESSION]` handling. Regression respawn + dedup guards |
| `delegation-manager.ts` | Delegation signals. Spawn child instance/batch. Track groups. Resume parent on complete. Limits: depth 3, per-parent 20, batch 8. Timeout 60min |
| `recovery-manager.ts` | Startup cleanup, stale-task recovery, checkpoint R/W, orchestration state persist, one-shot recovery safeguard |
| `health-monitor.ts` | Liveness, orphan detect, stuck diag (30min, 3 nudges), clustered-exit escalate |
| `artifact-manager.ts` | Versioned immutable artifacts. CRUD called from MCP tools (`create_artifact`/`get_artifact`/`list_artifacts`). Per-version publish state (`publishArtifact`/`unpublishArtifact`/`getPublishedArtifact`) for public links via connect |
| `realtime-session.ts` | Realtime tasks — cadence audio/text ingest, transcribe, summarize, timeline entries, dispatch agents |
| `consensus-manager.ts` | QA-style consensus check across multi-agent phase. Agreement, not best-pick |
| `idle-poke-manager.ts` | Nudge stuck agents that go silent |
| `worktree-manager.ts` | Git worktree create/destroy per delegation |
| `state.ts` | `TaskOrchStep` state machine. Transition validate + log |
| `phase-config.ts` | `resolvePhaseConfig()` — merge team base phase + per-task `task_config.phase_overrides` (prompt + review gate + consensus) |
| `types.ts` | `OrchestrationState`, `TaskCheckpoint`, regression metadata |

## Phase advancement

Non-streaming agents advance on exit code 0 via `handleSuccessfulExit`. Active delegation blocks completion — check `getActiveDelegationForParent` first.
