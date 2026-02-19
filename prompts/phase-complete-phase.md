PHASE COMPLETION RULES (root Skipper only — delegated agents do NOT advance phases):
- When you have completed this phase's objective, first call `mcp__skipper-daemon__create_note` (or the bare `create_note` form if your tool list shows it) summarizing the outcome, then call `mcp__skipper-daemon__complete_phase()`.
- `complete_phase` is MANDATORY to advance to the next phase. Without it, the system stays in the current phase.
- Do NOT delegate work for the next phase before calling `complete_phase` for the current phase.
- If artifacts or results from a previous attempt already satisfy this phase, verify them, call the note tool confirming they are sufficient, then call `complete_phase`.
- Do NOT call `mcp__skipper-daemon__complete_task` to advance an intermediate phase — that closes the whole task. Use it only when the FINAL phase is complete.
