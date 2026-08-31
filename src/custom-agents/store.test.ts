import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache, getAgentTypeDefinition, agentTypeUsesInlinePrompt } from "../agents/types";
import { TeamManager } from "../teams/manager";
import {
  createCustomAgent,
  customAgentTypeName,
  customAgentSoloTeamId,
  deleteCustomAgent,
  getCustomAgentByType,
  isCustomAgentType,
  listCustomAgents,
  normalizeCustomAgentInput,
  registerCustomAgentTypes,
  resolveHeaders,
  resolveSecret,
  updateCustomAgent,
  type CustomAgentInput,
} from "./store";

let db: Database;

function input(overrides: Partial<CustomAgentInput> = {}): CustomAgentInput {
  return {
    name: "Researcher",
    description: "",
    baseUrl: "https://api.example.com/v1",
    modelId: "gpt-test",
    apiKey: "",
    headers: {},
    queryParams: {},
    systemPrompt: "You research things.",
    enabledTools: ["read_file"],
    enabledMcpTools: ["create_note"],
    enabledSkills: [],
    maxSteps: 10,
    temperature: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  clearAgentTypeCache();
});

afterEach(() => {
  db.close();
  clearAgentTypeCache();
});

describe("validation", () => {
  it("requires a name, base URL and model", () => {
    expect(() => normalizeCustomAgentInput(input({ name: " " }))).toThrow(/Name is required/);
    expect(() => normalizeCustomAgentInput(input({ baseUrl: "" }))).toThrow(/Base URL is required/);
    expect(() => normalizeCustomAgentInput(input({ modelId: " " }))).toThrow(/Model is required/);
  });

  it("rejects a base URL that is not http(s)", () => {
    expect(() => normalizeCustomAgentInput(input({ baseUrl: "ftp://x/v1" }))).toThrow(/http or https/);
    expect(() => normalizeCustomAgentInput(input({ baseUrl: "not a url" }))).toThrow(/not a valid URL/);
  });

  // The AI SDK appends the path itself; saving it produces a run-time 404 that
  // looks like an auth failure, so it is caught at save time.
  it("rejects a base URL that already includes /chat/completions", () => {
    expect(() => normalizeCustomAgentInput(input({ baseUrl: "https://x/v1/chat/completions" })))
      .toThrow(/API root/);
  });

  it("accepts a local server with no key", () => {
    const out = normalizeCustomAgentInput(input({ baseUrl: "http://localhost:1234/v1", apiKey: "" }));
    expect(out.baseUrl).toBe("http://localhost:1234/v1");
    expect(out.apiKey).toBe("");
  });

  it("normalizes + persists a chosen identity; junk color/character are dropped", () => {
    const out = normalizeCustomAgentInput(input({ color: "#7BD88F", character: "pod" }));
    expect(out.color).toBe("#7bd88f");
    expect(out.character).toBe("pod");
    const bad = normalizeCustomAgentInput(input({ color: "red", character: "dragon" }));
    expect(bad.color).toBe("#6ea8fe"); // sanitized to default
    expect(bad.character).toBeNull();

    const created = createCustomAgent(db, input({ color: "#c988f0", character: "mite" }));
    const fetched = getCustomAgentByType(db, customAgentTypeName(created.id))!;
    expect(fetched.color).toBe("#c988f0");
    expect(fetched.character).toBe("mite");
  });

  it("strips a trailing slash so the SDK does not build a double slash", () => {
    expect(normalizeCustomAgentInput(input({ baseUrl: "http://localhost:8080/v1/" })).baseUrl)
      .toBe("http://localhost:8080/v1");
  });

  it("bounds max steps and temperature", () => {
    expect(() => normalizeCustomAgentInput(input({ maxSteps: 0 }))).toThrow(/Max steps/);
    expect(() => normalizeCustomAgentInput(input({ maxSteps: 5000 }))).toThrow(/Max steps/);
    expect(() => normalizeCustomAgentInput(input({ temperature: 5 }))).toThrow(/Temperature/);
  });

  it("drops blank header and query keys", () => {
    const out = normalizeCustomAgentInput(input({ headers: { "  ": "x", "X-Real": "y" }, queryParams: { "": "z" } }));
    expect(out.headers).toEqual({ "X-Real": "y" });
    expect(out.queryParams).toEqual({});
  });
});

describe("secret resolution", () => {
  it("substitutes ${ENV_VAR} references", () => {
    expect(resolveSecret("${MY_KEY}", { MY_KEY: "sk-123" })).toBe("sk-123");
    expect(resolveSecret("Bearer ${A}-${B}", { A: "1", B: "2" })).toBe("Bearer 1-2");
  });

  it("leaves a literal value alone", () => {
    expect(resolveSecret("sk-literal", {})).toBe("sk-literal");
  });

  // An unset var resolving to "" means the provider's own 401 explains the
  // problem, rather than the daemon crashing at spawn with no task context.
  it("resolves an unset variable to an empty string", () => {
    expect(resolveSecret("${MISSING}", {})).toBe("");
  });

  it("resolves every header value", () => {
    expect(resolveHeaders({ "api-key": "${K}", "X-Fixed": "v" }, { K: "secret" }))
      .toEqual({ "api-key": "secret", "X-Fixed": "v" });
  });
});

