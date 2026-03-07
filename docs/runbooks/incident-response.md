# Incident Response Runbook

This runbook covers how to diagnose and resolve common operational issues in the Skipper orchestrator.

## Triaging Stuck Tasks

### Step 1: Check the Health Summary

The daemon tick runs every 30 seconds and includes a health check. Look at the daemon status endpoint:

```
GET /api/daemon/status
```

The response includes health information about running tasks, active agents, and any detected anomalies.

### Step 2: Use "Why Stuck?" Diagnostic

The task detail page in the dashboard includes a "Why Stuck?" diagnostic button. This runs a targeted check that reports:

- Whether the assigned agent process is still alive
- Whether the agent is in `WAITING_DELEGATION` state with no active child
- Whether the task has been in `running` state longer than expected
- Whether there are unresolved escalations blocking progress

### Step 3: Inspect Agent State

Check the agent instance state via the dashboard or API:

```
GET /api/agents
```

Look for agents stuck in `WAITING_DELEGATION` with no corresponding active delegation, or agents whose processes have exited but whose state was not cleaned up.

## Operator Actions

### Fail Task Safely

Use when a task is irrecoverably stuck and needs to be terminated without retrying.

```
POST /api/tasks/:id/fail
```

This will:
1. Kill any active agent processes associated with the task
2. Mark the task as `failed`
3. Clean up delegation records
4. Record the failure reason

### Retry Task

Use when a task failed due to a transient issue and should be re-attempted.

```
POST /api/tasks/:id/retry
```

This will:
1. Reset the task status to `approved`
2. Clear the current agent assignment
3. The daemon will pick it up on the next tick

Note: Skipper uses a one-shot recovery policy. If a task has already been recovered once, it will be failed rather than retried again. Manual retry via this endpoint overrides that guard.

### Clear Stale Assignments

Use when agent processes have died but their task/delegation assignments remain.

The daemon tick automatically runs stale assignment detection, but you can force an immediate check:

```
POST /api/daemon/tick
```

This triggers a single daemon tick which includes `checkOrphanedTasks()` and `checkDelegationOrphans()`.

## Common Failure Patterns

### Pattern: Task stuck in `running` with dead agent

**Symptoms:** Task shows `running` but no agent process is active. Health monitor reports the task as stuck.

**Cause:** Agent process crashed or was killed externally without Skipper receiving the exit event.

**Resolution:** The daemon tick's orphan detection should catch this automatically. If not, use "Fail Task Safely" or "Retry Task".

### Pattern: Delegation chain stalled

**Symptoms:** Parent agent is in `WAITING_DELEGATION`, child agent has exited, but parent was never resumed.

**Cause:** The `agent:exit` handler for the child did not trigger parent resumption, possibly due to a race condition between `agent:exit` and `agent:streams_drained` events.

**Resolution:** The `checkDelegationOrphans()` routine in the tick loop detects and remediates this. Force a tick if needed. If the delegation is truly orphaned, the parent will be resumed with an error message or the task will be failed.

### Pattern: Repeated escalations from same agent

**Symptoms:** An agent keeps emitting `[ESCALATE]` signals for the same or similar questions.

**Cause:** The agent lacks the information it needs and keeps asking. Resolving escalations with insufficient context leads to re-escalation.

**Resolution:** Review the escalation history for the task. Provide a comprehensive answer that addresses the root information gap. Consider whether the task prompt needs to be rewritten with more context.

### Pattern: Delegation loop (agent delegates to itself)

**Symptoms:** Rapid creation of child agents, delegation count increasing quickly.

**Cause:** Self-delegation or circular delegation chains.

**Resolution:** `MAX_DELEGATIONS_PER_PARENT=3` prevents this from running away. The task will be failed once the limit is hit. Review the agent's prompt to eliminate the instruction that causes self-delegation.

## Dashboard Metrics to Watch

### MTTR (Mean Time To Recovery)

Track how long tasks spend between entering a failure state and being successfully retried. Rising MTTR indicates systemic issues with recovery paths.

### Stuck-Task Rate

The ratio of tasks that enter a stuck state (detected by health monitor) to total tasks run. A healthy system should have a stuck-task rate below 5%.

### Delegation Success Rate

The percentage of delegations that complete successfully (child returns `[DELEGATE_COMPLETE]`) versus those that fail or are orphaned. Low delegation success rates point to problems with child agent prompts or agent type configuration.

### Exit Code Distribution

Monitor the distribution of agent process exit codes. A cluster of exit code 137 (OOM/SIGKILL) events indicates resource pressure. Three exit-137 events within 5 minutes triggers an incident alert.

### Escalation Volume

Track the rate of new escalations. A spike often indicates that agent prompts are missing critical context or that a new type of task is exposing gaps in the signal protocol.

## Escalation Handling

### Viewing Escalations

```
GET /api/tasks/:id/escalations
```

Or view them on the task detail page in the dashboard.

### Resolving Escalations

```
POST /api/tasks/:id/escalations/:escalationId/resolve
Body: { "response": "..." }
```

When an escalation is resolved:
1. The response is recorded in the escalation record
2. The response is injected into the agent via `--resume` (not just stored in DB)
3. The agent continues execution with the new context

**Important:** Resolving an escalation via raw DB update (bypassing the API) will NOT inject the response into the agent. Always use the API endpoint or dashboard UI.
