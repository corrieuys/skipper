# Known Incidents — Postmortems from E2E Testing

This document records incidents discovered during end-to-end testing of the Skipper orchestrator, along with root causes, fixes, and prevention measures.

---

## Incident 1: Database Not Initialized on Startup

**What happened:** The server started and accepted HTTP requests, but all API calls failed with SQLite errors ("no such table"). The database schema had never been applied.

**Root cause:** `initializeDatabase()` was only being called in test setup code. The production entry point (`index.ts`) did not call it before starting the server.

**Fix applied:** Added `initializeDatabase()` call in `index.ts` before creating the ManagerDaemon and registering routes. The function is now the first thing that runs on startup.

**Prevention measure:** The server startup sequence is explicitly ordered: DB init, then daemon construction, then route registration, then listen. A test was added to verify that `getDb()` throws if called before initialization.

---

## Incident 2: Signal Routing Not Wired

**What happened:** Agents were spawned and produced stdout output, but no signals were ever processed. Tasks would run indefinitely because `[PHASE_COMPLETE]` and `[TASK_COMPLETE]` signals were ignored.

**Root cause:** `processStdoutBuffer()` in `AgentManager` correctly extracted structured lines from the stdout stream and buffered them, but the extracted lines were never passed to the signal parser. The parsing step (`parseAgentOutput()`) and the event bus emission (`agent:signal`) were implemented but not connected to the buffer processing pipeline.

**Fix applied:** Wired the stdout buffer processing to call `parseAgentOutput()` for each extracted line, which in turn emits `agent:signal` events on the event bus. The ManagerDaemon's signal handler was already listening for these events.

**Prevention measure:** Added integration tests that spawn a mock agent process emitting signal lines and verify that the corresponding event bus events fire. These tests cover the full path from stdout to event bus.

---

## Incident 3: No Self-Delegation Guard

**What happened:** An agent emitted `[DELEGATE to:agent-1] do something` where `agent-1` was itself. This caused a new instance of the same agent to be spawned as a child, which then also tried to delegate to itself, creating a runaway spawn loop.

**Root cause:** `DelegationManager.handleDelegate()` did not check whether the target agent ID matched the delegating agent's own ID. The signal protocol allowed any agent ID in the `to:` field without validation.

**Fix applied:** Added a guard in `DelegationManager.handleDelegate()` that rejects delegations where the target agent is the same as the source agent. The parent is resumed with an error message explaining that self-delegation is not permitted.

**Prevention measure:** The `MAX_DELEGATIONS_PER_PARENT=3` limit was also introduced as a broader safety net (see Incident 6). Even if a circular delegation chain involves multiple agents, it will be terminated after 3 hops from any single parent.

---

## Incident 4: Escalation Resolve Did Not Inject Response

**What happened:** An operator resolved an escalation via the dashboard, entering a detailed response. The escalation was marked as resolved in the database, but the agent never received the response and remained stuck waiting.

**Root cause:** The pages route handler for escalation resolution performed a raw SQL UPDATE on the escalation record, setting `status = 'resolved'` and storing the response text. However, it did not call the agent resume logic. The agent was waiting for input via `--resume`, and merely updating the DB record did not deliver the response to the running process.

**Fix applied:** Changed the escalation resolution handler to go through the proper `ManagerDaemon.resolveEscalation()` method, which updates the DB record AND resumes the agent with the response injected into the prompt.

**Prevention measure:** The pages route handlers now delegate all state-changing operations to ManagerDaemon methods rather than performing direct DB updates. This ensures that side effects (process management, event emission) are always executed.

---

## Incident 5: Parent Exit During Active Delegation

**What happened:** A parent agent exited (process terminated) while it had an active child delegation in progress. The `handleAgentExit` handler saw the parent exit and marked the task as completed/failed, even though the child agent was still running and had not returned its result.

**Root cause:** `handleAgentExit()` did not check whether the exiting agent had active delegations. It treated all exits the same way: if the task was running and the agent exited, transition the task.

**Fix applied:** Added a `hasDelegation` guard to the `agent:exit` event. When an agent exits and has an active delegation (child agent still running), the exit handler skips task finalization. Instead, it marks the parent instance as `WAITING_DELEGATION` and lets the delegation flow complete normally. If the child later completes, the parent is resumed. If the child also fails, the delegation orphan detection handles cleanup.

**Prevention measure:** The `agent:exit` event now carries explicit flags (`isRespawn`, `hasDelegation`) that gate downstream behavior. Tests verify that parent exit during delegation does not prematurely complete the task.

---

## Incident 6: Delegation Loop

**What happened:** A parent agent was resumed with a child's result via `--resume`. Upon receiving the result, the parent immediately emitted another `[DELEGATE]` signal, spawning a new child. When that child completed and the parent was resumed again, it emitted yet another `[DELEGATE]`, creating an infinite loop of delegation and resumption.

**Root cause:** The agent's prompt or behavior caused it to interpret delegation results as triggers for further delegation. There was no limit on how many times a parent could delegate. Each resume-delegate cycle consumed resources and created orphaned processes.

**Fix applied:** Introduced `MAX_DELEGATIONS_PER_PARENT=3` in `DelegationManager`. Each parent agent instance tracks how many delegations it has spawned. When the limit is reached, further `[DELEGATE]` signals from that parent are rejected, and the parent is resumed with an error message instructing it to complete its work without further delegation.

**Prevention measure:** The delegation count is tracked per parent instance and persisted in the delegation records. The limit of 3 was chosen to allow legitimate multi-step delegation while preventing runaway loops. The prompt builder also includes guidance about delegation limits in the agent's context.
