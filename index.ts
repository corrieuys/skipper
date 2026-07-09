import { startServer, addRoute, setWebSocketUpgradeHandlers, setWebSocketHandlers } from "./src/server";
import { registerTaskRoutes } from "./src/routes/tasks";
import { registerTeamRoutes } from "./src/routes/teams";
import { registerSkipperRoutes } from "./src/routes/skipper";
import { registerPageRoutes } from "./src/routes/pages";
import { registerDaemonRoutes } from "./src/routes/daemon";
import { registerRealtimeRoutes } from "./src/routes/realtime";
import { registerDataRoutes } from "./src/routes/data/index";
import { registerConversationRoutes } from "./src/routes/conversations";
import { registerScheduledTaskRoutes } from "./src/routes/scheduled-tasks";
import { registerApiKeyRoutes } from "./src/routes/api-keys";
import { ManagerDaemon } from "./src/agents/manager-daemon";
import { initializeDatabase, closeDb, getDb } from "./src/db/connection";
import { tryUpgradeRealtimeWs, realtimeWsHandlers } from "./src/routes/realtime-ws";
import { UIWebSocketManager } from "./src/ws/ui-push";
import { NotificationManager } from "./src/notifications/manager";
import { WhisperManager } from "./src/whisper/manager";
import { DaemonMcpServer } from "./src/mcp/server";
import { MonkeyEngine } from "./src/monkey/tick";
import { getGregDb, closeGregDb } from "./src/monkey/db";
import { GlobalStoreManager } from "./src/global-store/manager";
import { initConnectClient } from "./src/connect/client";
import { getBoolSetting, getStringSetting, SETTING_SKIPPER_CONNECT_ENABLED, SETTING_SKIPPER_CONNECT_KEY } from "./src/config/app-settings";

const experimental = process.argv.includes("--experimental");
if (experimental) {
  console.log("[skipper] --experimental flag set: experimental UI features enabled");
}

initializeDatabase();

const daemon = new ManagerDaemon();
const uiPush = new UIWebSocketManager(getDb(), daemon);
const notificationManager = new NotificationManager(getDb(), uiPush);

// Monkey pet engine
const monkeyEngine = new MonkeyEngine(getDb(), getGregDb());

// MCP server for agent-to-daemon structured communication
const mcpServer = new DaemonMcpServer(getDb(), {
  db: getDb(),
  agentManager: daemon.getAgentManager(),
  delegationManager: daemon.getDelegationManager(),
  phaseManager: daemon.getPhaseManager(),
  taskScheduler: daemon.getTaskScheduler(),
  escalationManager: daemon.getEscalationManager(),
  artifactManager: daemon.getArtifactManager(),
  consensusManager: daemon.getConsensusManager(),
  globalStoreManager: new GlobalStoreManager(getDb()),
});
const whisperManager = new WhisperManager();

registerTaskRoutes(daemon);
// Teams (with inline agents) CRUD + /api/teams/import|export.
registerTeamRoutes();
registerSkipperRoutes();
registerDaemonRoutes(daemon);
registerPageRoutes(daemon);
registerRealtimeRoutes(daemon);
registerDataRoutes(getDb(), daemon);
registerConversationRoutes(daemon.getConversationManager());
registerScheduledTaskRoutes(daemon);
registerApiKeyRoutes();

// MCP protocol routes (Streamable HTTP transport)
const mcpHandler = (req: Request) => mcpServer.handleRequest(req);
addRoute("POST", "/mcp", mcpHandler);
addRoute("GET", "/mcp", mcpHandler);
addRoute("DELETE", "/mcp", mcpHandler);

addRoute("GET", "/ping", () => Response.json({ pong: true }));

// Whisper lifecycle routes (called by realtime-audio.js on record start/stop)
addRoute("GET", "/api/whisper/status", () => {
  return Response.json({ running: whisperManager.isRunning(), endpoint: whisperManager.isRunning() ? whisperManager.getEndpoint() : null });
});
addRoute("POST", "/api/whisper/start", async () => {
  if (whisperManager.isRunning()) {
    return Response.json({ running: true, endpoint: whisperManager.getEndpoint() });
  }
  try {
    await whisperManager.start(getDb());
    return Response.json({ running: true, endpoint: whisperManager.getEndpoint() });
  } catch (err) {
    return Response.json({ running: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
addRoute("POST", "/api/whisper/stop", () => {
  whisperManager.stop(getDb());
  return Response.json({ running: false });
});

// Register WebSocket upgrade handlers (tried in order)
setWebSocketUpgradeHandlers([
  (req, server) => tryUpgradeRealtimeWs(req, server, daemon.getRealtimeSessionManager()),
  (req, server) => monkeyEngine.tryUpgrade(req, server),
  (req, server) => uiPush.tryUpgrade(req, server),
]);
setWebSocketHandlers({
  realtime: realtimeWsHandlers,
  monkey: monkeyEngine.wsHandlers,
  "ui-push": uiPush.wsHandlers,
});

const connectClient = initConnectClient(
  daemon.getTaskScheduler(),
  daemon.getScheduledTaskScheduler(),
  daemon.getEscalationManager(),
  daemon.getArtifactManager(),
  daemon.getPhaseManager(),
);

async function startup() {
  await daemon.start();
  monkeyEngine.start();

  const db = getDb();
  const hasCredentials = !!getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "");
  if (hasCredentials && getBoolSetting(db, SETTING_SKIPPER_CONNECT_ENABLED, false)) {
    connectClient.start();
  }
}

startup().catch((err) => console.error("Startup failed:", err));

const server = startServer();

function shutdown() {
  connectClient.stop();
  monkeyEngine.stop();
  closeGregDb();
  mcpServer.close();
  notificationManager.destroy();
  daemon.stop();
  whisperManager.stop(getDb());
  uiPush.destroy();
  server.stop(true);
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
