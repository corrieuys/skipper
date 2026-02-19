import { addRoute } from "../server";
import { daemonControlFragment } from "../html/daemonControlFragment";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { parseRequestBody } from "./utils";

function htmlFragment(content: string, status: number = 200): Response {
  return new Response(content, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function registerDaemonRoutes(daemon: ManagerDaemon): void {
  addRoute("GET", "/fragments/daemon/control", () => {
    return htmlFragment(daemonControlFragment(daemon.getStatus(), true));
  });

  addRoute("POST", "/fragments/daemon/pause", async () => {
    try {
      await daemon.pause();
      return htmlFragment(daemonControlFragment(daemon.getStatus(), true));
    } catch {
      return htmlFragment(`<div id="daemon-global-control" class="daemon-card daemon-killswitch daemon-killswitch-nav"><span class="error">Unable to pause daemon</span></div>`, 400);
    }
  });

  addRoute("POST", "/fragments/daemon/resume", () => {
    try {
      daemon.resume();
      return htmlFragment(daemonControlFragment(daemon.getStatus(), true));
    } catch {
      return htmlFragment(`<div id="daemon-global-control" class="daemon-card daemon-killswitch daemon-killswitch-nav"><span class="error">Unable to resume daemon</span></div>`, 400);
    }
  });

  addRoute("GET", "/api/daemon/status", () => {
    const status = daemon.getStatus();
    return Response.json(status);
  });

  addRoute("POST", "/api/daemon/pause", async (req) => {
    try {
      await daemon.pause();
      if (req.headers.get("HX-Request")) {
        return new Response(null, { status: 302, headers: { Location: "/" } });
      }
      return Response.json({ status: "paused" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/daemon/resume", (req) => {
    try {
      daemon.resume();
      if (req.headers.get("HX-Request")) {
        return new Response(null, { status: 302, headers: { Location: "/" } });
      }
      return Response.json({ status: "running" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/dashboard/steer", async (req) => {
    const body = await parseRequestBody<Record<string, string>>(req);
    const templateAgentId = body.template_agent_id?.trim();
    const runtimeId = body.runtime_id?.trim();
    const message = body.message?.trim();
    if (!templateAgentId) {
      return Response.json({ error: "template_agent_id is required" }, { status: 400 });
    }
    if (!runtimeId) {
      return Response.json({ error: "runtime_id is required" }, { status: 400 });
    }
    if (!message) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    try {
      await daemon.steerRuntime(templateAgentId, runtimeId, message);
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const messageText = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: messageText }, { status: 400 });
    }
  });
}
