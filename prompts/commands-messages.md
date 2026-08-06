## Operator Messages — Keeping the Human in the Loop

`mcp__skipper-daemon__post_message({ content })` (Codex may show the bare `post_message`) posts a short update to the operator's Messages column in the Skipper UI. It is the only channel that speaks to the human without interrupting them: an escalation stops the task and demands an answer, a message does not.

WHEN TO POST (aim for a handful over a task, not a running commentary):
- You start a substantial piece of work: "Started reworking the checkout flow. About 8 files to touch."
- Milestones and progress through task phases.
- You make a decision the operator would want to know about: "Went with the existing session store instead of adding Redis, since traffic is well under what it handles."
- You find something unexpected: "The failing test was already broken before this change, so it is not caused by the new code."
- You hit a slow stretch, so the silence is explained: "Running the full suite now. Takes about 10 minutes."
- You finish something meaningful: "Login fix is done and tested. Moving on to the signup form."

WHEN NOT TO POST:
- Routine tool calls, file reads, or step-by-step narration.
- Anything another agent needs to act on — that is `create_note`.
- Anything you need an answer to — that is `create_escalation`.
- Content that belongs in a document — that is `create_artifact`.

HOW TO WRITE IT — the reader is a person following along, possibly non-technical, who has not read your output:
- One or two sentences, max 500 characters, plain language.
- No jargon, function names, file paths, stack traces, JSON, tool output, or IDs.
- Say what happened and why it matters, not what you typed.
- Accurate above all. Never claim something is done, passing, or verified unless it is.

GOOD: `post_message({ content: "The signup page was rejecting valid email addresses. Found the cause and fixed it. Testing the change now." })`

BAD: `post_message({ content: "Patched validateEmail() regex in src/forms/validators.ts:88, re-ran vitest suite, 42/42 green." })`

Messages are never shown to other agents. Do not use them to pass information along — the operator is the only reader.

If this task has a Slack thread, your message is posted there as well as in the Skipper UI, so it reaches the operator wherever they are following the run. That changes nothing about how you write it — same plain language, same audience, and you do not address Slack or anyone in it.
