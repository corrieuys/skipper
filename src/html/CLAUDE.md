# src/html

Server-side HTML rendering. No framework — string templates from TS.

## Subdirs

| dir | use |
|---|---|
| `atoms/` | Smallest helpers: `escape-html`, `format-timestamp`, `format-tokens`, `sniff-html` |
| `fragments/` | Single-element snippets (badge, metric, task-row, chat-message, tree-node, phase-step…) |
| `panels/` | Larger composite cards (steer panel, active mission, task queue, phase stepper, escalation bar/card, iterate, metrics bar, artifacts, notes) |
| `pages/` | Full-page renderers (command-center, task-list, task-create, config, logs, grug, agent-terminal). Recurring tasks use the same task-create form (Task Type = Recurring) |
| `shell/` | Layout + navbar wrappers |
| `view-models/` | Data shape feeding renderers (e.g. `command-center.vm.ts`) |
| `styles/` | CSS strings |
| `public/` | Static assets served by Bun |

## Top-level files

Lots of legacy flat `*Fragment.ts` files at this level — pre-reorg into `fragments/panels/pages/`. Two coexist for now. Prefer new subdir layout for new code.

| file | use |
|---|---|
| `components.ts` | Big top-level renderer for standard pages |
| `realtime-components.ts` | Realtime task pages (list, detail, timeline, notes, pipeline, agent assign) |
| `layout.ts`, `baseStyles.ts` | Shared shell + base CSS |
| `chatPartFragment.ts`, `chatFullscreenView.ts`, `chatModePicker.ts` | Chat UI bits |
| `forensics*.ts` | Forensics tab on task detail (timeline, instance tree, delegations, escalations, token usage, terminal tails) |
| `dashboard*Fragment.ts` | Dashboard polling fragments |
