import { addRoute } from "../server";
import type { ManagerDaemon } from "../agents/manager-daemon";

export function registerDaemonRoutes(daemon: ManagerDaemon): void {
  addRoute("GET", "/api/daemon/status", () => {
    const status = daemon.getStatus();
    return Response.json(status);
  });

  addRoute("POST", "/api/daemon/pause", () => {
    try {
      daemon.pause();
      return Response.json({ status: "pausing" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/daemon/resume", () => {
    try {
      daemon.resume();
      return Response.json({ status: "running" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
