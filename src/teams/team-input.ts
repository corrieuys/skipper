// Coercion from raw create/update/import bodies (JSON or team-map form
// payloads) into LocalTeamInput. Shared by the HTML/JSON routes in
// src/routes/teams.ts and the /data API in src/routes/data/teams.ts.
import { randomUUID } from "crypto";
import type { TeamPhase } from "../config/store";
import type { LocalTeamAgent, LocalTeamConfig, LocalTeamInput } from "./local-teams";
import { normalizeSlashCommand } from "../slack/slash-command";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureUniqueId(base: string, used: Set<string>): string {
  let candidate = base || `agent-${randomUUID().slice(0, 8)}`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let i = 2;
  while (used.has(`${candidate}-${i}`)) i++;
  const id = `${candidate}-${i}`;
  used.add(id);
  return id;
}

/** Coerce an arbitrary phase-shaped value into a TeamPhase. */
function coercePhase(raw: unknown): TeamPhase | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) return null;
  const phase: TeamPhase = {
    name,
    prompt: typeof p.prompt === "string" ? p.prompt : "",
  };
  if (typeof p.review === "boolean") phase.review = p.review;
  if (p.consensus && typeof p.consensus === "object") {
    const c = p.consensus as Record<string, unknown>;
    phase.consensus = {
      agent_count: typeof c.agent_count === "number" ? c.agent_count : 2,
      strategy: typeof c.strategy === "string" ? c.strategy : "best_of",
      worktree: !!c.worktree,
      ...(typeof c.reviewer_agent_id === "string" ? { reviewer_agent_id: c.reviewer_agent_id } : {}),
    };
  }
  return phase;
}

/** Coerce an arbitrary agent-shaped value into a LocalTeamAgent, assigning an id if missing. */
function coerceAgent(raw: unknown, usedIds: Set<string>): LocalTeamAgent | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  const type = typeof a.type === "string" ? a.type.trim() : "";
  const model = typeof a.model === "string" ? a.model.trim() : "";
  if (!type) return null;
  const requestedId = typeof a.id === "string" && a.id.trim() ? a.id.trim() : slugify(name);
  const id = ensureUniqueId(requestedId, usedIds);
  const agent: LocalTeamAgent = {
    id,
    name: name || id,
    type,
    model,
  };
  if (typeof a.instruction === "string") agent.instruction = a.instruction;
  if (typeof a.role === "string") agent.role = a.role;
  if (Array.isArray(a.capabilities)) {
    agent.capabilities = (a.capabilities as unknown[]).filter((c): c is string => typeof c === "string");
  }
  // Operator-defined tools granted to this agent on this team. This is the only
  // route by which a CLI agent gets one — see src/custom-tools.
  if (Array.isArray(a.customTools)) {
    agent.customTools = (a.customTools as unknown[]).filter((c): c is string => typeof c === "string");
  }
  return agent;
}

/**
 * Resolve the per-team config blob from a create/update/import body. The team
 * form posts `slack_enabled` (checkbox) + `slash_command`; import bodies carry a
 * nested `config` object. Form fields take precedence when present.
 */
function coerceTeamConfig(body: Record<string, unknown>, existing?: LocalTeamConfig): LocalTeamConfig {
  // Start from the stored config so fields the body does not mention are
  // preserved. Only override slackEnabled/slashCommand when the body actually
  // carries a signal for them (nested `config` on import/JSON, or the flat form
  // fields — which readBody only sets when the Slack section was rendered).
  let slackEnabled = existing?.slackEnabled ?? false;
  let slashCommand: string | undefined = existing?.slashCommand;
  let skipperCustomTools: string[] | undefined = existing?.skipperCustomTools;
  let mode: "regular" | "realtime" | undefined = existing?.mode;
  let realtime = existing?.realtime;

  if (body.config && typeof body.config === "object") {
    const c = body.config as Record<string, unknown>;
    if ("mode" in c) mode = c.mode === "realtime" ? "realtime" : "regular";
    if ("realtime" in c && c.realtime && typeof c.realtime === "object") {
      const r = c.realtime as Record<string, unknown>;
      realtime = {
        summaryEnabled: r.summaryEnabled !== false,
        ...(typeof r.summaryProvider === "string" && r.summaryProvider.trim() ? { summaryProvider: r.summaryProvider.trim() } : {}),
        ...(typeof r.summaryModel === "string" ? { summaryModel: r.summaryModel.trim() } : {}),
      };
    }
    if ("slackEnabled" in c) slackEnabled = c.slackEnabled === true;
    if ("slashCommand" in c) {
      slashCommand = typeof c.slashCommand === "string" && c.slashCommand.trim()
        ? normalizeSlashCommand(c.slashCommand)
        : undefined;
    }
    // Custom tools granted to this team's Skipper. Same presence contract as
    // slashCommand: the key must be there for the stored value to change.
    if ("skipperCustomTools" in c) {
      skipperCustomTools = Array.isArray(c.skipperCustomTools)
        ? (c.skipperCustomTools as unknown[]).filter((n): n is string => typeof n === "string")
        : undefined;
    }
  }
  if ("slack_enabled" in body) {
    slackEnabled = body.slack_enabled === true || body.slack_enabled === "on" || body.slack_enabled === "true";
  }
  if ("slash_command" in body) {
    const raw = typeof body.slash_command === "string" ? body.slash_command.trim() : "";
    slashCommand = raw ? normalizeSlashCommand(raw) : undefined;
  }
  const config: LocalTeamConfig = { slackEnabled };
  if (mode) config.mode = mode;
  if (realtime) config.realtime = realtime;
  if (slashCommand) config.slashCommand = slashCommand;
  if (skipperCustomTools && skipperCustomTools.length > 0) config.skipperCustomTools = skipperCustomTools;
  return config;
}

/** Build a LocalTeamInput from a raw JSON object (used by create/update/import). */
export function toTeamInput(body: Record<string, unknown>, opts: { withId?: boolean; existingConfig?: LocalTeamConfig } = {}): LocalTeamInput {
  const usedIds = new Set<string>();
  const rawAgents = Array.isArray(body.agents) ? body.agents : [];
  const agents = rawAgents
    .map((a) => coerceAgent(a, usedIds))
    .filter((a): a is LocalTeamAgent => a !== null);
  const rawPhases = Array.isArray(body.phases) ? body.phases : [];
  const phases = rawPhases
    .map(coercePhase)
    .filter((p): p is TeamPhase => p !== null);

  const input: LocalTeamInput = {
    name: typeof body.name === "string" ? body.name.trim() : "",
    skipper_prompt: typeof body.skipper_prompt === "string" ? body.skipper_prompt : "",
    hooks: Array.isArray(body.hooks) ? body.hooks : [],
    phases,
    agents,
    config: coerceTeamConfig(body, opts.existingConfig),
  };
  if (opts.withId && typeof body.id === "string" && body.id.trim()) {
    input.id = body.id.trim();
  }
  return input;
}

