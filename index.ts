import { startServer } from "./src/server";
import { registerAgentRoutes } from "./src/routes/agents";
import { registerTaskRoutes } from "./src/routes/tasks";
import { registerTeamRoutes } from "./src/routes/teams";
import { registerSkipperRoutes } from "./src/routes/skipper";
import { registerPageRoutes } from "./src/routes/pages";
import { registerDaemonRoutes } from "./src/routes/daemon";
import { ManagerDaemon } from "./src/agents/manager-daemon";
import { initializeDatabase, closeDb } from "./src/db/connection";

initializeDatabase();

const daemon = new ManagerDaemon();

registerAgentRoutes();
registerTaskRoutes();
registerTeamRoutes();
registerSkipperRoutes();
registerDaemonRoutes(daemon);
registerPageRoutes(daemon);

daemon.start().catch((err) => console.error("Daemon startup failed:", err));

const server = startServer();

function shutdown() {
  daemon.stop();
  server.stop(true);
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
