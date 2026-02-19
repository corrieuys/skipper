import type { Database } from "bun:sqlite";
import { addRoute } from "../../server";
import type { ManagerDaemon } from "../../agents/manager-daemon";

function ok(data: unknown): Response {
  return Response.json({ ok: true, data });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export function registerDataDaemonRoutes(_db: Database, daemon: ManagerDaemon): void {
  // GET /data/daemon/status
  addRoute("GET", "/data/daemon/status", () => {
    return ok(daemon.getStatus());
  });

  // POST /data/daemon/pause
  addRoute("POST", "/data/daemon/pause", async () => {
    try {
      await daemon.pause();
      return ok(daemon.getStatus());
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  // POST /data/daemon/resume
  addRoute("POST", "/data/daemon/resume", () => {
    try {
      daemon.resume();
      return ok(daemon.getStatus());
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });
}