describe("CRUD", () => {
  it("creates and reads back a definition", () => {
    const agent = createCustomAgent(db, input());
    expect(agent.id).toBeTruthy();
    expect(listCustomAgents(db)).toHaveLength(1);
    expect(agent.enabledMcpTools).toEqual(["create_note"]);
  });

  // The editor renders secrets blank, so a save that never touched the field
  // must not wipe them — same contract as the Slack bot token.
  it("keeps a stored api key when the update submits a blank one", () => {
    const created = createCustomAgent(db, input({ apiKey: "sk-secret" }));
    const updated = updateCustomAgent(db, created.id, input({ apiKey: "" }));
    expect(updated.apiKey).toBe("sk-secret");
  });

  it("keeps a stored header value when the update submits a blank one", () => {
    const created = createCustomAgent(db, input({ headers: { "api-key": "azure-secret" } }));
    const updated = updateCustomAgent(db, created.id, input({ headers: { "api-key": "" } }));
    expect(updated.headers).toEqual({ "api-key": "azure-secret" });
  });

  it("replaces a key when the update submits a new one", () => {
    const created = createCustomAgent(db, input({ apiKey: "old" }));
    expect(updateCustomAgent(db, created.id, input({ apiKey: "new" })).apiKey).toBe("new");
  });

  it("round-trips query params", () => {
    const agent = createCustomAgent(db, input({ queryParams: { "api-version": "2024-10-21" } }));
    expect(agent.queryParams).toEqual({ "api-version": "2024-10-21" });
  });
});

describe("agent-type registration", () => {
  it("registers one agent_types row per definition", () => {
    const agent = createCustomAgent(db, input());
    const typeName = customAgentTypeName(agent.id);
    expect(isCustomAgentType(typeName)).toBe(true);

    const def = getAgentTypeDefinition(typeName, db);
    expect(def).not.toBeNull();
    expect(def!.command).toBe("");
    expect(def!.supports_stdin).toBe(false);
    expect(def!.supports_resume).toBe(true);
  });

  // This is what routes every spawn site onto the `initialPrompt` branch instead
  // of sendInput, without any of them knowing custom agents exist.
  it("reports custom types as inline-prompt", () => {
    const agent = createCustomAgent(db, input());
    const def = getAgentTypeDefinition(customAgentTypeName(agent.id), db)!;
    expect(agentTypeUsesInlinePrompt(def)).toBe(true);
    expect(agentTypeUsesInlinePrompt(def, "some-session")).toBe(true);
  });

  it("resolves a definition back from its type name", () => {
    const agent = createCustomAgent(db, input({ name: "Named" }));
    expect(getCustomAgentByType(db, customAgentTypeName(agent.id))?.name).toBe("Named");
    expect(getCustomAgentByType(db, "claude-code")).toBeNull();
  });

  it("removes the agent_types row when the definition is deleted", () => {
    const agent = createCustomAgent(db, input());
    const typeName = customAgentTypeName(agent.id);
    expect(getAgentTypeDefinition(typeName, db)).not.toBeNull();

    deleteCustomAgent(db, agent.id);
    expect(getAgentTypeDefinition(typeName, db)).toBeNull();
  });

  // A row left behind by a definition deleted outside the app would otherwise
  // sit in the team-map provider list forever, pointing at nothing.
  it("prunes orphaned custom rows on re-registration", () => {
    db.prepare(
      "INSERT INTO agent_types (name, command, args, available_models, env_vars) VALUES ('custom:gone', '', '[]', '[]', '{}')",
    ).run();
    registerCustomAgentTypes(db);
    expect(getAgentTypeDefinition("custom:gone", db)).toBeNull();
  });

  it("leaves the seeded CLI types alone", () => {
    createCustomAgent(db, input());
    registerCustomAgentTypes(db);
    expect(getAgentTypeDefinition("claude-code", db)).not.toBeNull();
  });
});

describe("solo projection (ca:<id> team-of-one)", () => {
  it("projects a resolvable, skipper-free team-of-one whose entrypoint is the custom agent", () => {
    const agent = createCustomAgent(db, input({ name: "Solo Bot" }));
    const teamId = customAgentSoloTeamId(agent.id);
    const exec = new TeamManager(db).getTeamForExecution(teamId);
    expect(exec).toBeTruthy();
    expect(exec!.entrypoint_agent_id).toBe(teamId); // entrypoint = the ca: agent itself
    expect(exec!.team.phases.length).toBe(0);
    // Entrypoint agent row exists with the custom:<id> type.
    const row = db.prepare("SELECT type FROM agents WHERE id = ?").get(teamId) as { type: string } | null;
    expect(row?.type).toBe(customAgentTypeName(agent.id));
    // Exactly one member (the agent); NO skipper lead.
    const members = db.prepare("SELECT agent_id FROM team_agents WHERE team_id = ?").all(teamId) as Array<{ agent_id: string }>;
    expect(members.length).toBe(1);
    expect(members[0]!.agent_id).toBe(teamId);
    expect(members.some((m) => m.agent_id === "skipper")).toBe(false);
  });

  it("removes the solo projection on delete", () => {
    const agent = createCustomAgent(db, input());
    const teamId = customAgentSoloTeamId(agent.id);
    expect(new TeamManager(db).getTeamForExecution(teamId)).toBeTruthy();
    deleteCustomAgent(db, agent.id);
    expect(new TeamManager(db).getTeamForExecution(teamId)).toBeNull();
    expect(db.prepare("SELECT id FROM agents WHERE id = ?").get(teamId)).toBeNull();
  });
});
