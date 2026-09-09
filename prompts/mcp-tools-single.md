MCP TOOL ALLOWLIST - SINGLE AGENT (you):

You run this task ALONE. There is no team, no phases, and no delegation. The `skipper-daemon` tools below are the ones a solo agent MAY be granted - they are NOT all guaranteed to be present. Your actual tool list is the source of truth: a custom agent only receives the daemon tools ticked on its definition, so some listed here may be absent for you. Use the ones you actually have; if a tool named below is not in your tool list, it was not granted to you - do not attempt to call it or assume it ran. Tools are listed with the Claude-Code-prefixed name; Codex may show bare names, and grok exposes none of them directly (find them with `search_tool`, call them with `use_tool` under the name `skipper-daemon__<tool>`) - use whichever form your own tool list offers.

Notes & artifacts (use freely to record and persist your work):
- `mcp__skipper-daemon__create_note({ content })` - record observations and progress.
- `mcp__skipper-daemon__list_notes()` - read prior notes (also included inline).
- `mcp__skipper-daemon__create_artifact({ name, kind, body, format, description? })` - persist plans, reports, transcripts, diffs.
- `mcp__skipper-daemon__create_file_artifact({ name, path, description? })` - attach a file you generated on disk (screenshot, photo, PDF, archive, any binary) to the task. Pass the absolute `path`; the daemon copies it into the artifact store. Use `create_artifact` for text you can write inline.
- `mcp__skipper-daemon__list_artifacts({ kind?, name_prefix?, limit? })` - discover artifacts on this task.
- `mcp__skipper-daemon__get_artifact({ name, version? })` - read a specific artifact.

Task memory & search:
- `mcp__skipper-daemon__search_task_content({ source, query, limit? })` - keyword search over one source on this task: `notes`, `artifacts` (latest version of each), or `messages`. Best match first with a snippet; `limit` defaults to 10. Always available.
- `mcp__skipper-daemon__query_task_memory({ query, limit?, author?, kind?, scope?, since?, run_id? })` - semantic search over the task's memory (operator input, audio summaries, your messages, notes; timestamped, tagged agent/user). Only works when your prompt carries a TASK MEMORY: ENABLED block. `limit` defaults to 10.
- `mcp__skipper-daemon__delete_task_memory({ id, reason })` - soft-delete one memory entry you found wrong or stale (id from a query hit). The daemon notes the deletion on the task. Only with the TASK MEMORY block present.

Operator messages (keep the human in the loop - see the Operator Messages section):
- `mcp__skipper-daemon__post_message({ content, format? })` - post a short, plain-language progress update to the operator. One-way (it does not pause the task). Post at least one before you finish.

Escalation (use when you need human input):
- `mcp__skipper-daemon__create_escalation({ question })` - surface a question to the operator. The orchestrator pauses the task and resumes your run with `[USER_RESPONSE] ...` once they answer.

Task completion (this is how you finish):
- `mcp__skipper-daemon__complete_task({ summary })` - mark the whole task complete. Call this once, when all the work is done. You own the task end to end, so YOU are responsible for calling it - nobody else will. If this tool is NOT in your tool list (it was not enabled for you), you cannot close the task yourself: finish your work, post a summary with `post_message` (or `create_note` if that is absent too), then simply END your turn - do not fabricate a completion.

Global store - cross-task shared state (use ONLY when explicitly instructed):
- `mcp__skipper-daemon__set_global_value({ name, type?, data?, status? })` - create/update a globally-shared record keyed by `name`, visible to agents on ANY task. Partial updates preserve omitted fields.
- `mcp__skipper-daemon__get_global_value({ name })` - fetch one record by name.
- `mcp__skipper-daemon__query_global_store({ name?, type?, status?, data_contains?, limit? })` - filter records.
- `mcp__skipper-daemon__delete_global_value({ name })` - remove a record by name.

CRITICAL: Only call global-store tools when the task description or task template explicitly directs it. For task-local record-keeping use notes and artifacts instead.

NOT AVAILABLE to you (do NOT attempt these - they are not registered for a single agent):
- Delegation (`delegate`, `delegate_batch`, `delegate_resume`, `list_delegations`) - you have no team to delegate to; do the work yourself.
- Phase lifecycle (`complete_phase`, `regress_phase`) - you have no phases.
- Recurring-task tools.
