# src/improvements

Team housekeeping (experimental). At the end of every run the root Skipper
reviews what misled the run and **stages** improvements to the configuration it
maintains. By default nothing is applied until the operator approves it on the
**Improvements** page (`/improvements`, nav "Improvements"); see the auto-approve
gate below.

| file | use |
|---|---|
| `manager.ts` | Store + lifecycle over the runtime `improvements` table (migration `0029_improvements.sql`, no FKs: a proposal outlives the run that staged it). Targets: `phase_prompt` (team phase by index + name), `lead_instructions` (team `skipper_prompt`), `agent_instruction` (inline member, or a library agent `single:<id>` / `custom:<id>`), `recurring_description` (the series the run came from), plus `skill_suggestion` (no target; acknowledge / dismiss only). `readLiveTarget` reads the current text + `textRevision` (sha256, 12 hex); `stageImprovement` refuses a stale caller revision, a missing target, a no-op and a remote team; `editImprovement` replaces the proposed text AND rebases it onto the live text (the operator saw it, so the edit is the merge); `approveImprovement` refuses a conflict, then writes through the normal writer (`updateLocalTeam`, `updateSingleAgent` + `reflattenTeamsReferencingAgentType`, `updateCustomAgent`, `ScheduledTaskScheduler.setDescription`); `rejectImprovement`. `getImprovementContext` / `hasImprovementTargets` decide, per task, which tools a root session gets and whether the prompt block is injected |

**Auto-approve gate.** `SETTING_IMPROVEMENTS_AUTO_APPROVE` (runtime
`app_settings`, config page "Improvements" panel, experimental, default off).
The tools call `submitImprovement`: stage, then, when the gate is on, approve at
once. The tool result's `status` is `applied` or `staged` (an auto-approve that
loses a race stays staged), and the prompt tells Skipper to report each
proposal and its result to the operator with one `post_message`. Skill
suggestions have nothing to apply and always wait.

**Many proposals, one target.** Any number of pending improvements may target
the same text; staging never blocks. Each keeps `base_revision`, the revision of
the live text it was written against. `improvementState` derives `ready` /
`conflict` (live revision moved: another approval or a manual edit) / `missing`
(phase renamed or removed, member gone, record deleted) / `suggestion` /
`decided`. Approve refuses `conflict`; the operator edits (rebases), then approves.

**Library agents** are keyed `agent:<type>`, shared by every team that
references them, so proposals from several teams group together. Approving one
writes the library record; the card shows how many teams use it.

**Events.** Every write emits `improvement:changed { improvementId, change: created|updated }`
(never deleted). `ws/ui-push.ts` prepends a created card to `#imp-list`,
replaces a changed card and its pending siblings on the same target, and
re-renders the pending cards of a team / series on `team:changed` /
`recurring:changed` (topic `improvements`). Connect forwards the event fat
(`improvement` row, `connect/events.ts`); no app screen yet.

**Agent side.** `mcp/improvement-tools.ts` registers, on a root session under
`--experimental` only: `get_team_config`, `list_improvements`,
`propose_phase_prompt`, `propose_agent_instruction` (team tools: local team
only, never a remote one), `propose_recurring_description` (only on a run of a
recurring task, remote team or not) and `propose_skill_change` (only when the
task explicitly asks for a skill review; prompt-level). The prompt block is
`prompts/team-housekeeping.md`, injected by `agents/prompt-builder.ts` with the
same gate.

**Top-bar attention indicator** (experimental): `data/attention.ts:fetchAttentionCounts`
(pending improvements, active tasks at a review gate, open escalations on
active tasks) rendered by `html/fragments/attention.fragment.ts` in the navbar
left of the games icon, one chip per kind linking to `/improvements` or the
newest such task. `ws/ui-push.ts:pushAttention` re-renders it OOB (debounced)
on `improvement:changed`, `escalation:created|resolved`,
`task:needs_review_changed`, `task:state_changed`, `task:run_completed|failed`,
topic `attention`, which `shell/layout.ts:v2layout` adds to every page's topics.

**Page.** `routes/improvements.ts` (also `POST /api/settings/improvements-auto-approve`) (404 without `--experimental`),
`html/pages/improvements.page.ts`, `html/fragments/improvement-card.fragment.ts`
(line diff, card is the htmx swap unit: approve / reject / edit / save / cancel
all target `closest .imp-card` outerHTML).
