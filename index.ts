import { startServer, addRoute, setWebSocketUpgradeHandlers, setWebSocketHandlers } from "./src/server";
import { registerTaskRoutes, killRunningRuntimesForTask } from "./src/routes/tasks";
import { registerTeamRoutes } from "./src/routes/teams";
import { registerSkipperRoutes } from "./src/routes/skipper";
import { registerPageRoutes } from "./src/routes/pages";
import { registerDaemonRoutes } from "./src/routes/daemon";
import { registerRealtimeRoutes } from "./src/routes/realtime";
import { registerDataRoutes } from "./src/routes/data/index";
import { registerScheduledTaskRoutes } from "./src/routes/scheduled-tasks";
import { registerApiKeyRoutes } from "./src/routes/api-keys";
import { registerDictationRoutes } from "./src/routes/dictation";
import { registerCustomAgentRoutes } from "./src/routes/custom-agents";
import { registerSingleAgentRoutes } from "./src/routes/single-agents";
import { registerCustomToolRoutes } from "./src/routes/custom-tools";
import { registerCustomAgentTypes } from "./src/custom-agents/store";
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
import { createConnectLocalEndpoint } from "./src/connect/local-endpoint";
import { initSlackSocket, getSlackSocket } from "./src/slack/socket";
import { initSlackPush, getSlackPush } from "./src/slack/push";
import { isSocketModeConfigured, isSlackSocketEnabled, isSlackConfigured } from "./src/config/slack-settings";
import { getBoolSetting, getStringSetting, SETTING_SKIPPER_CONNECT_ENABLED, SETTING_SKIPPER_CONNECT_KEY } from "./src/config/app-settings";
import { recordBootVersion } from "./src/config/auto-update-settings";
import { initUpdateRestartOnIdle } from "./src/updater/restart-scheduler";

const experimental = process.argv.includes("--experimental");
if (experimental) {
  console.log("[skipper] --experimental flag set: experimental UI features enabled");
}

initializeDatabase();

// Custom agents are stored in the runtime DB but have to be visible as agent
// types before anything resolves a team's providers. The rows are written into
// the in-memory config DB only, so nothing here reaches config/agent_types.json.
registerCustomAgentTypes(getDb());

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
  globalStoreManager: new GlobalStoreManager(getDb()),
  realtimeSessionManager: daemon.getRealtimeSessionManager(),
  inputTask: (taskId, text, source) => daemon.inputTask(taskId, text, source),
});
const whisperManager = new WhisperManager();

// Drive the shared transcriber from the recording lock: whisper starts when the
// first client acquires and stops when the last releases (ref-counted), so a
// remote connect/iOS client starts it too and one stop can't kill another's.
daemon.getRealtimeSessionManager().setWhisperControls({
  acquire: (ownerKey, db) => whisperManager.acquire(ownerKey, db),
  release: (ownerKey, db) => whisperManager.release(ownerKey, db),
});

registerTaskRoutes(daemon);
// Teams (with inline agents) CRUD + /api/teams/import|export.
registerTeamRoutes();
registerSkipperRoutes();
registerDaemonRoutes(daemon);
registerPageRoutes(daemon);
registerRealtimeRoutes(daemon);
registerDataRoutes(getDb(), daemon);
registerScheduledTaskRoutes(daemon);
registerApiKeyRoutes();
// Dictation (experimental): transcribe + LLM cleanup for task-description fields.
registerDictationRoutes();
// Custom agents (experimental): CRUD for in-process agent definitions.
registerCustomAgentRoutes();
// Single agents (experimental): CRUD for standalone agents that run a task alone.
registerSingleAgentRoutes();
// Custom tools (experimental): operator-defined tools executed by the daemon.
registerCustomToolRoutes();

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


const connectClient = initConnectClient(
  daemon.getTaskScheduler(),
  daemon.getScheduledTaskScheduler(),
  daemon.getEscalationManager(),
  daemon.getArtifactManager(),
  daemon.getPhaseManager(),
  daemon.getRealtimeSessionManager(),
  (taskId, text, source) => daemon.inputTask(taskId, text, source),
  (taskId) => killRunningRuntimesForTask(taskId, daemon),
);

// Local consumer WebSocket for apps on this machine (Mac app). Unauthenticated
// and loopback-only; shares the ConnectClient's ResourceDeps so the wiring
// exists once.
const connectLocal = createConnectLocalEndpoint(connectClient.getResourceDeps());
addRoute("GET", "/connect/local", () => connectLocal.routeHandler());

// Register WebSocket upgrade handlers (tried in order)
setWebSocketUpgradeHandlers([
  (req, server) => tryUpgradeRealtimeWs(req, server, daemon.getRealtimeSessionManager()),
  (req, server) => monkeyEngine.tryUpgrade(req, server),
  (req, server) => uiPush.tryUpgrade(req, server),
  (req, server) => connectLocal.tryUpgrade(req, server),
]);
setWebSocketHandlers({
  realtime: realtimeWsHandlers,
  monkey: monkeyEngine.wsHandlers,
  "ui-push": uiPush.wsHandlers,
  "connect-local": connectLocal.wsHandlers,
});

// Slack Socket Mode (experimental): inbound slash commands + interactive
// button/modal handling → Skipper actions.
const slackSocket = initSlackSocket(
  daemon.getTaskScheduler(),
  daemon.getScheduledTaskScheduler(),
  daemon.getEscalationManager(),
  daemon.getPhaseManager(),
  (taskId, text, source) => daemon.inputTask(taskId, text, source),
);

// Slack push (experimental): post escalations + phase reviews to the channel.
const slackPush = initSlackPush(getDb());

// Unsubscribe handle for the event-driven auto-restart (set in startup).
let stopUpdateRestart: (() => void) | null = null;

async function startup() {
  await daemon.start();
  monkeyEngine.start();

  const db = getDb();
  // Reconcile the recorded version vs the running one: queues the "app updated"
  // toast after a self-update, and records this boot's version.
  recordBootVersion(db);
  // Apply a downloaded patch promptly once all tasks finish (event-driven restart).
  stopUpdateRestart = initUpdateRestartOnIdle(db, daemon.getAgentManager());
  const hasCredentials = !!getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "");
  if (hasCredentials && getBoolSetting(db, SETTING_SKIPPER_CONNECT_ENABLED, false)) {
    connectClient.start();
  }
  if (experimental && isSocketModeConfigured(db) && isSlackSocketEnabled(db)) {
    slackSocket.start();
  }
  // Push is OUTBOUND (bot token over HTTPS) and independent of Socket Mode
  // (inbound). Subscribe only when a bot token is configured — otherwise there is
  // nothing to post with, so the subscription (and its push.subscribed log) is
  // just noise. Actual posting is still re-checked live per event (per-team
  // slackEnabled), and /api/config/slack starts/stops this without a restart.
  if (experimental && isSlackConfigured(db)) {
    slackPush.start();
  }
}

startup().catch((err) => console.error("Startup failed:", err));

const server = startServer();

function shutdown() {
  stopUpdateRestart?.();
  connectClient.stop();
  getSlackSocket()?.stop();
  getSlackPush()?.stop();
  monkeyEngine.stop();
  closeGregDb();
  mcpServer.close();
  notificationManager.destroy();
  daemon.stop();
  whisperManager.stop(getDb());
  uiPush.destroy();
  connectLocal.destroy();
  server.stop(true);
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
