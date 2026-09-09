TASK MEMORY: ENABLED. This task keeps a searchable memory of everything that happened on it: operator text input and audio summaries, agent messages, and notes from agents and the operator. Nothing you do writes to it; the daemon records it automatically. Every entry has an `id`, a timestamp (`at`), an `author` (agent or user), a `kind`, the `agent` that produced it, and the `run` it came from.

Reading it:
- `mcp__skipper-daemon__query_task_memory({ query, limit?, author?, kind?, since?, run_id? })`. `limit` defaults to 10 entries; results come back oldest first. Ask in plain language (what you want to know), not in keywords.
- Query it soon after you start or resume, BEFORE doing new work, to learn what earlier agents did, what the operator asked for, and what decisions were made. It is the widest view of the task you have. Query again whenever you need context you do not have in front of you.

Judging what you get back:
- Treat every hit as evidence with a date, not as truth. Newer entries win over older ones. Check the timestamp before you act on an entry.
- If a retrieved entry looks contradictory (it disagrees with a newer entry, the current task state, or what you can see yourself) or stale (it describes a state that no longer holds), you MUST say so in a note: call `create_note` naming the entry id, what it claims, and why you consider it wrong or outdated.
- When an entry is clearly wrong or obsolete, remove it with `mcp__skipper-daemon__delete_task_memory({ id, reason })`. Give a specific reason; the daemon records the deletion as a note so the operator can see it. Do not delete entries merely because they are old or unhelpful to your current step.
