## Harness hardening checklist

Use this checklist to move Skipper toward a reliable agent-first engineering harness.

### 1) Runtime correctness and safety
- [ ] Enforce canonical process ownership invariants (template agent vs runtime instance PID semantics).
- [ ] Add guards for `WAITING_DELEGATION` with no live child runtime.
- [ ] Add deterministic timeout handling for stalled delegation groups.
- [ ] Ensure task terminal states auto-clean all stale assignment pointers (`agents.current_task_id`, `process_pid`).
- [ ] Prevent duplicate or conflicting orchestration transitions in a single tick.

### 2) Recovery and auto-remediation
- [ ] Add a periodic orphaned-task detector (`running` task with zero live runtimes).
- [ ] Add a one-shot recovery policy before failover (recover once, then fail with explicit reason).
- [ ] Record remediation actions in events (what was auto-recovered, what was force-failed, and why).
- [ ] Add startup reconciliation checks for daemon ownership and interrupted runtime rows.

### 3) Observability and diagnostics
- [ ] Emit structured incident events for exit-code clusters (e.g. repeated `137` within a window).
- [ ] Add per-task health summary fields: live runtimes, active delegations, last progress timestamp.
- [ ] Add dashboards/queries for MTTR, stuck-task rate, delegation success rate, retry rate, and false-orphan rate.
- [ ] Add a “why stuck?” diagnostic payload generated directly from DB/runtime state.

### 4) UI/UX clarity
- [ ] Unify status semantics across dashboard and forensics (separate process outcome vs workflow state).
- [ ] Add explicit stale-state badges and age indicators.
- [ ] Collapse noisy forensic sections into progressive disclosure with clear defaults.
- [ ] Add one-click operator actions for “Fail task safely”, “Retry task”, and “Clear stale assignments”.
- [ ] Add a single task incident timeline that merges transitions, exits, retries, delegations, and escalations.

### 5) Agent behavior and delegation quality
- [ ] Enforce delegation target validation by ID or unique name with explicit ambiguity errors.
- [ ] Add policy checks to block invalid loops/self-delegation at signal-parse time.
- [ ] Add escalation triggers when repeated child failures exceed threshold.
- [ ] Add per-role delegation strategy validation (investigation -> analyst, implementation -> developer, QA -> tester).

### 6) Repository knowledge system
- [ ] Add `AGENTS.md` as a concise map (not a monolith), with links to source-of-truth docs.
- [ ] Create a structured `docs/` tree (`architecture`, `runbooks`, `reliability`, `incident-patterns`, `plans`).
- [ ] Store incident postmortems and remediation decisions in-repo and cross-link from runbooks.
- [ ] Add doc freshness checks in CI for critical operator/runbook docs.

### 7) CI and policy enforcement
- [ ] Add invariant tests for orchestration state machine transitions and forbidden state combinations.
- [ ] Add regression tests for known incidents (false orphan-kill, stuck `WAITING_DELEGATION`, repeated `137` loop).
- [ ] Add a presubmit “harness health” suite (critical orchestrator tests must pass).
- [ ] Block merge when key reliability metrics regress beyond thresholds.

### 8) Immediate next actions (recommended order)
- [ ] Ship guard for `WAITING_DELEGATION` with no live child runtime.
- [ ] Add incident detector for repeated child exit `137` and force escalation/failover.
- [ ] Redesign forensics status model and labels to remove conflicting states.
- [ ] Add first-pass `AGENTS.md` + `docs/runbooks/incident-response.md`.
