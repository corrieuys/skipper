import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { createLocalTeam, deleteLocalTeam, listLocalTeams } from "../teams/local-teams";
import { createCustomAgent, customAgentTypeName } from "../custom-agents/store";
import { clearAgentTypeCache } from "../agents/types";
import { executeCustomTool, formatExecution } from "./runtime";
import { registerCustomTools, resolveSessionCustomTools } from "./registration";
import {
  createCustomTool,
  deleteCustomTool,
  getCustomToolByName,
  listCustomTools,
  normalizeToolInput,
  toolZodShape,
  updateCustomTool,
  type CustomToolInput,
} from "./store";

let db: Database;

function input(overrides: Partial<CustomToolInput> = {}): CustomToolInput {
  return {
    name: "lookup_customer",
    description: "Look up a customer by id",
    parameters: [{ name: "id", type: "string", description: "Customer id", required: true }],
    code: "return 'customer ' + args.id;",
    timeoutMs: 5000,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  clearAgentTypeCache();
});

afterEach(() => {
  // `createLocalTeam` registers its agents into the PROCESS-GLOBAL config store
  // Maps, which outlive this file's database. Left behind, a custom-typed agent
  // makes every later test file's snapshot load stub in a `custom:` agent type.
  for (const team of listLocalTeams(db)) deleteLocalTeam(db, team.id);
  db.close();
  clearAgentTypeCache();
});

describe("validation", () => {
  it("requires a name, a description and a body", () => {
    expect(() => normalizeToolInput(input({ name: "" }))).toThrow(/Name is required/);
    expect(() => normalizeToolInput(input({ description: "" }))).toThrow(/Description is required/);
    expect(() => normalizeToolInput(input({ code: "   " }))).toThrow(/body is empty/);
  });

  // The name goes straight to the provider as a function name.
  it("rejects a name a model could not call", () => {
    expect(() => normalizeToolInput(input({ name: "2fast" }))).toThrow(/must start with a letter/);
    expect(() => normalizeToolInput(input({ name: "has spaces" }))).toThrow(/must start with a letter/);
  });

  // Registering over a built-in would silently replace it on that session.
  it("refuses to shadow a built-in Skipper tool", () => {
    expect(() => normalizeToolInput(input({ name: "create_note" }))).toThrow(/built-in Skipper tool/);
    expect(() => normalizeToolInput(input({ name: "read_file" }))).toThrow(/built-in Skipper tool/);
  });

  it("rejects duplicate or malformed parameters", () => {
    expect(() => normalizeToolInput(input({
      parameters: [
        { name: "a", type: "string", description: "", required: true },
        { name: "a", type: "string", description: "", required: true },
      ],
    }))).toThrow(/Duplicate parameter/);
    expect(() => normalizeToolInput(input({
      parameters: [{ name: "no-hyphens", type: "string", description: "", required: true }],
    }))).toThrow(/not a valid identifier/);
  });

  it("bounds the timeout", () => {
    expect(() => normalizeToolInput(input({ timeoutMs: 5 }))).toThrow(/Timeout must be/);
    expect(() => normalizeToolInput(input({ timeoutMs: 999_999 }))).toThrow(/Timeout must be/);
  });
});

describe("schema", () => {
  // The MCP server takes a Zod raw shape, which is also what Skipper's own tools
  // pass — a JSON Schema object is rejected outright at registration.
  it("derives a Zod shape from the parameter rows", () => {
    const shape = toolZodShape({
      parameters: [
        { name: "id", type: "string", description: "Customer id", required: true },
        { name: "count", type: "number", description: "", required: false },
        { name: "verbose", type: "boolean", description: "", required: false },
      ],
    });
    expect(Object.keys(shape).sort()).toEqual(["count", "id", "verbose"]);
    expect(shape.id!.safeParse("abc").success).toBe(true);
    expect(shape.id!.safeParse(42).success).toBe(false);
    expect(shape.count!.safeParse(undefined).success).toBe(true);
    expect(shape.id!.safeParse(undefined).success).toBe(false);
    expect(shape.verbose!.safeParse(true).success).toBe(true);
  });

  it("builds an empty shape when there are no parameters", () => {
    expect(toolZodShape({ parameters: [] })).toEqual({});
  });
});

