import type { Database } from "bun:sqlite";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { registerDataTaskRoutes } from "./tasks";
import { registerDataRealtimeTaskRoutes } from "./realtime-tasks";
import { registerDataTeamRoutes } from "./teams";
import { registerDataAgentRoutes } from "./agents";
import { registerDataDashboardRoutes } from "./dashboard";
import { registerDataEscalationRoutes } from "./escalations";
import { registerDataDaemonRoutes } from "./daemon";

export function registerDataRoutes(db: Database, daemon: ManagerDaemon): void {
  // These two take only the daemon — passing (db, daemon) would put the
  // Database in the daemon slot and break realtime start/resume/stop.
  registerDataTaskRoutes(daemon);
  registerDataRealtimeTaskRoutes(daemon);
  registerDataTeamRoutes(db, daemon);
  registerDataAgentRoutes(db, daemon);
  registerDataDashboardRoutes(db, daemon);
  registerDataEscalationRoutes(db, daemon);
  registerDataDaemonRoutes(db, daemon);
}
