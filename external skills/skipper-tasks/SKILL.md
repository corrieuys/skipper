---
name: skipper-tasks
description: Create, list, and approve tasks in Skipper via its MCP tools. Use whenever a user asks you to start a piece of work in Skipper, kick off an agent team, check on task status, or approve a queued task.
---

# Managing Skipper tasks

You are connected to a Skipper instance over MCP using an API key. This gives you a
small, task-focused tool set. Use it to create work for Skipper's agent teams,
check on it, and release it to run.

## Your tools

Do not assume any tools beyond those listed here exist.

**Discovery & reading**

| Tool | Purpose | Arguments |
|---|---|---|
| `list_teams` | List the agent teams a task can be assigned to. | none |
| `list_tasks` | List tasks **newest first**, paginated. Optionally filter by status. | `status` (`draft`/`approved`/`running`/`paused`/`completed`/`failed`), `page`, `page_size` |
| `list_active_tasks` | List only active tasks (running or queued: approved/running/paused), newest first, paginated. | `page`, `page_size` |
| `get_task` | Retrieve one task with full detail. | `task_id` (required) |

Both list tools return a paged envelope, not a bare array:

```json
{ "tasks": [ /* newest first */ ],
  "pagination": { "page": 1, "page_size": 20, "total": 137, "total_pages": 7, "has_more": true } }
```

- `page` is 1-based (default 1); `page_size` defaults to 20, max 100.
- Read `pagination.has_more` (or `total_pages`) to decide whether to fetch the next page.
- There can be **hundreds** of tasks — never assume one page is the whole list. When a
  user asks about recent tasks, the first page (newest first) is usually enough; only
  page further if they ask for older ones or you're searching for a specific task.

**Creating & editing**

| Tool | Purpose | Arguments |
|---|---|---|
| `create_task` | Create a task. It starts as a **draft** and does **not** run yet. | `title` (required), `description`, `team_id`, `working_directory` |
| `update_task` | Edit a **draft** task. Only drafts can be edited; omitted fields are preserved. | `task_id` (required), `title`, `description`, `team_id`, `working_directory` |

**Lifecycle**

| Tool | Purpose | Arguments |
|---|---|---|
| `approve_task` | Approve a draft so Skipper starts running it (draft → approved). | `task_id` (required) |
| `pause_task` | Pause a running task (running → paused). | `task_id` (required) |
| `resume_task` | Resume a paused task (paused → running). | `task_id` (required) |
| `cancel_task` | Cancel an active task (→ failed). Can't cancel completed/failed. | `task_id` (required) |
| `complete_task` | Mark a running task completed (running → completed). | `task_id` (required), `result` |

**Recurring tasks**

These are separate from regular tasks — they are templates that run on a schedule. You can trigger one immediately.

| Tool | Purpose | Arguments |
|---|---|---|
| `list_recurring_tasks` | List recurring tasks (id, status, cadence). Use it to find the `recurring_task_id`. | `status` (`draft`/`approved`) |
| `run_recurring_task` | Run an **approved** recurring task now (a one-off "Run Now"), regardless of its schedule. | `recurring_task_id` (required), `prompt` (optional) |

- Only **approved** recurring tasks can be run — `run_recurring_task` errors otherwise.
- `run_recurring_task` spawns a fresh regular task run (auto-approved) and returns its `run_task_id`; track it with `get_task` / `list_active_tasks`.
- The optional `prompt` is a **one-off** instruction injected into that run only — it does not change the recurring task itself. Pass it when the user wants this run to focus on something specific (e.g. "run the nightly report now, but only for the EU region").
- To run a recurring task on the user's behalf: `list_recurring_tasks` (filter `status: "approved"`) → confirm which one → `run_recurring_task`, passing `prompt` only if the user gave a specific one-off instruction.

Key facts:
- A newly created task is a **draft** — nobody runs it until it is approved.
- `approve_task` is what actually starts the work.
- `team_id` decides which agent team runs the task. Teams are discovered with `list_teams`.
- Only **draft** tasks can be edited with `update_task`; once approved a task is immutable.
- A task must be **running** to pause or complete it, and **paused** to resume it. If a call is rejected because of the task's current status, check it with `get_task` first.

## Creating a task — the required flow

When a user asks you to create a task (e.g. "have Skipper add a webhook", "start a
task to fix the login bug"), follow these steps **in order**. Do not skip the team
selection step.

1. **List the teams first.** Call `list_teams`. It returns an array of
   `{ "id": "...", "name": "..." }`.

2. **Ask the user which team.** Present the team names and ask which one the task
   should be assigned to. Wait for their answer, then map their choice to that
   team's `id`. Never guess the team — always ask, even if only one team exists
   (confirm it). The only exception: the user already named a specific team in
   their request, in which case match it against the list and confirm.

3. **Create the task.** Call `create_task` with a clear `title`, a `description`
   capturing what the user wants done, and the chosen `team_id`. The response
   includes the new task's `id` and `status` (which will be `draft`).

4. **Approve — but only after checking intent.** If the user's original request
   was **not explicit** about approving/running (they just said "create a task"),
   **ask them whether to approve it now** and explain that approving starts the
   work. Only call `approve_task` with the task `id` once they confirm.
   - If the user **was** explicit up front — e.g. "create and run", "start it",
     "kick it off", "approve it" — skip the extra question and call `approve_task`
     immediately after creating it.
   - If they decline, leave it as a draft and tell them it's queued as a draft
     they can approve later.

### Example

> User: "Get Skipper to write release notes for v2."

1. `list_teams` → `[{ "id": "team-eng", "name": "Engineering" }, { "id": "team-docs", "name": "Docs" }]`
2. Ask: "Which team should handle this — Engineering or Docs?" → user picks Docs.
3. `create_task({ title: "Write release notes for v2", description: "Draft release notes covering v2 changes.", team_id: "team-docs" })` → `{ "id": "task-123", "status": "draft" }`
4. The user didn't say to run it, so ask: "Created as a draft. Approve it now to start the work?" → on "yes", `approve_task({ task_id: "task-123" })`.

## Checking on tasks

- To report status, call `list_tasks` (optionally with `status` to filter, e.g.
  `running` or `completed`). It returns newest-first with a `pagination` block;
  the first page is usually enough, page further only if asked. Summarize the
  returned `title` + `status` for the user rather than dumping raw JSON.
- For "what's running right now", prefer `list_active_tasks`. For one task's
  detail, use `get_task`.

## Guidelines

- Always confirm the team before creating a task — the team selection is not optional.
- Be explicit that **creating ≠ running**: a task does nothing until approved.
- Echo back the task title and the team you assigned it to so the user can catch mistakes.
- If a tool returns an error, report it plainly and do not retry blindly.
