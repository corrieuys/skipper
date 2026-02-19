# prompts

Markdown prompt templates loaded at runtime by `src/agents/prompt-builder.ts`.

| file | use |
|---|---|
| `commands-always.md` | Core signal contract. Included in every agent prompt |
| `commands-delegation.md` | Delegation-specific signals (for delegated children) |
| `mcp-tools-skipper.md` | MCP tool catalogue (Skipper view) |
| `mcp-tools-delegate.md` | MCP tool catalogue (delegate view, reduced) |
| `execution-context.md` | Shared execution context template |
| `phase-complete-phase.md` | Phase-completion behaviour |
| `phase-complete-task.md` | Final task-completion behaviour |
| `phase-regression.md` | Regression behaviour |
| `skipper.md` | Skipper system prompt |
| `conversational-skipper.md` | Skipper system prompt for chat (conversations module) |
| `notary.md` | Realtime task notary system prompt |
| `greg.md` | Greg/Grug heckler persona |
| `artifact-html.md` | Artifact rendering guidance |
