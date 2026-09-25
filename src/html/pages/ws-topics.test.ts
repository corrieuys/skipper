import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { logsPage } from "./logs.page";
import { teamsPage } from "./teams.page";
import { globalStorePage } from "./global-store.page";
import { taskCreatePage } from "./task-create.page";
import { customAgentsPage } from "./custom-agents.page";
import { configPage } from "./config.page";

// Every page names the /ws/ui topics it renders. A page that names none has an
// empty subscription set, which the push server treats as "send everything"
// (every terminal chunk, every sidebar render), so each page must name one.

const meta = { daemonState: "running", daemonUptime: 0, escalationCount: 0 };

function wsTopics(html: string): string[] | null {
  const match = /<body[^>]*\sdata-ws-topics="([^"]*)"/.exec(html);
  return match ? match[1]!.split(",") : null;
}

// v2layout reads the appearance config through getDb(); pin it to memory.
beforeAll(() => {
  resetDb();
  initializeDatabase(getDb(":memory:"));
});

afterAll(() => {
  resetDb();
});

describe("page websocket topics", () => {
  it("logs page listens on logs (the live #log-entries-body push)", () => {
    expect(wsTopics(logsPage({ ...meta, entries: [], filters: {}, agents: [] }))).toEqual(["logs"]);
    // The filtered view keeps the topic, so Clear (an in-page body swap) goes live again.
    expect(wsTopics(logsPage({ ...meta, entries: [], filters: { stream: "stderr" }, agents: [] }))).toEqual(["logs"]);
  });

  it("teams page listens on teams (the live #tm-remote-repos push)", () => {
    expect(wsTopics(teamsPage({ ...meta, teams: [], remoteRepos: null }))).toEqual(["teams"]);
  });

  it("pages with no live element still name their own topic", () => {
    expect(wsTopics(globalStorePage({ ...meta, rows: [] }))).toEqual(["global-store"]);
    expect(wsTopics(taskCreatePage({ ...meta, teams: [], titleGeneratorConfigured: false }))).toEqual(["task-create"]);
    expect(wsTopics(customAgentsPage({
      ...meta, agents: [], singleAgents: [], mcpServers: [], importableServers: [], customTools: [],
    }))).toEqual(["agent-library"]);
    const configVm = {
      ...meta,
      notificationPreferences: [],
      logRetentionHours: 24,
      taskRetentionDays: 30,
      recurringTaskRetentionDays: 30,
      parallelExecution: true,
      skipperConnectHasKey: false,
      skipperConnectUrl: "",
      apiKeys: [],
      modelSettings: { skipper: {}, greg: {}, dictation: {}, task_title: {}, glyph: {}, options: [] },
      autoUpdate: { enabled: false, currentVersion: "dev", availableVersion: null },
      skipperIdentity: { color: "#6ea8fe", character: "captain" },
      realtime: { cadenceSeconds: 60, summaryEnabled: true, cadenceMin: 5, cadenceMax: 600 },
    } as never;
    expect(wsTopics(configPage(configVm))).toEqual(["config"]);
  });
});
