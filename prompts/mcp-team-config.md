# Skipper team configuration

Reference for how teams, phases, approvals, and agent config work in Skipper.
Use it to understand what a team you assign a task to will do, and how a task
moves from creation to done.

## What a team is

A team is a reusable execution shape: an ordered set of phases plus a flat crew
of agents. Every task runs on exactly one team. A task references a team by
`team_id` (discover ids with `list_teams`). One agent, "Skipper", is the
implicit root of every team; it is the entrypoint and coordinator and has no
member row of its own.

Teams are configured in the Skipper web UI only (the team map at `/teams`).
There is no create-team, edit-team, or configure-phase capability over MCP.
Over MCP you can only list teams and assign a task to one.

## Membership and agent config

Membership is flat. There is no reporting hierarchy: every crew member can be
delegated to, and each agent is given the full roster of the task's team.

Each member carries:

- provider + model (a raw CLI agent such as claude-code, codex, opencode, grok;
  or a live reference to a saved headless CLI agent `single:<id>` or a custom
  in-process agent `custom:<id>`).
- role + level (labels only; they do not create a hierarchy).
- an optional prompt, capabilities, and granted custom tools. A member's
  `customTools` are the only way a raw CLI agent is granted an operator-defined
  tool; a custom agent may also carry its own always-on list, and a session gets
  the union.
- an optional identity (color + creature character) used by the UI.

Library-reference members (`single:`/`custom:`) resolve the referenced record's
provider, model, prompt, capabilities, and tools at run time, so editing the
library agent updates every team that references it.

Skipper (the root) gets its own granted custom tools via the team's
`skipperCustomTools` setting, edited on the team map's Skipper card.

## Phases

Phases live on the team. A team has 0..n phases. Each phase carries a prompt and
an optional review gate. Phase index starts at 0 and increments when the root
completes a phase (`complete_phase`); the root can also send work back a phase
(`regress_phase`). Both team modes support phases.

When a phase has a review gate, the task pauses at the end of that phase and
presents for review (`display_status: review`). Operator input while a task is
at a review gate counts as the review response and releases the phase; over MCP,
send that response with `input_task`.

## Modes and autopilot

A team has a default mode, `workflow` or `conversational`, which sets a new
task's default autopilot:

- workflow (autopilot on): the system drives the task to the end of its phases
  on its own (idle pokes, stale recovery, and a drive-mode instruction telling
  the root to advance phases without waiting).
- conversational (autopilot off): the operator drives. The root finishes the
  current instruction, then rests and never advances phases uninstructed.

Autopilot is stored per task and can be toggled mid-task; the team mode only
seeds the default.

## Approvals and task lifecycle

Stored task status is only `draft`, `active`, or `settled`; everything else
(queued, working, idle, paused, review, blocked, completed, failed) is derived
display state.

1. Create a task as a `draft` (`create_task`). A draft is editable
   (`update_task`) and does not run yet.
2. Approve it (`approve_task`) to hand it to the daemon, which starts running it
   on its team (`active`).
3. While active you can `pause_task` / `resume_task`, steer it with `create_note`
   or `input_task`, and answer review gates with `input_task`.
4. It ends by settling: `complete_task` (archive as done, optional result),
   `cancel_task` (settle as cancelled; a still-draft task is deleted instead),
   or the run finishing on its own. A settled task presents as Completed or
   Failed. Sending `input_task` to a settled task revives it.

## Slack (per team)

A team may have Slack enabled in its config. Slack posting for a task is gated on
the task's own team having Slack enabled, independent of any thread the task
inherited. A team may also bind a Slack slash command that creates and
auto-approves a task on that team.

## What is NOT available over MCP

No team, phase, approval-gate, or agent-member configuration is exposed over
MCP on any audience. Team setup is web-only. Over MCP you assign a task to an
existing team by `team_id` and drive the task through its lifecycle with the
task tools above.
