# PlayHive Orchestrator: Complete Lifecycle Reference

This document describes the full lifecycle of tasks, agents, teams, and agent delegation in the PlayHive orchestrator. It covers every step from entity creation through execution, inter-agent communication, session management, and cleanup.

---

## Table of Contents

1. [Core Entities](#core-entities)
2. [Team Setup](#team-setup)
3. [Agent Creation & Configuration](#agent-creation--configuration)
4. [Task Lifecycle](#task-lifecycle)
5. [Agent Process Spawning](#agent-process-spawning)
6. [Prompt Construction & Delivery](#prompt-construction--delivery)
7. [Agent Output Processing](#agent-output-processing)
8. [Phase Advancement](#phase-advancement)
9. [Phase Regression](#phase-regression)
10. [Agent Delegation](#agent-delegation)
11. [Escalation (Human-in-the-Loop)](#escalation-human-in-the-loop)
12. [Task Notes (Inter-Agent Knowledge)](#task-notes-inter-agent-knowledge)
13. [Session Resume (--resume)](#session-resume---resume)
14. [Process Exit Handling](#process-exit-handling)
15. [Health Checks & Stuck Detection](#health-checks--stuck-detection)
16. [Cleanup & Recovery](#cleanup--recovery)

---

## Core Entities

### Agent Types (`agent_types` table)

Agent types define how a CLI tool is invoked. Each type specifies:

- **command**: The CLI binary (e.g., `claude`, `codex`)
- **args**: Default arguments as a JSON array
- **model_flag**: How to pass a model name (e.g., `--model`)
- **available_models**: JSON array of valid model names
- **env_vars**: Environment variable templates (e.g., `{"ANTHROPIC_MODEL": "$MODEL"}`)
- **supports_stdin**: Whether the CLI accepts streaming stdin (currently `false` for all built-in types)

Built-in types:

| Type | Command | Mode | Notes |
|------|---------|------|-------|
| `claude-code` | `claude` | Exec (read stdin once, exit) | `--print --output-format stream-json --verbose --dangerously-skip-permissions` |
| `codex` | `codex` | Exec (read stdin once, exit) | `exec --json --dangerously-bypass-approvals-and-sandbox -` |
| `custom` | (user-defined) | Varies | Empty default args |

All current agent types are **exec-mode**: they read stdin once, process the prompt, and exit. None maintain a persistent stdin stream. Multi-turn conversation is achieved through the `--resume` mechanism (see [Session Resume](#session-resume---resume)).

### Agents (`agents` table)

An agent is a named instance of an agent type. It holds:

- **type**: References an agent type name (e.g., `claude-code`, `codex`)
- **model**: Which model to use (e.g., `opus`, `sonnet`, `default`). `default` means don't pass any model flag.
- **config**: JSON with `goal` (agent's role description), `model`, `environment` vars, `constraints` (like `workingDirectory`)
- **capabilities**: JSON array of capability strings
- **status**: `idle | busy | error | stopped`
- **process_pid**: OS PID when running, `NULL` when stopped
- **current_task_id**: The task this agent is working on

### Teams (`teams` table)

A team groups agents together and defines execution structure:

- **entrypoint_agent_id**: The agent that starts working when a task is assigned
- **phases**: JSON array of `{name, prompt}` objects defining sequential work stages
- **goal**: Description of what the team does

### Team Agents (`team_agents` table)

Links agents to teams with hierarchy:

- **role**: Free-text role (e.g., `lead`, `qa`, `developer`)
- **level**: Hierarchy level (0 = top)
- **parent_agent_id**: Parent in hierarchy
- **skills**: JSON array of skill tags
- **max_complexity**: Story point limit (1-10)

### Tasks (`tasks` table)

A unit of work assigned to a team:

- **team_id**: Which team executes this task
- **status**: `draft | approved | running | completed | failed`
- **current_phase**: Which phase is currently executing (0-indexed)
- **priority**: 1-10 (lower = higher priority)
- **result**: JSON with outcome data

---

## Team Setup

Teams are created via `POST /api/teams` with a name, goal, and optional phases. Agents are added to teams via `POST /api/teams/:id/agents` with a role, skills, and optional parent agent.

The **entrypoint agent** is set on the team — this is the agent that gets spawned when a task starts. Other agents in the team are available for delegation.

**Key relationship**: A team's entrypoint agent runs the task directly. Other team members are only spawned when the entrypoint agent (or another running agent) explicitly delegates to them via the `[DELEGATE]` signal.

---

## Agent Creation & Configuration

Agents are created via `POST /api/agents`:

```
POST /api/agents
{
  "name": "Lead Developer",
  "type": "claude-code",
  "model": "sonnet",
  "capabilities": ["coding", "architecture"],
  "goal": "Lead developer responsible for implementation"
}
```

The `AgentManager.createAgent()` method (`src/agents/manager.ts:74`) persists the agent to the database and initializes its config. The agent is not spawned at creation time — it remains in `idle` status until a task triggers it.

**Agent type resolution**: When an agent is spawned, the orchestrator looks up its type in the `agent_types` table via `getAgentTypeDefinition()` (`src/agents/types.ts`). This provides the command, args, model flag, and other CLI-specific configuration. The type definitions are cached in memory for performance.

---

## Task Lifecycle

### State Machine

```
draft → approved → running → completed
                          ↘ failed
```

### Step-by-Step Flow

#### 1. Task Creation (`draft`)

`TaskScheduler.createTask()` (`src/tasks/scheduler.ts:6`) creates a task with title, description, team assignment, and priority. Status starts as `draft`.

```
POST /api/tasks
{ "title": "Update hello.md", "description": "Change content to foobar", "teamId": "..." }
```

#### 2. Task Approval (`approved`)

`TaskScheduler.approveTask()` (`src/tasks/scheduler.ts:103`) validates the task has a team assigned and transitions to `approved`. Only draft tasks can be approved.

```
POST /api/tasks/:id/approve
```

#### 3. Task Pickup (`running`)

The **Manager Daemon** (`src/agents/manager-daemon.ts`) runs a check loop every 30 seconds. In `processTaskQueue()` (line 277):

1. Checks if any task is already running (only one task runs at a time)
2. Fetches the highest-priority approved task via `getNextApprovedTask()`
3. Looks up the team and its entrypoint agent via `teamManager.getTeamForExecution()`
4. Kills the entrypoint agent if it's already running (clean slate)
5. Spawns the entrypoint agent process
6. Assigns the task to the agent
7. Transitions task status to `running`
8. Builds the initial prompt and sends it to stdin
9. Registers an exit handler to detect task completion/failure

#### 4. Task Completion (`completed`)

A task completes when:
- **Exec-mode agent exits with code 0** and all phases are done — the daemon's exit handler calls `taskScheduler.completeTask()`
- **Streaming agent outputs `[PHASE_COMPLETE]`** on the last phase — `handlePhaseComplete()` calls `taskScheduler.completeTask()`
- **Agent outputs `[TASK_COMPLETE task:<id>]`** — explicit completion signal

#### 5. Task Failure (`failed`)

A task fails when:
- Agent exits with non-zero code
- Agent process dies unexpectedly (detected by daemon health checks)
- Task is cancelled by user (`POST /api/tasks/:id/cancel`)
- Entrypoint agent spawn fails
- Team has no entrypoint agent

#### 6. Task Retry

`POST /api/tasks/:id/retry` resets a failed task back to `draft` with `current_phase = 0` and clears the result. It can then be re-approved and picked up again.

---

## Agent Process Spawning

`AgentManager.spawnAgent()` (`src/agents/manager.ts:109`) is the core process creation method.

### Spawn Sequence

1. **Resolve agent type**: Look up the `AgentTypeDefinition` from the `agent_types` table
2. **Build command args**: Start with the type's default args, optionally append `--resume <sessionId>` for multi-turn, and append model flag if not `default`
3. **Prepare environment**:
   - Inherit `process.env`
   - Apply agent's custom environment from config
   - Set `AGENT_ID`, `AGENT_NAME`, `AGENT_TYPE`
   - **Delete `CLAUDECODE`** env var (critical: prevents nested claude sessions from conflicting)
   - Apply `env_vars` templates from agent type (e.g., `ANTHROPIC_MODEL` → actual model name)
4. **Spawn via `Bun.spawn`**:
   ```typescript
   spawn({
     cmd: [definition.command, ...args],
     cwd: workingDir,
     env,
     stdout: 'pipe',
     stderr: 'pipe',
     stdin: 'pipe',
   })
   ```
5. **Track in memory**: Store in `this.agents` Map as a `RunningAgent` with stdout/stderr buffers and output sequence counter
6. **Update DB**: Record the process PID in the `agents` table
7. **Clear old output**: Delete previous `terminal_outputs` rows for this agent
8. **Wire output handlers**: Start reading stdout/stderr streams
9. **Register exit handler**: Listen for process exit via `process.exited` promise

### Bun Process I/O

- **stdin**: `Bun.spawn` with `stdin: 'pipe'` returns a **FileSink** object, not a Web Stream. Use `.write()`, `.flush()`, and `.end()` methods.
- **stdout/stderr**: `Bun.spawn` with `stdout: 'pipe'` returns a **ReadableStream**. Use `.getReader()` to get a `ReadableStreamDefaultReader<Uint8Array>`.

### Output Stream Reading

`readStream()` (line 219) continuously reads from stdout/stderr:

1. Read chunks from the stream reader
2. Decode each chunk as UTF-8
3. Store in `terminal_outputs` table with incrementing sequence number
4. Emit `agent:output` event for real-time UI updates (SSE/WebSocket)
5. Buffer stdout for line-based parsing in `processStdoutBuffer()`

`processStdoutBuffer()` (line 264) splits buffered stdout by newlines, keeping incomplete lines in the buffer. Each complete line is passed to `parseAgentOutput()` for signal detection.

---

## Prompt Construction & Delivery

### Initial Task Prompt

When the daemon picks up a task, it builds the prompt in `processTaskQueue()` (daemon line 277):

**Without phases** (simple task):
```
GOAL: <agent's goal from config>

TASK: <task title>
<task description>

When you have completed this task, output [PHASE_COMPLETE] on its own line.

<prompt enrichment>
```

**With phases**:
```
GOAL: <agent's goal>

TASK: <task title>
<task description>

CURRENT PHASE (1/3): <phase name>
<phase prompt>

When you have completed this phase, output [PHASE_COMPLETE] on its own line.

<prompt enrichment>
```

Note: The `[PHASE_COMPLETE]` instruction is only included for streaming agents. Exec-mode agents signal completion by exiting with code 0.

### Prompt Enrichment

`buildPromptEnrichment()` (daemon line 668) appends context to every prompt:

```
TEAM ROSTER (use agent IDs for delegation):
- ID: abc123 | Name: QA Agent | Role: quality-assurance | Skills: testing, code-review
- ID: def456 | Name: DevOps Agent | Role: deployment | Skills: docker, ci-cd

NOTES FROM OTHER AGENTS:
- [Lead Dev] The auth config is in /etc/app.conf, not where you'd expect

AVAILABLE COMMANDS:
- To delegate work to a team member: [DELEGATE to:<agent-id>] description of work
- To ask the human user a question: [ESCALATE] your question here
- To record an important note for other agents: [NOTE] short note about sharp edges or critical context
```

The delegation command is only shown if:
1. There are other team members to delegate to
2. The agent supports delegation (streaming or has `--resume` support)

### Sending the Prompt

`sendInput()` (`src/agents/manager.ts:1245`):

```typescript
stdin.write(input + '\n');
stdin.flush();

if (closeStdin) {
  stdin.end(); // Signal EOF for exec-mode agents
}
```

For exec-mode agents, `closeStdin` is `true` — the agent reads all of stdin, processes it, and exits. Without closing stdin, exec-mode agents hang forever waiting for more input.

---

## Agent Output Processing

### Line Parsing: `parseAgentOutput()` (line 276)

Each complete line of stdout is checked in order:

1. **JSON detection**: If line starts with `{`, try to parse as JSON → `handleJsonOutput()`
2. **Agent message**: `[MSG:type to:AgentName] content` → `handleAgentMessage()`
3. **Delegation**: `[DELEGATE to:<agent-id>] prompt` → `handleDelegation()`
4. **Delegation complete**: `[DELEGATE_COMPLETE] result` → `handleDelegateComplete()`
5. **Escalation**: `[ESCALATE] question` → `handleEscalation()`
6. **Task note**: `[NOTE] content` → `handleNote()`
7. **Task complete**: `[TASK_COMPLETE task:<id>] result` → `handleTaskComplete()`
8. **Phase complete**: `[PHASE_COMPLETE]` → `handlePhaseComplete()`
9. **Default**: Log the line

### JSON Output Handling: `handleJsonOutput()` (line 346)

Handles structured output from both Claude Code (stream-json) and Codex CLI (JSON events).

**Session ID capture**: Any JSON event carrying a `session_id` field is captured and stored on the `RunningAgent` object. This is critical for `--resume` support.

**Text extraction**: `extractTextFromJsonEvent()` (line 500) extracts text content from various JSON formats:

- **Claude Code**: `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}` — extracts text from content array items with `type === "text"`
- **Codex CLI**: `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}` — extracts from `item.text`
- **Result events**: `{"type":"result","result":"..."}` — extracts the result string

**Signal detection in JSON**: `detectSignalsInText()` (line 455) scans extracted text for all orchestrator signals (`[DELEGATE]`, `[ESCALATE]`, `[NOTE]`, `[PHASE_COMPLETE]`, `[DELEGATE_COMPLETE]`). This is necessary because agents often embed signals inside their structured JSON output rather than on raw stdout lines.

**Event type handling**: The switch statement (line 374) handles:
- `item.completed` — Codex agent messages, reasoning, tool calls
- `turn.completed` — Codex turn completion with usage stats
- `message` — Older codex format
- `assistant` — Claude Code assistant responses
- `result` — Claude Code final result
- `system`, `rate_limit_event` — Silently ignored
- `error` — Logged as errors
- Default — Background events, config dumps logged

---

## Phase Advancement

Teams can define multiple phases that execute sequentially. Phase advancement works differently for exec-mode vs streaming agents.

### Streaming Agents

When a streaming agent outputs `[PHASE_COMPLETE]`, `handlePhaseComplete()` (line 935):

1. Finds the running task for this agent
2. Guards against duplicate signals (dedup set)
3. If this was the last phase → `completeTask()`
4. If more phases remain → `advancePhase()`, then:
   - For exec-mode: kill agent, respawn (optionally with `--resume`), send next phase prompt, close stdin
   - For streaming: send next phase prompt directly to existing stdin

### Exec-Mode Agents

When an exec-mode agent exits with code 0, the daemon's exit handler (line 372):

1. Checks if there are more phases
2. If yes: advances phase, respawns agent (with `--resume` if supported), sends next phase prompt
3. If no: completes the task
4. Non-zero exit code: fails the task

The daemon exit handler has a **1-second grace period** (`setTimeout`) to allow stdout processing to finish before checking task state.

---

## Phase Regression

Phase regression allows any agent to signal that a task should return to an earlier phase when problems are discovered (e.g., QA finds bugs that need fixing in the implementation phase).

### Protocol

```
Agent outputs:     [PHASE_REGRESSION 1] QA found 3 critical bugs: auth bypass, SQL injection, missing validation
Orchestrator:      Validates regression, updates task, respawns entrypoint agent with target phase
Entrypoint agent:  Receives the target phase prompt + regression reason context
```

The target phase number is **1-indexed** (matching what agents see in `CURRENT PHASE (N/M)`). The reason is mandatory.

### Signal Detection

The `[PHASE_REGRESSION <N>] reason` signal is detected in both `parseAgentOutput()` (raw text lines) and `detectSignalsInText()` (JSON-embedded text from claude-code and codex output). Any agent can trigger it — the entrypoint agent, a delegation child, or any agent with an active task.

### Regression Handler: `handlePhaseRegression()` (manager.ts)

1. **Validate**: Agent must have an active task that is running
2. **Record note**: The regression reason is automatically stored as a task note (`[PHASE REGRESSION to phase N] reason`) so all future agents see it
3. **Call `taskScheduler.regressPhase()`**: Converts 1-indexed target to 0-indexed, validates target < current phase, checks regression limit
4. **If max regressions exceeded** (> 3): Auto-escalate to human via `escalationManager.createEscalation()` with severity `high`, set agent state to `escalated`, notify agent
5. **Clear phase guards**: Delete `phaseCompleteHandled` entries for the target phase and all later phases (so re-running works correctly)
6. **Respawn**:
   - **Exec-mode agents**: Store in `pendingRegressions` map and return — the daemon exit handler picks it up when the agent exits
   - **Streaming agents**: Call `respawnForRegression()` immediately

### `respawnForRegression()` (manager.ts)

Shared by both the handler (streaming agents) and the daemon exit handler (exec-mode agents):

1. Kill the entrypoint agent (with respawning guard to prevent health check interference)
2. Respawn with `--resume` if supported (claude-code) to preserve conversation context
3. Assign the task to the agent
4. Build phase prompt via `buildPhasePrompt()` with the regression reason injected
5. Send to stdin, close for exec-mode

### Regression Context in Phase Prompt

When a phase is re-run due to regression, `buildPhasePrompt()` appends:

```
--- PHASE REGRESSION NOTICE ---
This phase is being RE-RUN. A later phase rejected the work.
Reason: QA found 3 critical bugs: auth bypass, SQL injection, missing validation
Address the issues described above before completing this phase.
--- END REGRESSION NOTICE ---
```

This ensures the agent knows exactly why it was sent back and what to fix.

### Exec-Mode Agent Flow

For exec-mode agents (codex, claude-code with `--print`), regression works via the `pendingRegressions` map:

1. Agent outputs `[PHASE_REGRESSION 1] reason` in its JSON output
2. `handlePhaseRegression()` detects exec-mode, stores `{targetPhase, reason}` in `pendingRegressions`
3. Agent exits with code 0
4. Daemon exit handler checks `getPendingRegression()` **before** the existing phase advance logic
5. If pending regression found: calls `respawnForRegression()` instead of advancing
6. Exit handler is preserved for subsequent phase exits

### Regression Limit & Auto-Escalation

Tasks track `regression_count` (reset on retry). After 3 regressions:

1. `regressPhase()` returns `{ regressed: false }`
2. Handler creates an escalation with severity `high` and description explaining the limit
3. Agent state set to `escalated`
4. Agent notified: `[SYSTEM] Phase regression denied: maximum regressions (3) reached. Escalated to human user for guidance.`
5. Human resolves via the existing escalation chat UI

### Audit Trail

Every regression is logged in the `phase_regressions` table:

| Column | Description |
|--------|-------------|
| `task_id` | Which task was regressed |
| `agent_id` | Which agent triggered it |
| `from_phase` | Phase the task was in (0-indexed) |
| `to_phase` | Phase it regressed to (0-indexed) |
| `reason` | Why the regression was requested |
| `created_at` | Timestamp |

Additionally, the reason is stored as a task note so all future agents see it in their prompt enrichment.

### Constraints

| Constraint | Value |
|-----------|-------|
| Max regressions per task | 3 (then auto-escalate) |
| Target phase | Must be < current phase (can't go forward or stay) |
| Who can trigger | Any agent with an active task |
| Reset on retry | Yes (`retryTask()` resets `regression_count` to 0) |
| Signal format | `[PHASE_REGRESSION <1-indexed>] reason` |

---

## Agent Delegation

Delegation allows a running agent to spawn a sub-agent for a specific piece of work and receive the result back.

### Protocol

```
Parent outputs:    [DELEGATE to:<child-agent-id>] Review the changes for correctness
Orchestrator:      Spawns child agent with full context
Child works:       Processes the delegated prompt
Child completes:   Exits with code 0 (exec-mode) or outputs [DELEGATE_COMPLETE] result
Orchestrator:      Routes result to parent as:
                   [DELEGATION_RESULT from:<child-id>]
                   <result text>
                   [END_DELEGATION_RESULT]
```

### Delegation Handler: `handleDelegation()` (line 571)

Triggered when an agent outputs `[DELEGATE to:<id>] prompt`. Steps:

1. **Validate parent**: Must have an active task
2. **Check parent capability**: Parent must be able to receive results back. This requires either streaming stdin OR `--resume` support. Currently, `claude-code` agents can delegate (they have `--resume`), but `codex` agents cannot delegate (no way to receive results).
3. **Validate child**: Must exist in the system
4. **Validate same team**: Both agents must be in the same team (checked via `team_agents` join)
5. **Check delegation depth**: Maximum 3 levels of nesting. Uses a recursive CTE query to walk the delegation chain.
6. **Check existing delegation**: Only one active delegation per parent at a time
7. **Create delegation record**: Insert into `delegations` table with status `pending`
8. **Prepare child**: Kill child if already running, then spawn fresh in parent's working directory
9. **Assign task**: Child gets the same task_id as parent
10. **Build child prompt**: Via `buildDelegationPrompt()` — includes:
    - Agent role (from config goal)
    - Task context (title + description)
    - Notes from other agents
    - The specific assignment (delegated prompt)
    - Team roster (for further delegation)
    - Available commands
11. **Send prompt**: Delivered to child's stdin, with EOF for exec-mode children
12. **Update delegation status**: Set to `running`
13. **Notify parent**: Send `[SYSTEM] Delegated to agent <id>. Waiting for results...` (may fail if parent already exited — that's OK)
14. **Update parent state**: Set `agent_states.state = 'waiting_delegation'` with delegation metadata

### Delegation Completion

Two paths for child completion:

**Path A: Child outputs `[DELEGATE_COMPLETE] result`** (streaming agents)
→ `handleDelegateComplete()` (line 784):
1. Find active delegation for this child
2. Update delegation record to `completed` with result
3. Kill child agent
4. Route result to parent as `[DELEGATION_RESULT from:<id>]...[END_DELEGATION_RESULT]`
5. Reset parent state to `working`

**Path B: Child process exits with code 0** (exec-mode agents)
→ `handleProcessExit()` (line 1049):
1. Detect active delegation for exiting agent
2. Gather last terminal outputs as the result
3. Update delegation record to `completed`
4. Route result to parent (same format)
5. Reset parent state to `working`

**Result routing to parent** depends on parent type:
- If parent is still alive with open stdin → `sendInput()` directly
- If parent is exec-mode with `--resume` support → `sendResumeMessage()` (kills and respawns parent with `--resume <sessionId>`, sends result as new stdin, closes stdin)
- If parent is dead and can't resume → error logged, result lost

### Delegation Failure

If child exits with non-zero code:
1. Delegation marked as `failed`
2. Parent receives `[DELEGATION_RESULT from:<id>]\nDelegation failed: child agent exited with code N\n[END_DELEGATION_RESULT]`
3. Parent state reset to `working`

### Delegation Timeout

The daemon checks for stale delegations every 30 seconds in `checkStaleDelegations()` (daemon line 627):
- Delegations running for more than 10 minutes are auto-failed
- Child agent is killed
- Parent receives timeout notification
- Parent state reset to `working`

### Constraints

| Constraint | Value | Reason |
|-----------|-------|--------|
| Max depth | 3 levels | Prevent infinite recursion |
| Concurrent per parent | 1 | Simplicity (MVP) |
| Parent type | Must support result receipt | Need `--resume` or streaming stdin |
| Child type | Any | Exec-mode children are fine |
| Timeout | 10 minutes | Daemon auto-fails stale delegations |
| Same team required | Yes | Validated via `team_agents` join |

---

## Escalation (Human-in-the-Loop)

Agents can ask questions to the human user via the escalation system.

### Protocol

```
Agent outputs:     [ESCALATE] Where can I find the staging DB credentials?
Orchestrator:      Creates escalation record, sets agent state to 'escalated'
UI:                Shows escalation notification with chat interface
User:              Types response in escalation chat
Orchestrator:      Injects [USER_RESPONSE] <answer> into agent's stdin (or resumes)
Agent:             Continues work with the answer
```

### Escalation Handler: `handleEscalation()` (line 849)

1. Validate agent has an active task
2. Create escalation via `escalationManager.createEscalation()` with type `agent_request`
3. Update `agent_states.state = 'escalated'` with metadata `{escalationId, question}`
4. Notify agent: `[SYSTEM] Your question has been escalated to the human user. Please wait for their response.`
5. Emit `escalation:created` event (propagates to UI via SSE)

### Escalation Resolution: `resolveEscalation()` (`src/escalations/manager.ts:140`)

When the user responds via the chat UI:

1. Update escalation record to `resolved` with user's response
2. **Inject response into agent**:
   - If agent process is still alive → `sendInput(agentId, '[USER_RESPONSE] <response>')`
   - If agent exited but supports `--resume` → `sendResumeMessage(agentId, '[USER_RESPONSE] <response>')` (respawns with `--resume <sessionId>`)
   - If agent is dead and can't resume → logged, response lost
3. Reset `agent_states.state = 'working'`
4. Record via message bus for audit trail
5. Emit `escalation:resolved` event

### Automatic Escalation Types

The daemon can also create escalations automatically:

| Type | Trigger | Condition |
|------|---------|-----------|
| `max_nudges` | Agent stuck after N nudges | `nudgeCount >= maxNudges` (default 3) |
| `permission_required` | Agent waiting for permission | Permission prompt state > 1 minute |
| `question_unanswered` | Agent asking question | Asking question state > stuck threshold |
| `unresolvable_error` | Agent in error state | Any agent in `error` state |
| `agent_request` | Agent explicitly escalates | `[ESCALATE]` signal |

---

## Task Notes (Inter-Agent Knowledge)

Notes provide a lightweight knowledge-sharing mechanism between agents working on the same task.

### Protocol

```
Agent outputs:     [NOTE] The auth config is in /etc/app.conf, not the usual location
Orchestrator:      Stores in task_notes table
Future agents:     See the note in their prompt enrichment under "NOTES FROM OTHER AGENTS"
```

### Note Handler: `handleNote()` (line 896)

1. Validate agent has an active task
2. Insert into `task_notes` table (id, task_id, agent_id, content)
3. Emit `task:note_added` event
4. Fire-and-forget — no confirmation sent to agent

### Note Injection

Notes are included in every prompt sent to any agent working on the task. In `buildPromptEnrichment()` (daemon line 668) and `buildDelegationPrompt()` (manager line 705):

```
NOTES FROM OTHER AGENTS:
- [Lead Dev] The auth config is in /etc/app.conf, not where you'd expect
- [QA Agent] Tests pass locally but the CI env needs NODE_ENV=test
```

Notes accumulate throughout the task's lifetime. Every new agent spawned (including delegation children) receives all existing notes.

---

## Session Resume (`--resume`)

Claude Code supports multi-turn conversations via the `--resume` flag. This is critical for exec-mode agents that need to receive delegation results or escalation responses after they've already exited.

### How Session IDs Work

1. **Capture**: When Claude Code starts, it emits JSON events with a `session_id` field. `handleJsonOutput()` (line 346) captures the first `session_id` it sees and stores it on the in-memory `RunningAgent` object.

2. **Persistence**: When the agent process exits, `handleProcessExit()` (line 1049) calls `persistSessionId()` (line 1172), which writes the session ID to `agent_states.state_metadata` using SQLite's `json_set()` function.

3. **Retrieval**: `getSessionId()` (line 1182) checks the in-memory running agent first, then falls back to the database. This ensures the session ID survives process restarts.

### Resume Flow: `sendResumeMessage()` (line 1215)

Used when an exec-mode agent with resume support needs to receive a new message (delegation result, escalation response, next phase prompt):

1. Look up the agent and its stored session ID
2. Validate the agent type supports `--resume` (currently only `claude-code`)
3. Kill current process if still running (mark as respawning to avoid health check interference)
4. Spawn new process with `--resume <sessionId>` appended to args:
   ```
   claude --print --output-format stream-json --verbose --dangerously-skip-permissions --resume abc123
   ```
5. Send the message as stdin and close stdin (exec-mode EOF)
6. The new process continues the previous conversation context

### Where Resume Is Used

| Scenario | Trigger | Message Sent |
|----------|---------|-------------|
| Delegation result | Child exits code 0 | `[DELEGATION_RESULT from:<id>]...[END_DELEGATION_RESULT]` |
| Delegation failure | Child exits non-zero | `[DELEGATION_RESULT from:<id>]\nDelegation failed...\n[END_DELEGATION_RESULT]` |
| Escalation response | User responds | `[USER_RESPONSE] <answer>` |
| Phase advancement | Phase completes | Next phase prompt |

### Respawn Protection

When an agent is being intentionally killed for respawn, its ID is added to the `respawningAgents` Set. This prevents:
- The daemon's health check from detecting it as a "dead agent" and failing the task
- The process exit handler from treating it as an unexpected death
- Double-cleanup of DB state

---

## Process Exit Handling

`handleProcessExit()` (line 1049) is called when any agent process exits.

### Exit Flow

1. **Persist session ID**: If the agent had a session ID (claude-code), save it to DB for future `--resume`
2. **Remove from memory**: Delete from `this.agents` Map
3. **Check delegation**: Look for an active delegation where this agent is the child
4. **If delegation child**:
   - Exit code 0: Gather last terminal outputs as result, route to parent, mark delegation completed
   - Non-zero: Mark delegation failed, notify parent of failure
5. **Update DB**:
   - If respawning: Only clear PID (keep task assignment)
   - If not respawning: Clear PID, clear task assignment, reset agent state to `stopped`
6. **Emit event**: `agent:exit` with `{agentId, code, isRespawn, hasDelegation}` flags

The daemon's exit handler (registered in `processTaskQueue`) receives the `agent:exit` event and:
- Ignores respawn exits
- Ignores exits where delegation system handles it
- Checks for active delegations still running (don't fail task prematurely)
- For exec-mode code 0: advance phase or complete task
- For non-zero: fail the task

---

## Health Checks & Stuck Detection

The Manager Daemon (`src/agents/manager-daemon.ts`) runs every 30 seconds and performs:

### Process Health Check (`checkProcessHealth()`, line 212)

For every agent with a PID in the database:
1. Skip agents being intentionally respawned
2. Check if the process is tracked in memory AND alive
3. If not tracked: check if OS process is alive via `process.kill(pid, 0)`
4. If OS process alive but not tracked: kill the orphan
5. If process dead: clean up DB state
6. If agent had a running task: fail it (unless active child delegations exist)

### Stuck Detection

1. `getStuckCandidates()` finds agents whose heartbeat is older than the threshold (default 5 minutes)
2. `analyzeStuckAgent()` (line 472):
   - **Skip**: Agents in `waiting_delegation` or `escalated` state (they're intentionally idle)
   - Compare screen fingerprint to detect output changes
   - If screen static for > threshold: mark as stuck
3. `handleStuckAgent()` (line 530):
   - If nudge count < max (3): send a contextual nudge message
   - If nudge count >= max: create `max_nudges` escalation

### Stale Delegation Check (`checkStaleDelegations()`, line 627)

Finds delegations running for > 10 minutes:
1. Mark as failed with timeout message
2. Kill child agent
3. Notify parent with timeout result
4. Reset parent state to `working`

---

## Cleanup & Recovery

### Startup Cleanup

When the server starts, before the daemon begins its loop:

**`AgentManager.cleanupStaleState()`** (line 21):
1. Find all agents with a PID in the database (presumably left over from a previous server instance)
2. Try to kill each orphaned process
3. Reset all agent DB states to `stopped`

**`TaskScheduler.cleanupStaleState()`** (line 242):
1. Find all tasks in `running` status
2. Fail them with "Server restarted while task was running"

### Task Cancellation

`POST /api/tasks/:id/cancel`:
1. Find the agent assigned to the task
2. Kill the agent process via `agentManager.killAgent()`
3. Set task status to `failed` with "Cancelled by user"

### Task Retry

`POST /api/tasks/:id/retry`:
1. Validate task is in `failed` status
2. Reset to `draft` with `current_phase = 0`, clear result and completion time
3. Task can then be re-approved and picked up by the daemon

### Agent Deletion

`DELETE /api/agents/:id`:
1. Stop the agent if running
2. Remove from in-memory tracking
3. Delete from database (cascading deletes handle related records in `team_agents`, `terminal_outputs`, etc.)

---

## Data Flow Diagram

```
User creates Task (draft)
         │
         ▼
User approves Task (approved)
         │
         ▼
Daemon picks up Task ──────────────────────────────────────────┐
         │                                                     │
         ▼                                                     │
Spawn entrypoint agent                                         │
         │                                                     │
         ▼                                                     │
Build prompt: goal + task + phase + enrichment                 │
         │                                                     │
         ▼                                                     │
Send to stdin (close for exec-mode)                            │
         │                                                     │
         ▼                                                     │
Agent processes prompt ◄──────────────────────────┐            │
    │    │    │    │                               │            │
    │    │    │    └─ [NOTE] ──► task_notes table  │            │
    │    │    │                                    │            │
    │    │    └─── [ESCALATE] ──► escalation ──────┤            │
    │    │              ▲              │            │            │
    │    │              │              ▼            │            │
    │    │              │         User responds     │            │
    │    │              │              │            │            │
    │    │              │              ▼            │            │
    │    │              └──── [USER_RESPONSE] ─────┘            │
    │    │                    (via stdin/resume)                │
    │    │                                                     │
    │    └──── [DELEGATE to:<id>] ──► Spawn child agent        │
    │              ▲                       │                    │
    │              │                       ▼                    │
    │              │               Child processes              │
    │              │                       │                    │
    │              │                       ▼                    │
    │              │              Child exits (code 0)          │
    │              │                       │                    │
    │              │                       ▼                    │
    │              └── [DELEGATION_RESULT] ─┘                   │
    │                  (via stdin/resume)                       │
    │                                                          │
    ▼                                                          │
[PHASE_COMPLETE] or exit(0)                                    │
         │                                                     │
         ▼                                                     │
  More phases? ──yes──► Respawn/send next phase ───────────────┘
         │
         no
         │
         ▼
Task completed
```

---

## Database Tables Reference

| Table | Purpose |
|-------|---------|
| `agent_types` | CLI tool definitions (command, args, model support) |
| `state_patterns` | Regex patterns for detecting agent states from output |
| `agents` | Agent instances with config, status, PID |
| `teams` | Team definitions with phases and entrypoint |
| `team_agents` | Agent-team membership with roles and hierarchy |
| `tasks` | Work units with lifecycle status |
| `agent_states` | Real-time state tracking (working, stuck, escalated, etc.) |
| `terminal_outputs` | Streaming stdout/stderr capture |
| `delegations` | Parent→child delegation records with status |
| `phase_regressions` | Audit log of phase regression events |
| `task_notes` | Inter-agent knowledge sharing |
| `escalations` | Human-in-the-loop intervention records |
| `messages` | Agent-to-agent message audit trail |
| `manager_runs` | Daemon check run history |
| `stuck_detection_logs` | Stuck analysis records |
| `agent_memories` | Memory checkpoint data |
| `events` | General event audit log |
| `artifacts` | Task output artifacts |
| `cli_runtimes` | Available CLI runtime detection |

---

## Key Source Files

| File | Responsibility |
|------|---------------|
| `src/agents/manager.ts` | Process spawning, I/O handling, signal parsing, delegation, escalation, session resume |
| `src/agents/manager-daemon.ts` | Task queue, health checks, stuck detection, prompt enrichment, phase management |
| `src/agents/types.ts` | Agent type definitions, in-memory cache |
| `src/agents/state-tracker.ts` | Agent state tracking and stuck candidate detection |
| `src/tasks/scheduler.ts` | Task CRUD and lifecycle transitions |
| `src/teams/manager.ts` | Team CRUD, agent membership, hierarchy |
| `src/escalations/manager.ts` | Escalation CRUD, resolution with agent injection |
| `src/events/bus.ts` | EventEmitter for system-wide events |
| `src/messaging/bus.ts` | Agent-to-agent message routing and persistence |
| `src/cli/runtimes.ts` | CLI runtime detection and output parsing |
| `src/db/schema.sql` | Database schema and seed data |
| `src/db/connection.ts` | DB initialization and migrations |
| `src/server.ts` | HTTP API routes |
| `src/html/components.ts` | Server-rendered HTML for HTMX UI |

## Orchestrator Resilience & Automatic Recovery

The orchestrator is designed as a fully recoverable state machine. This guarantees forward progress after server restarts, daemon crashes, process kills, or transient failures. Recovery logic runs automatically on every daemon tick and on server startup, leveraging persistent session IDs from both CLIs and DB-backed orchestration state.

### Core Design Principles

- **Session resume as the foundation**: Both `claude-code` and `codex` support robust multi-turn resumption.
- **Persistent orchestration state**: Transient execution state lives in the database, making recovery idempotent and crash-resistant.
- **Checkpointing**: Lightweight snapshots at key events allow intelligent resumption.
- **Idempotent handlers**: Signal processors check DB state before acting, preventing duplicate work.

### Database Structures

#### `tasks.orchestration_state` (JSONB column on `tasks`)

```json
{
  "step": "AGENT_RUNNING | WAITING_DELEGATION | ADVANCING_PHASE | WAITING_ESCALATION | RECOVERING | COMPLETED",
  "last_checkpoint_ts": "2026-02-19T13:45:00Z",
  "session_id": "sess_abc123",
  "active_delegation_id": null,
  "phase_guards": ["phase:0", "phase:1"],
  "pending_regression": null,
  "nudge_count": 1,
  "checkpoint_prompt_hash": "sha256:..."
}
```

#### `task_checkpoints` table (recommended for long-running tasks)

| Column | Type | Purpose |
|------|------|-------|
| `id` | `INTEGER` | Primary key |
| `task_id` | `TEXT` | Reference to task |
| `sequence` | `INTEGER` | Incrementing checkpoint number |
| `checkpoint_type` | `TEXT` | `PHASE_START`, `DELEGATION_COMPLETE`, `NOTE_ADDED`, `REGRESSION`, etc. |
| `session_id` | `TEXT` | Captured CLI session ID |
| `context_snapshot` | `JSONB` | Compressed notes, delegations, and related context |
| `terminal_seq` | `INTEGER` | Last processed `terminal_outputs` sequence |
| `created_at` | `TIMESTAMP` | Creation timestamp |

### Recovery Flow

#### `recoverTask(taskId)` (`src/agents/manager-daemon.ts`)

Called automatically for every running task on startup and on each daemon tick:

1. Kill any stale or out-of-sync OS process for the entrypoint agent.
2. Load `orchestration_state` and the latest checkpoint.
3. If the agent supports resume (`supports_resume`) and `session_id` exists:
   - Spawn with the CLI-specific resume flag (`--resume <id>` or `exec resume <id>`).
   - Send resume prompt: "Server was restarted. Resuming task from phase X/Y. Continue exactly where you left off."
4. Otherwise, fall back to full respawn for `current_phase` with reconstructed context.
5. Restore in-memory structures (`phase_guards`, `pending_regression`, `active_delegation`).
6. Set `orchestration_state.step = "AGENT_RUNNING"`.

### Main Daemon Loop

#### `mainRecoveryLoop`

```ts
async function mainRecoveryLoop() {
  while (true) {
    await recoverAllStaleTasks(); // Idempotent recovery for all running tasks
    await processTaskQueue();     // Only new approved tasks
    await checkStaleDelegations();
    await runStuckDetection();
    await persistCheckpoints();   // Every ~60s
    await sleep(30000);
  }
}
```

`recoverAllStaleTasks()` scans for `status = 'running'` tasks and calls `recoverTask()` (safe to call repeatedly).

### CLI Resume Support (February 2026)

| Agent Type | Resume Command | Delegation Support | Notes |
|------|------|------|-------|
| `claude-code` | `--resume <session_id>` | Yes | Full tool/file context preserved |
| `codex` | `exec resume <session_id> --json` | Yes (new) | Previously limited; now fully enabled |

The `agent_types` table now includes:

- `supports_resume BOOLEAN DEFAULT false`
- `resume_flag TEXT`

This allows delegation, phase regression, escalation responses, and notes to survive restarts for both CLIs.

### Benefits

- Server restart or daemon crash is no longer fatal.
- Delegation chains, phase regressions, and human escalations survive automatically.
- Near-zero data loss even after extended outages.
- Both CLIs are handled symmetrically.

### Implementation Status & Roadmap

| Phase | Changes | Effort | Benefit |
|------|-------|------|-------|
| 1 | `orchestration_state` + `recoverTask()` + startup call | 1-2 days | Tasks no longer fail on restart |
| 2 | Full checkpoint table + intelligent prompt replay | 2-3 days | Richer context after long outages |
| 3 | Enable Codex delegation + uniform resume path | 1 day | Complete symmetry |

All existing handlers (`handlePhaseComplete`, `handleDelegation`, `handlePhaseRegression`, etc.) are fully idempotent by consulting `orchestration_state` before acting.

This turns PlayHive into a true set-and-forget production orchestrator.