describe("CRUD", () => {
  it("creates, updates and deletes", () => {
    const tool = createCustomTool(db, input());
    expect(listCustomTools(db)).toHaveLength(1);
    expect(updateCustomTool(db, tool.id, input({ description: "Changed" })).description).toBe("Changed");
    expect(deleteCustomTool(db, tool.id)).toBe(true);
    expect(getCustomToolByName(db, "lookup_customer")).toBeNull();
  });

  it("refuses a duplicate name", () => {
    createCustomTool(db, input());
    expect(() => createCustomTool(db, input())).toThrow(/already called/);
  });
});

describe("execution", () => {
  it("runs the body with the parameters and returns what it returned", async () => {
    const result = await executeCustomTool(
      { name: "t", code: "return 'hello ' + args.who;", timeoutMs: 5000 },
      { who: "world" },
      { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello world");
  });

  it("awaits an async body", async () => {
    const result = await executeCustomTool(
      { name: "t", code: "await new Promise(r => setTimeout(r, 10)); return 42;", timeoutMs: 5000 },
      {}, { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("42");
  });

  it("serialises an object return value", async () => {
    const result = await executeCustomTool(
      { name: "t", code: "return { a: 1 };", timeoutMs: 5000 },
      {}, { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(JSON.parse(result.output)).toEqual({ a: 1 });
  });

  it("passes the run context through", async () => {
    const result = await executeCustomTool(
      { name: "t", code: "return ctx.taskId + '/' + ctx.instanceId;", timeoutMs: 5000 },
      {}, { taskId: "task-9", agentId: "a", instanceId: "inst-3", workingDir: "/tmp" },
    );
    expect(result.output).toBe("task-9/inst-3");
  });

  it("captures console output alongside the result", async () => {
    const result = await executeCustomTool(
      { name: "t", code: "console.log('step one'); console.log({ n: 2 }); return 'done';", timeoutMs: 5000 },
      {}, { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(result.logs).toEqual(["step one", '{"n":2}']);
    expect(formatExecution(result)).toContain("[log] step one");
    expect(formatExecution(result)).toContain("done");
  });

  // A broken tool must come back as a readable tool result, not an exception
  // that kills the agent's turn.
  it("returns a throw as a failed result rather than rejecting", async () => {
    const result = await executeCustomTool(
      { name: "t", code: "throw new Error('nope');", timeoutMs: 5000 },
      {}, { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("nope");
    expect(formatExecution(result)).toContain("Error:");
  });

  it("reports a syntax error instead of hanging", async () => {
    const result = await executeCustomTool(
      { name: "t", code: "return (;", timeoutMs: 5000 },
      {}, { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(result.ok).toBe(false);
  });

  // The whole reason execution is in a Worker: an infinite loop on the daemon's
  // own thread could not be interrupted, and would take the orchestrator with it.
  it("terminates a runaway loop at the timeout and stays responsive", async () => {
    const started = Date.now();
    const result = await executeCustomTool(
      { name: "spin", code: "while (true) {}", timeoutMs: 700 },
      {}, { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);

    // The daemon's own loop is still fine.
    const after = await executeCustomTool(
      { name: "t", code: "return 'alive';", timeoutMs: 5000 },
      {}, { taskId: null, agentId: null, instanceId: "i1", workingDir: "/tmp" },
    );
    expect(after.output).toBe("alive");
  }, 20_000);
});

describe("session resolution", () => {
  function seedInstance(runtimeId: string, templateAgentId: string, taskId: string, providerType?: string): void {
    db.prepare("INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, 'T', 'running')").run(taskId);
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, state_metadata, attempt)
       VALUES (?, ?, ?, NULL, ?, 'running', ?, 1)`,
    ).run(runtimeId, taskId, templateAgentId, runtimeId, JSON.stringify(providerType ? { provider_type: providerType } : {}));
  }

  it("grants what the custom agent definition enables", () => {
    createCustomTool(db, input());
    const agent = createCustomAgent(db, {
      name: "A", description: "", baseUrl: "http://x/v1", modelId: "m", apiKey: "",
      headers: {}, queryParams: {}, systemPrompt: "",
      enabledTools: [], enabledMcpTools: [], enabledServerTools: [],
      enabledCustomTools: ["lookup_customer"], enabledSkills: [], maxSteps: 5, temperature: null,
    });
    seedInstance("rt-1", "agent-1", "t-solo", customAgentTypeName(agent.id));

    expect(resolveSessionCustomTools(db, "rt-1").map((t) => t.name)).toEqual(["lookup_customer"]);
  });

  // The only route by which a CLI agent gets a custom tool.
  it("grants what the team's agent card enables, for a CLI agent", () => {
    createCustomTool(db, input());
    const team = createLocalTeam(db, {
      name: "T",
      phases: [{ name: "build", prompt: "" }],
      agents: [{ id: "coder", name: "Coder", type: "claude-code", model: "default", customTools: ["lookup_customer"] }],
    });
    db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('t1','T',?,'running')").run(team.id);
    seedInstance("rt-2", "coder", "t1", "claude-code");

    expect(resolveSessionCustomTools(db, "rt-2").map((t) => t.name)).toEqual(["lookup_customer"]);
  });

  it("takes the union of both grants, without duplicating", () => {
    createCustomTool(db, input());
    createCustomTool(db, input({ name: "team_only", code: "return 1;" }));
    const agent = createCustomAgent(db, {
      name: "A", description: "", baseUrl: "http://x/v1", modelId: "m", apiKey: "",
      headers: {}, queryParams: {}, systemPrompt: "",
      enabledTools: [], enabledMcpTools: [], enabledServerTools: [],
      enabledCustomTools: ["lookup_customer"], enabledSkills: [], maxSteps: 5, temperature: null,
    });
    const team = createLocalTeam(db, {
      name: "T",
      phases: [{ name: "build", prompt: "" }],
      agents: [{
        id: "worker", name: "W", type: customAgentTypeName(agent.id), model: "default",
        customTools: ["lookup_customer", "team_only"],
      }],
    });
    db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('t2','T',?,'running')").run(team.id);
    seedInstance("rt-3", "worker", "t2", customAgentTypeName(agent.id));

    expect(resolveSessionCustomTools(db, "rt-3").map((t) => t.name).sort()).toEqual(["lookup_customer", "team_only"]);
  });

  it("grants nothing when neither surface enabled anything", () => {
    createCustomTool(db, input());
    seedInstance("rt-4", "coder", "t-none", "claude-code");
    expect(resolveSessionCustomTools(db, "rt-4")).toEqual([]);
  });

  it("drops a granted name whose tool has been deleted", () => {
    const tool = createCustomTool(db, input());
    const team = createLocalTeam(db, {
      name: "T",
      phases: [{ name: "build", prompt: "" }],
      agents: [{ id: "coder", name: "C", type: "claude-code", model: "default", customTools: ["lookup_customer"] }],
    });
    db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('t3','T',?,'running')").run(team.id);
    seedInstance("rt-5", "coder", "t3", "claude-code");
    deleteCustomTool(db, tool.id);

    expect(resolveSessionCustomTools(db, "rt-5")).toEqual([]);
  });

  it("returns nothing for an unknown instance", () => {
    expect(resolveSessionCustomTools(db, "does-not-exist")).toEqual([]);
  });
});

describe("registration on an MCP session", () => {
  function recorder() {
    const names: string[] = [];
    const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {};
    return {
      names,
      handlers,
      server: {
        tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>) => {
          names.push(name);
          handlers[name] = handler;
        },
      },
    };
  }

  it("registers the session's tools and executes them when called", async () => {
    createCustomTool(db, input({ code: "return 'looked up ' + args.id;" }));
    const team = createLocalTeam(db, {
      name: "T",
      phases: [{ name: "build", prompt: "" }],
      agents: [{ id: "coder", name: "C", type: "claude-code", model: "default", customTools: ["lookup_customer"] }],
    });
    db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('t4','T',?,'running')").run(team.id);
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, state_metadata, attempt)
       VALUES ('rt-6','t4','coder',NULL,'rt-6','running','{}',1)`,
    ).run();

    const rec = recorder();
    expect(registerCustomTools(rec.server, { db, runtimeId: "rt-6" })).toEqual(["lookup_customer"]);

    const result = await rec.handlers.lookup_customer!({ id: "C-9" });
    expect(result.content[0]!.text).toContain("looked up C-9");
  });

  // External API-key sessions are not an agent on a task, so there is nothing to
  // resolve a grant from.
  it("registers nothing without a runtime id", () => {
    createCustomTool(db, input());
    const rec = recorder();
    expect(registerCustomTools(rec.server, { db, runtimeId: null })).toEqual([]);
    expect(rec.names).toEqual([]);
  });
});
