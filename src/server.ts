import { type Server, type ServerWebSocket } from "bun";
import { resolve, join, extname } from "path";
import type { WSData } from "./ws/types";
import { STYLESHEET_PATH, getStylesheet } from "./html/styles/stylesheet";

const STATIC_DIR = resolve(import.meta.dir, "html/public");

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
  routes.push({
    method: method.toUpperCase(),
    pathPattern: path,
    regex,
    paramNames,
    handler,
  });
}

function matchRoute(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.regex);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = match[i + 1];
      }
      return { handler: route.handler, params };
    }
  }
  return null;
}

async function serveStaticFile(pathname: string, req: Request): Promise<Response | null> {
  const safePath = pathname.replace(/\.\./g, "");
  const filePath = join(STATIC_DIR, safePath);

  if (!filePath.startsWith(STATIC_DIR)) {
    return null;
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const lastModified = new Date(file.lastModified).toUTCString();
  const etag = `"${file.size.toString(16)}-${file.lastModified.toString(16)}"`;
  // Uploaded wallpapers get unique filenames, so they can be cached forever.
  // Everything else revalidates cheaply via ETag (304, no body re-download).
  const cacheControl = safePath.startsWith("/wallpapers/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
  const cacheHeaders = { "Cache-Control": cacheControl, "ETag": etag, "Last-Modified": lastModified };

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

// Register built-in routes
addRoute("GET", "/health", () => {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const start = performance.now();

    // Try matched routes first
    const matched = matchRoute(method, url.pathname);
    if (matched) {
      const resp = await matched.handler(req, matched.params);
      console.log(`[http] ${method} ${url.pathname} → ${resp.status} (${(performance.now() - start).toFixed(0)}ms)`);
      return resp;
    }

    // Try static files for GET requests
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

type WebSocketUpgradeHandler = (req: Request, server: Server) => boolean;
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

export function startServer(port: number = Number(process.env.PORT) || 3000): Server {
  const server = Bun.serve<WSData>({
    port,
    idleTimeout: 255, // max value — long-lived WS connections
    fetch(req, server) {
      // Try WebSocket upgrade first
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
