# Common Failures: Exit Codes and Remediation

## Agent Process Exit Codes

### Exit 0 — Normal Completion

The agent process exited cleanly. This is the expected exit code when an agent finishes its work.

**What happens:** Skipper checks whether the agent emitted a `[TASK_COMPLETE]` or `[DELEGATE_COMPLETE]` signal before exiting. If so, the task or delegation is finalized normally. If the agent exited with 0 but did not emit a completion signal, Skipper treats it as an unexpected exit and may attempt recovery.

**Action required:** None for normal completion. If exit-0 occurs without a completion signal, check the agent's stdout logs for unexpected termination (e.g., the agent decided it was done without using the signal protocol).

### Exit 1 — Agent Error

The agent process encountered an error and exited with a generic failure code.

**What happens:** Skipper logs the error and checks the task's recovery history. If the task has not been recovered before, it may be retried (one-shot recovery policy). If it has already been recovered once, the task is marked `failed`.

**Action required:** Check the agent's terminal output (stdout/stderr captured in the event log) for error details. Common causes:
- Invalid API key or authentication failure
- Agent CLI tool not found or not on PATH
- Syntax error in the prompt
- Agent-side crash (e.g., out of context window)

### Exit 137 — SIGKILL (OOM or Timeout)

The agent process was killed by the operating system, typically due to out-of-memory (OOM) conditions or an external timeout.

**What happens:** Skipper detects the non-zero exit. Exit-code cluster detection monitors for repeated exit-137 events: three occurrences within a 5-minute window triggers an incident alert.

**Action required:**
1. Check system memory usage. Agent processes (especially Claude Code) can consume significant memory.
2. Review whether the agent was processing an unusually large context.
3. If OOM is confirmed, consider reducing `PLAYHIVE_CONTEXT_COMPACT_THRESHOLD` to trigger compaction earlier.
4. If this was an external kill (e.g., from a process manager), verify the timeout configuration.

### Exit 143 — SIGTERM (Graceful Shutdown)

The agent process received SIGTERM and shut down gracefully. This happens during:
- Daemon shutdown
- Task cancellation
- Agent replacement (e.g., when resuming with `--resume` kills the old process)

**What happens:** Skipper distinguishes between intentional SIGTERM (from its own process management) and unexpected SIGTERM (from external sources) using the `isRespawn` and `hasDelegation` guards on the `agent:exit` event.

**Action required:** None if the SIGTERM was intentional (daemon stop, task retry, delegation resume). If unexpected, check for external process managers or system-level signals.

## Runtime Failure Patterns

### Stuck WAITING_DELEGATION

**Description:** A parent agent is in `WAITING_DELEGATION` state, but its child agent has exited or was never spawned.

**Auto-remediation:** The daemon tick loop calls `checkDelegationOrphans()` which detects delegations in `pending` or `running` state whose child agent process is no longer alive. It will either:
- Resume the parent with an error message explaining the child failed
- Fail the delegation and let the parent continue

**Manual intervention:** Force a tick via `POST /api/daemon/tick`. If the orphan check does not resolve it, use "Fail Task Safely" on the parent task.

### Orphaned Tasks

**Description:** A task is in `running` state but has no live agent runtime (process has exited and no instance is tracked).

**Detection:** The daemon tick calls `checkOrphanedTasks()` which queries for tasks in `running` state and cross-references with active agent instances.

**Auto-remediation:** Orphaned tasks are either:
- Recovered (reset to `approved` for re-pickup) if they have not been recovered before
- Failed if they have already used their one recovery attempt

**Manual intervention:** Check the task's recovery count. If it has been recovered once and failed again, the issue is likely systemic. Review the agent configuration and task prompt before retrying manually.

### One-Shot Recovery Policy

Skipper uses a one-shot recovery policy for task failures: each task gets exactly one automatic recovery attempt. This prevents infinite retry loops where a fundamentally broken task keeps crashing and restarting.

**How it works:**
1. Task is `running`, agent crashes.
2. Recovery manager checks `recovery_count` on the task.
3. If `recovery_count == 0`: task is reset to `approved`, `recovery_count` incremented to 1.
4. If `recovery_count >= 1`: task is marked `failed` with a reason indicating exhausted retries.

**Overriding:** Manual retry via the API (`POST /api/tasks/:id/retry`) bypasses the one-shot limit. Use this when you have identified and fixed the root cause.

## Exit Code Cluster Detection

Skipper monitors exit codes across all agent processes. When three or more processes exit with the same non-zero code within a 5-minute window, an incident is flagged.

This is particularly important for exit 137 (OOM) clusters, which indicate system-wide resource pressure rather than a single agent failure.

**Response to a cluster alert:**
1. Check system resources (memory, disk, CPU)
2. Review how many agents are running concurrently
3. Consider pausing the daemon (`POST /api/daemon/pause`) to stop spawning new agents
4. Address the resource issue before resuming
