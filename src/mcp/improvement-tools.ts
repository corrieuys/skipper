import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentIdentity } from "./auth";
import { isCustomAgentType } from "../agents/types";
import { isSingleAgentRefType } from "../single-agents/store";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import {
  type Improvement,
  type ImprovementContext,
  type ImprovementStatus,
  type ImprovementTarget,
  getImprovementContext,
  hasImprovementTargets,
  improvementState,
  libraryTargetKey,
  listImprovements,
  readLiveTarget,
  stageSkillSuggestion,
  submitImprovement,
} from "../improvements/manager";

/**
 * Team housekeeping tools (experimental, root Skipper only; see
 * src/improvements). The propose_* tools stage an improvement for operator
 * review, or apply it at once when the operator turned auto-approve on; the
 * result's `status` (staged / applied) says which.
 *
 * Visibility is fixed at session create from the task: team tools only for a
 * local team (a remote team's config lives in its repository), the recurring
 * description tool only on a run of a recurring task. Every call re-reads the
 * context, so the live team is always what the tool acts on.
 */

const STAGED_NOTE =
  "Staged, not applied. The operator reviews it on the Improvements page. This run and later runs use the current text until it is approved.";
const APPLIED_NOTE =
  "Applied: the operator has auto-approve on, so the change is live. Later runs use the new text; this run keeps the prompt it started with.";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function errorText(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
}

/** Library target keys for the team's library members, so list_improvements sees proposals made from other teams. */
function libraryKeys(ctx: ImprovementContext): string[] {
  return (ctx.team?.agents ?? [])
    .filter((a) => isSingleAgentRefType(a.type) || isCustomAgentType(a.type))
    .map((a) => libraryTargetKey(a.type));
}

function outcome(imp: Improvement, applied: boolean) {
  return text({
    status: applied ? "applied" : "staged",
    improvement_id: imp.id,
    target: imp.target_label,
    note: applied ? APPLIED_NOTE : STAGED_NOTE,
  });
}

