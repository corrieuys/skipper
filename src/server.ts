import { type Server } from "bun";
import { resolve, join, extname } from "path";

const STATIC_DIR = resolve(import.meta.dir, "html/public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
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

async function serveStaticFile(pathname: string): Promise<Response | null> {
  const safePath = pathname.replace(/\.\./g, "");
  const filePath = join(STATIC_DIR, safePath);

  if (!filePath.startsWith(STATIC_DIR)) {
    return null;
  }

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(file, {
      headers: { "Content-Type": contentType },
    });
  }
  return null;
}

// Register built-in routes
addRoute("GET", "/health", () => {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // Try matched routes first
  const matched = matchRoute(method, url.pathname);
  if (matched) {
    return matched.handler(req, matched.params);
  }

  // Try static files for GET requests
  if (method === "GET") {
    const staticResponse = await serveStaticFile(url.pathname);
    if (staticResponse) return staticResponse;
  }

  return Response.json({ error: "Not Found" }, { status: 404 });
}

function parseIdleTimeoutSeconds(raw: string | undefined): number {
  if (!raw) return 60;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.floor(parsed);
}

export function startServer(port: number = Number(process.env.PORT) || 3000): Server {
  const idleTimeout = parseIdleTimeoutSeconds(process.env.PLAYHIVE_IDLE_TIMEOUT);
  const server = Bun.serve({
    port,
    idleTimeout,
    fetch: handleRequest,
  });

  console.log(`PlayHive server running on http://localhost:${server.port} (idleTimeout=${idleTimeout}s)`);
  return server;
}

export { routes };
