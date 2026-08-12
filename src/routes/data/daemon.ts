import type { Database } from "bun:sqlite";
import { addDataRoute } from "./auth";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { ok, err } from "./envelope";

export function registerDataDaemonRoutes(_db: Database, daemon: ManagerDaemon): void {
  // GET /data/daemon/status
  addDataRoute("GET", "/data/daemon/status", () => {
    return ok(daemon.getStatus());
  });

  // POST /data/daemon/pause
  addDataRoute("POST", "/data/daemon/pause", async () => {
    try {
      await daemon.pause();
      return ok(daemon.getStatus());
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  // POST /data/daemon/resume
  addDataRoute("POST", "/data/daemon/resume", () => {
    try {
      daemon.resume();
      return ok(daemon.getStatus());
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });
}
