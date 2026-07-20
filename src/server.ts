import { type Server, type ServerWebSocket } from "bun";
import { join, extname } from "path";
import type { WSData } from "./ws/types";
import { STYLESHEET_PATH, getStylesheet } from "./html/styles/stylesheet";
import { assetFile } from "./assets";
import { getUploadedWallpaperDir } from "./paths";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

type RouteHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

interface Route {
  method: string;
  pathPattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function compilePattern(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

export function addRoute(method: string, path: string, handler: RouteHandler): void {
  const { regex, paramNames } = compilePattern(path);
  const route: Route = {
    method: method.toUpperCase(),
    pathPattern: path,
    regex,
    paramNames,
    handler,
  };
  // Re-registering the same method+pattern replaces the old handler instead of
  // appending a shadowed duplicate — matchRoute returns the first hit, so an
  // append would pin stale closures forever (bites tests that register routes
  // per-file against fresh DBs/daemons).
  const existing = routes.findIndex((r) => r.method === route.method && r.pathPattern === path);
  if (existing >= 0) routes[existing] = route;
  else routes.push(route);
}

function matchRoute(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.regex);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        const name = route.paramNames[i];
        if (name !== undefined) params[name] = match[i + 1] ?? "";
      }
      return { handler: route.handler, params };
    }
  }
  return null;
}

async function serveStaticFile(pathname: string, req: Request): Promise<Response | null> {
  // Map the URL to an embedded asset (public/*). Path is a map key, so `..` can't
  // escape; strip it and the leading slash anyway. Uploaded wallpapers are not
  // embedded — they live in the data dir and are served from there.
  const safePath = pathname.replace(/\.\./g, "").replace(/^\/+/, "");
  if (!safePath) return null;

  let file = assetFile(`public/${safePath}`);
  if (!file && safePath.startsWith("wallpapers/")) {
    const diskPath = join(getUploadedWallpaperDir(), safePath.slice("wallpapers/".length));
    const f = Bun.file(diskPath);
    if (await f.exists()) file = f;
  }
  if (!file || !(await file.exists())) return null;

  const ext = extname(safePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const etag = `"${file.size.toString(16)}-${(file.lastModified || 0).toString(16)}"`;
  // Uploaded wallpapers get unique filenames, so they can be cached forever.
  // Everything else revalidates cheaply via ETag (304, no body re-download).
  const cacheControl = safePath.startsWith("wallpapers/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
  const cacheHeaders = { "Cache-Control": cacheControl, "ETag": etag };

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }

  return new Response(file, {
    headers: { "Content-Type": contentType, ...cacheHeaders },
  });
}

// Content-hashed app stylesheet — immutable, cached forever by the browser.
addRoute("GET", STYLESHEET_PATH, () => {
  return new Response(getStylesheet(), {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

addRoute("GET", "/health", () => {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// High-frequency UI poll endpoints — the browser hits these every few seconds
// (HTMX `hx-trigger="every 5s"`), which drowns the log. Their successful, fast
// responses are skipped; errors and slow responses still log. Set
// `SKIPPER_HTTP_LOG=all` to log every request (debugging).
const QUIET_LOG_PATTERNS: RegExp[] = [
  /^\/api\/settings\/skipper-connect\/status$/,
  /^\/workspace\/scheduled\/[^/]+\/runs$/,
  /^\/workspace\/task\/[^/]+\/phase-strip$/,
  /^\/health$/,
  /^\/ping$/,
];

export function shouldLogRequest(pathname: string, status: number, durationMs: number): boolean {
  if (process.env.SKIPPER_HTTP_LOG === "all") return true;
  if (status >= 400) return true; // always surface errors
  if (durationMs >= 500) return true; // always surface slow responses
  return !QUIET_LOG_PATTERNS.some((re) => re.test(pathname));
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const start = performance.now();

    const matched = matchRoute(method, url.pathname);
    if (matched) {
      const resp = await matched.handler(req, matched.params);
      const durationMs = performance.now() - start;
      if (shouldLogRequest(url.pathname, resp.status, durationMs)) {
        console.log(`[http] ${method} ${url.pathname} → ${resp.status} (${durationMs.toFixed(0)}ms)`);
      }
      return resp;
    }

    if (method === "GET") {
      const staticResponse = await serveStaticFile(url.pathname, req);
      if (staticResponse) return staticResponse;
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  } catch (err) {
    console.error("[server] Unhandled error in request handler:", err);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

type WebSocketUpgradeHandler = (req: Request, server: Server<WSData>) => boolean;
const wsUpgradeHandlers: WebSocketUpgradeHandler[] = [];

export function setWebSocketUpgradeHandlers(handlers: WebSocketUpgradeHandler[]): void {
  wsUpgradeHandlers.length = 0;
  wsUpgradeHandlers.push(...handlers);
}

export interface WSHandlerSet {
  open?: (ws: ServerWebSocket<WSData>) => void;
  message?: (ws: ServerWebSocket<WSData>, message: string | Buffer) => void | Promise<void>;
  close?: (ws: ServerWebSocket<WSData>, code: number, reason: string) => void;
}

const wsHandlerMap: Record<string, WSHandlerSet> = {};

export function setWebSocketHandlers(handlers: Record<string, WSHandlerSet>): void {
  for (const key of Object.keys(wsHandlerMap)) delete wsHandlerMap[key];
  Object.assign(wsHandlerMap, handlers);
}

export function startServer(port: number = Number(process.env.PORT) || 5005): Server<WSData> {
  const server = Bun.serve<WSData>({
    port,
    idleTimeout: 255, // max value — long-lived WS connections
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        for (const handler of wsUpgradeHandlers) {
          if (handler(req, server)) {
            return undefined as unknown as Response;
          }
        }
      }
      return handleRequest(req);
    },
    websocket: {
      open(ws) {
        const handlerSet = wsHandlerMap[ws.data.type];
        handlerSet?.open?.(ws);
      },
      message(ws, message) {
        const handlerSet = wsHandlerMap[ws.data.type];
        handlerSet?.message?.(ws, message);
      },
      close(ws, code, reason) {
        const handlerSet = wsHandlerMap[ws.data.type];
        handlerSet?.close?.(ws, code, reason);
      },
    },
  });

  console.log(`Skipper server running on http://localhost:${server.port}`);
  return server;
}

export { routes };
