import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { resetConfigStore } from "../config/store";
import { routes } from "../server";
import { registerTeamRoutes } from "./teams";
import { listLocalTeams } from "../teams/local-teams";

let db: Database;

function findHandler(method: string, pathname: string) {
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const match = pathname.match(route.regex);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = match[i + 1];
      }
      return { handler: route.handler, params };
    }
  }
  return null;
}

async function call(method: string, pathname: string, body?: unknown): Promise<Response> {
  const pathOnly = pathname.split("?")[0];
  const match = findHandler(method, pathOnly);
  if (!match) throw new Error(`no route for ${method} ${pathname}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const req = new Request(`http://localhost${pathname}`, init);
  return await match.handler(req, match.params);
}

/** POST an application/x-www-form-urlencoded body, like the team edit form does. */
async function callForm(method: string, pathname: string, fields: Record<string, string>): Promise<Response> {
  const match = findHandler(method, pathname.split("?")[0]);
  if (!match) throw new Error(`no route for ${method} ${pathname}`);
  const body = new URLSearchParams(fields).toString();
  const req = new Request(`http://localhost${pathname}`, {
    method,
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  return await match.handler(req, match.params);
}

const sampleTeam = (id: string) => ({
  id,
  name: `Team ${id}`,
  goal: "ship",
  skipper_prompt: "lead",
  hooks: [],
  phases: [{ name: "build", prompt: "do it", review: true }],
  agents: [
    { id: "dev", name: "Dev", type: "claude-code", model: "default", instruction: "code", role: "worker", level: 1 },
  ],
});

beforeEach(() => {
  resetConfigStore();
  // routes is a module-level singleton; clear it so each test starts clean.
  routes.length = 0;
  db = new Database(":memory:");
  initializeDatabase(db);
  registerTeamRoutes(db);
});

afterEach(() => {
  db.close();
  routes.length = 0;
  resetConfigStore();
});

describe("local-team routes", () => {
  it("create -> list -> get round-trips a unified team", async () => {
    const createRes = await call("POST", "/api/teams", sampleTeam("alpha"));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBe("alpha");
    expect(created.agents.length).toBe(1);

    const listRes = await call("GET", "/api/teams");
    const list = await listRes.json();
    expect(list.length).toBe(1);

    const getRes = await call("GET", "/api/teams/alpha");
    const got = await getRes.json();
    expect(got.name).toBe("Team alpha");
    expect(got.phases[0].review).toBe(true);
  });

  it("create generates an inline agent id when missing", async () => {
    const team = sampleTeam("beta");
    team.agents = [{ name: "Helper Bot", type: "claude-code", model: "default" } as never];
    const res = await call("POST", "/api/teams", team);
    const created = await res.json();
    expect(created.agents[0].id).toBe("helper-bot");
  });

  it("export then import yields an equivalent team", async () => {
    await call("POST", "/api/teams", sampleTeam("gamma"));

    const exportRes = await call("GET", "/api/teams/export");
    expect(exportRes.headers.get("content-disposition")).toContain("teams-export.json");
    const exported = await exportRes.json();
    expect(exported.teams.length).toBe(1);

    // Wipe and re-import.
    expect(await (await call("DELETE", "/api/teams/gamma")).text()).toBe("");
    expect(listLocalTeams(db).length).toBe(0);

    const importRes = await call("POST", "/api/teams/import", exported);
    const summary = await importRes.json();
    expect(summary.imported).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.errors).toEqual([]);

    const reimported = listLocalTeams(db)[0];
    const original = exported.teams[0];
    expect(reimported.name).toBe(original.name);
    expect(reimported.agents).toEqual(original.agents);
    expect(reimported.phases).toEqual(original.phases);
  });

  it("import upserts an existing team by id (updates, not duplicates)", async () => {
    await call("POST", "/api/teams", sampleTeam("delta"));
    const modified = { ...sampleTeam("delta"), name: "Renamed Delta" };
    const res = await call("POST", "/api/teams/import", { teams: [modified] });
    const summary = await res.json();
    expect(summary.imported).toBe(0);
    expect(summary.updated).toBe(1);
    expect(listLocalTeams(db).length).toBe(1);
    expect(listLocalTeams(db)[0].name).toBe("Renamed Delta");
  });

  it("import reports per-team errors and skips bad teams without aborting", async () => {
    const good = sampleTeam("good");
    const bad = { ...sampleTeam("bad"), agents: [{ id: "x", name: "X", type: "nope-type", model: "default" }] };
    const res = await call("POST", "/api/teams/import", { teams: [good, bad] });
    const summary = await res.json();
    expect(summary.imported).toBe(1);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0].team).toBe("bad");
    expect(summary.errors[0].error).toContain("nope-type");
    expect(listLocalTeams(db).map((t) => t.id)).toEqual(["good"]);
  });

  it("export ?id= returns a single team with a per-team filename", async () => {
    await call("POST", "/api/teams", sampleTeam("solo"));
    const res = await call("GET", "/api/teams/export?id=solo");
    expect(res.headers.get("content-disposition")).toContain("team-solo.json");
    const payload = await res.json();
    expect(payload.teams.length).toBe(1);
    expect(payload.teams[0].id).toBe("solo");
  });

  it("update via PUT refreshes the team", async () => {
    await call("POST", "/api/teams", sampleTeam("eps"));
    const res = await call("PUT", "/api/teams/eps", { ...sampleTeam("eps"), name: "Epsilon v2" });
    expect(res.status).toBe(200);
    expect(listLocalTeams(db)[0].name).toBe("Epsilon v2");
  });

  it("get unknown id returns 404", async () => {
    const res = await call("GET", "/api/teams/missing");
    expect(res.status).toBe(404);
  });

  describe("Slack config preservation on update", () => {
    const slackTeam = (id: string) => ({
      ...sampleTeam(id),
      config: { slackEnabled: true, slashCommand: "/software-team" },
    });

    it("create stores slackEnabled + slashCommand from a nested config", async () => {
      const res = await call("POST", "/api/teams", slackTeam("s1"));
      const created = await res.json();
      expect(created.config.slackEnabled).toBe(true);
      expect(created.config.slashCommand).toBe("/software-team");
    });

    it("JSON update WITHOUT a config block preserves the stored Slack settings", async () => {
      await call("POST", "/api/teams", slackTeam("s2"));
      // A partial update (e.g. renaming) that carries no config / slack fields
      // must not wipe the stored settings — this was the reported bug.
      const res = await call("PUT", "/api/teams/s2", { ...sampleTeam("s2"), name: "Renamed", config: undefined });
      expect(res.status).toBe(200);
      const team = listLocalTeams(db).find(t => t.id === "s2")!;
      expect(team.name).toBe("Renamed");
      expect(team.config.slackEnabled).toBe(true);
      expect(team.config.slashCommand).toBe("/software-team");
    });

    it("form update WITHOUT the Slack section preserves the stored Slack settings", async () => {
      await call("POST", "/api/teams", slackTeam("s3"));
      // Simulates a save from a build where the Slack fields are hidden: no
      // slack_section marker, no slack_enabled/slash_command fields.
      const res = await callForm("POST", "/api/teams/s3/update", {
        name: "Renamed Form",
        phases: JSON.stringify([{ name: "build", prompt: "do it", review: true }]),
        agents: JSON.stringify(slackTeam("s3").agents),
      });
      expect(res.status).toBe(200);
      const team = listLocalTeams(db).find(t => t.id === "s3")!;
      expect(team.name).toBe("Renamed Form");
      expect(team.config.slackEnabled).toBe(true);
      expect(team.config.slashCommand).toBe("/software-team");
    });

    it("JSON update WITH a config block that clears slashCommand ('') unsets it", async () => {
      await call("POST", "/api/teams", slackTeam("s5"));
      // The team-map save posts the whole config; clearing the command sends
      // slashCommand:'' (an explicit signal), which must unset it — not preserve
      // the stored value. This was the reported "unset doesn't stick" bug.
      const res = await call("PUT", "/api/teams/s5", {
        ...sampleTeam("s5"),
        config: { slackEnabled: true, slashCommand: "" },
      });
      expect(res.status).toBe(200);
      const team = listLocalTeams(db).find(t => t.id === "s5")!;
      expect(team.config.slackEnabled).toBe(true);
      expect(team.config.slashCommand).toBeUndefined();
    });

    it("form update WITH the Slack section applies the submitted values", async () => {
      await call("POST", "/api/teams", slackTeam("s4"));
      // Section rendered (marker present), checkbox unchecked, command cleared →
      // the user is explicitly disabling Slack, which must take effect.
      const res = await callForm("POST", "/api/teams/s4/update", {
        name: "Team s4",
        slack_section: "1",
        slash_command: "",
        phases: JSON.stringify([{ name: "build", prompt: "do it", review: true }]),
        agents: JSON.stringify(slackTeam("s4").agents),
      });
      expect(res.status).toBe(200);
      const team = listLocalTeams(db).find(t => t.id === "s4")!;
      expect(team.config.slackEnabled).toBe(false);
      expect(team.config.slashCommand).toBeUndefined();
    });
  });
});
