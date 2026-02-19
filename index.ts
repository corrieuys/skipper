import { startServer } from "./src/server";
import { registerAgentRoutes } from "./src/routes/agents";
import { registerTaskRoutes } from "./src/routes/tasks";
import { registerTeamRoutes } from "./src/routes/teams";
import { registerPageRoutes } from "./src/routes/pages";

registerAgentRoutes();
registerTaskRoutes();
registerTeamRoutes();
registerPageRoutes();

startServer();