export function registerImprovementTools(
  server: McpServer,
  db: Database,
  getIdentity: () => AgentIdentity | null,
): void {
  const identity = getIdentity();
  const initial = getImprovementContext(db, identity?.type === "internal" ? identity.taskId : null);
  // Same gate as the TEAM HOUSEKEEPING prompt block (prompt-builder.ts).
  if (!initial || !hasImprovementTargets(initial)) return;
  const teamTools = !!initial.team;
  const recurringTool = !!initial.scheduledTaskId;
  const skillTool = !!initial.teamId;

  /** Fresh context for the calling task, or an error result. */
  function context(): ImprovementContext | ReturnType<typeof errorText> {
    const id = getIdentity();
    if (!id || id.type !== "internal") return errorText("agent not authenticated");
    const ctx = getImprovementContext(db, id.taskId);
    return ctx ?? errorText("no active task");
  }
  const isError = (v: unknown): v is ReturnType<typeof errorText> => !!v && typeof v === "object" && "content" in v;

  server.tool(
    "get_team_config",
    "Read the current configuration you maintain: team lead instructions, phase prompts, team members' instructions and, on a recurring run, the recurring task description. Each text comes with a `revision`; pass it unchanged to the matching propose_* tool.",
    {},
    async () => {
      const ctx = context();
      if (isError(ctx)) return ctx;
      try {
        const out: Record<string, unknown> = {};
        if (ctx.team) {
          const team = ctx.team;
          const lead = readLiveTarget(db, { kind: "lead_instructions", teamId: team.id });
          out.team = { id: team.id, name: team.name };
          out.lead_instructions = lead ? { agent_id: "skipper", text: lead.text, revision: lead.revision } : null;
          out.phases = team.phases.map((p, index) => {
            const live = readLiveTarget(db, { kind: "phase_prompt", teamId: team.id, phaseIndex: index, phaseName: p.name });
            return {
              index,
              name: p.name,
              prompt: live?.text ?? "",
              revision: live?.revision ?? null,
              review_gate: !!p.review,
              ...(ctx.overriddenPhases.has(p.name) ? { overridden_for_this_task: true } : {}),
            };
          });
          out.agents = team.agents.map((a) => {
            const library = isSingleAgentRefType(a.type) || isCustomAgentType(a.type);
            const live = readLiveTarget(db, { kind: "agent_instruction", teamId: team.id, agentRef: library ? a.type : a.id });
            return {
              agent_id: a.id,
              name: a.name,
              role: a.role ?? null,
              ...(library ? { library_agent: true, used_by_teams: live?.usedByTeams ?? 0 } : {}),
              instruction: live?.text ?? "",
              revision: live?.revision ?? null,
            };
          });
        } else if (ctx.remoteTeam) {
          out.team = { id: ctx.teamId, remote: true };
        }
        if (ctx.scheduledTaskId) {
          const live = readLiveTarget(db, { kind: "recurring_description", scheduledTaskId: ctx.scheduledTaskId });
          const rec = new ScheduledTaskScheduler(db).getScheduledTask(ctx.scheduledTaskId);
          out.recurring_task = live && rec
            ? { id: rec.id, title: rec.title, description: live.text, revision: live.revision }
            : null;
        } else {
          out.recurring_task = null;
        }
        return text(out);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "list_improvements",
    "List improvements staged for this team, its library agents and this recurring task (by any run), newest first. Check it before you stage anything, so you do not stage a change that is already pending.",
    {
      status: z.enum(["pending", "approved", "rejected", "all"]).optional().describe("Default pending"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
    },
    async ({ status, limit }) => {
      const ctx = context();
      if (isError(ctx)) return ctx;
      try {
        const rows = listImprovements(db, {
          status: status === "all" ? undefined : ((status ?? "pending") as ImprovementStatus),
          teamId: ctx.teamId,
          scheduledTaskId: ctx.scheduledTaskId,
          targetKeys: libraryKeys(ctx),
          limit: limit ?? 30,
        });
        return text(rows.map((imp) => {
          const state = improvementState(db, imp).state;
          return {
            improvement_id: imp.id,
            kind: imp.kind,
            status: imp.status,
            target: imp.target_label,
            proposed_text: imp.proposed_text,
            reason: imp.reason,
            proposed_by_run: imp.source_task_title,
            created_at: imp.created_at,
            ...(imp.status === "pending" && state !== "suggestion" ? { conflict: state === "conflict" || state === "missing" } : {}),
          };
        }));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  function stage(target: ImprovementTarget, proposedText: string, revision: string, reason: string, taskId: string) {
    try {
      const { improvement, applied } = submitImprovement(db, { target, proposedText, revision, reason, sourceTaskId: taskId });
      return outcome(improvement, applied);
    } catch (err) {
      return errorText(err);
    }
  }

  if (teamTools) {
    server.tool(
      "propose_phase_prompt",
      "Propose a new prompt for one of this team's phases. The result `status` says whether it was staged for operator review or applied at once (auto-approve). Send the FULL new prompt, built on the current text from get_team_config. Only for problems that apply to every task on this team.",
      {
        phase_index: z.number().int().min(0).describe("Phase index from get_team_config (0-based)"),
        phase_name: z.string().describe("Phase name from get_team_config (must match the index)"),
        prompt: z.string().describe("Full new phase prompt"),
        revision: z.string().describe("The phase's revision from get_team_config"),
        reason: z.string().describe("The evidence from this run that the current prompt misled the team"),
      },
      async ({ phase_index, phase_name, prompt, revision, reason }) => {
        const ctx = context();
        if (isError(ctx)) return ctx;
        if (!ctx.team) return errorText("this task has no local team");
        return stage({ kind: "phase_prompt", teamId: ctx.team.id, phaseIndex: phase_index, phaseName: phase_name }, prompt, revision, reason, ctx.taskId);
      },
    );

    server.tool(
      "propose_agent_instruction",
      "Propose a new instruction for a team member, or for your own team lead instructions (agent_id \"skipper\"). The result `status` says whether it was staged for operator review or applied at once (auto-approve). Send the FULL new instruction, built on the current text from get_team_config. A library agent (library_agent: true) is shared with other teams (used_by_teams).",
      {
        agent_id: z.string().describe("agent_id from get_team_config, or \"skipper\" for the team lead instructions"),
        instruction: z.string().describe("Full new instruction"),
        revision: z.string().describe("The agent's revision from get_team_config"),
        reason: z.string().describe("The evidence from this run that the current instruction misled the agent"),
      },
      async ({ agent_id, instruction, revision, reason }) => {
        const ctx = context();
        if (isError(ctx)) return ctx;
        if (!ctx.team) return errorText("this task has no local team");
        if (agent_id === "skipper") {
          return stage({ kind: "lead_instructions", teamId: ctx.team.id }, instruction, revision, reason, ctx.taskId);
        }
        const member = ctx.team.agents.find((a) => a.id === agent_id);
        if (!member) return errorText(`no team member with agent_id "${agent_id}" (see get_team_config)`);
        const library = isSingleAgentRefType(member.type) || isCustomAgentType(member.type);
        return stage(
          { kind: "agent_instruction", teamId: ctx.team.id, agentRef: library ? member.type : member.id },
          instruction,
          revision,
          reason,
          ctx.taskId,
        );
      },
    );
  }

  if (recurringTool) {
    server.tool(
      "propose_recurring_description",
      "Propose a new description for the recurring task this run came from. The result `status` says whether it was staged for operator review or applied at once (auto-approve); later runs copy the live text. Send the FULL new description, built on the current text from get_team_config.",
      {
        description: z.string().describe("Full new description"),
        revision: z.string().describe("recurring_task.revision from get_team_config"),
        reason: z.string().describe("The evidence from this run that the current description misled the team"),
      },
      async ({ description, revision, reason }) => {
        const ctx = context();
        if (isError(ctx)) return ctx;
        if (!ctx.scheduledTaskId) return errorText("this run did not come from a recurring task");
        return stage({ kind: "recurring_description", scheduledTaskId: ctx.scheduledTaskId }, description, revision, reason, ctx.taskId);
      },
    );
  }

  if (skillTool) {
    server.tool(
      "propose_skill_change",
      "Record a suggested change to a skill that you or a team member used. Skills come from outside Skipper, so this only reaches the operator on the Improvements page. Use it ONLY when the task description, a phase prompt or your team lead instructions explicitly tell you to review skills.",
      {
        skill: z.string().describe("Skill name"),
        agent_id: z.string().optional().describe("agent_id of the team member that used it (omit for yourself)"),
        problem: z.string().describe("What went wrong with the skill in this run, with evidence"),
        suggestion: z.string().describe("The change you suggest"),
      },
      async ({ skill, agent_id, problem, suggestion }) => {
        const ctx = context();
        if (isError(ctx)) return ctx;
        const member = agent_id ? ctx.team?.agents.find((a) => a.id === agent_id) : undefined;
        try {
          return outcome(stageSkillSuggestion(db, {
            teamId: ctx.teamId,
            skillName: skill,
            agentRef: agent_id ?? "skipper",
            agentLabel: member?.name ?? (agent_id ? agent_id : "Skipper"),
            problem,
            suggestion,
            sourceTaskId: ctx.taskId,
          }), false);
        } catch (err) {
          return errorText(err);
        }
      },
    );
  }
}

