# prompts

Markdown prompt templates loaded at runtime by `src/agents/prompt-builder.ts`.

| file | use |
|---|---|
| `commands-always.md` | Core signal contract. Included in every agent prompt |
| `commands-delegation.md` | Delegation-specific signals (for delegated children) |
| `commands-messages.md` | When/how to post an operator message (`post_message`). Appended to every agent prompt (root, delegated, solo); the tool is always registered |
| `mcp-tools-skipper.md` | MCP tool catalogue (Skipper view) |
| `mcp-tools-delegate.md` | MCP tool catalogue (delegate view, reduced) |
| `mcp-tools-single.md` | MCP tool catalogue (solo single/custom agent view) |
| `execution-context.md` | Shared execution context template |
| `phase-complete-phase.md` | Phase-completion behaviour |
| `phase-complete-task.md` | Final task-completion behaviour |
| `phase-regression.md` | Regression behaviour |
| `skipper.md` | Skipper system prompt |
| `notary.md` | Realtime task notary system prompt |
| `greg.md` | Greg/Grug heckler persona |
| `task-memory.md` | TASK MEMORY: ENABLED block. Injected into the root/solo initial prompt and the delegation prompt only when the task's memory scope is on (`task-memory/scope.ts`); tells the agent to call `query_task_memory` early, judge hits by timestamp, note contradictory/stale entries and delete clearly wrong ones with `delete_task_memory`. The tools (and `search_task_content`) are listed in the three `mcp-tools-*.md` catalogues |
| `task-memory-shared.md` | Appended after the block above when the scope is a recurring series' shared memory: hits carry their run, per-run cap, prefer newest, verify earlier runs' claims |
| `artifact-html.md` | Artifact formatting guidance — how agents choose the `create_artifact` `format` (markdown vs html) and the html well-formedness rules (validated + rejected on failure); ends with the **File Artifacts** section telling agents to attach on-disk files (screenshots etc.) with `create_file_artifact`. Injected into the root/solo initial prompt and the delegation prompt, so every agent kind with artifact tools sees it |
