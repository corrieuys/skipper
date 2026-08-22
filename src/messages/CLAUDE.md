# src/messages

Operator messages (experimental). Short, plain-language updates an agent posts for
the human watching a task.

| file | use |
|---|---|
| `manager.ts` | `MessageManager` — `postMessage`, `listMessages`, `countMessages`. Carries a `format` (`text`\|`markdown`\|`html`, default `text` — NULL on legacy rows = text; migration `0021_task_message_format.sql`). Text bodies collapse to one line; markdown/html keep their newlines. Caps at `MESSAGE_MAX_LENGTH` (2900, sized to Slack's section limit), dedups an identical repost from the same agent within 5s, emits `task:message_posted` |

Third register alongside notes and artifacts, split by **audience**:

| register | written for | fed back into agent prompts |
|---|---|---|
| notes (`task_notes`) | the next agent on the task | yes |
| artifacts (`task_artifacts`) | agents + operator, versioned documents | listed, fetched on demand |
| messages (`task_messages`) | the operator only | **never** |

Because nothing reads messages back, there is no list/get MCP tool — only
`post_message` (registered on root AND delegated sessions, `isExperimental()` only,
see [../mcp/CLAUDE.md](../mcp/CLAUDE.md)). It takes an optional `format`; agents are
told to strongly prefer `text`. Writing style is instructed in
[../../prompts/commands-messages.md](../../prompts/commands-messages.md): plain
language, no jargon or paths, accurate, a handful per task. Both render surfaces
honour the format via `html/atoms/render-message-body.ts` (text = escaped plain,
markdown = `data-artifact-md` + client marked, html = trusted inline, scripts
stripped).

Storage is the runtime DB (`task_messages`, migration `0015_task_messages.sql`).
`TaskScheduler.deleteTask` clears the rows explicitly, like other task-scoped
tables.

Two delivery surfaces, both fed by `task:message_posted`: the Messages column below,
and — when the task has a Slack origin — its Slack thread, posted by
`SlackPushManager` under the same gates as an escalation (see
[../slack/CLAUDE.md](../slack/CLAUDE.md)).

UI: the **Messages** dock column on the task view
(`html/fragments/task-message.fragment.ts`, served by
`GET /fragments/tasks/:id/messages`, 404 without the flag). Live updates arrive by
WS on `task:message_posted` (`ws/ui-push.ts:pushV2Messages`, OOB-swaps
`#mc-messages-<taskId>`).
