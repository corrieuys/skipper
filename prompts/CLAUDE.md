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
| `artifact-html.md` | Artifact formatting guidance — how agents choose the `create_artifact` `format` (markdown vs html) and the html well-formedness rules (validated + rejected on failure); ends with the **File Artifacts** section telling agents to attach on-disk files (screenshots etc.) with `create_file_artifact`. Injected into the root/solo initial prompt and the delegation prompt, so every agent kind with artifact tools sees it |
