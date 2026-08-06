import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServerBySlug,
  listMcpServers,
  normalizeServerInput,
  qualifyToolName,
  saveToolCatalogue,
  slugifyServerName,
  splitQualifiedToolName,
  updateMcpServer,
  MAX_SLUG_LENGTH,
  type McpServerInput,
} from "./servers";
import { connectServerTools } from "./server-tools";

let db: Database;

function input(overrides: Partial<McpServerInput> = {}): McpServerInput {
  return {
    slug: "",
    name: "Filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: {},
    url: "",
    headers: {},
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
});

afterEach(() => db.close());

describe("tool namespacing", () => {
  // Two servers may both offer `search`; the slug prefix is what keeps them
  // apart in a single tool map.
  it("round-trips a qualified name", () => {
    const qualified = qualifyToolName("github", "search");
    expect(qualified).toBe("github__search");
    expect(splitQualifiedToolName(qualified)).toEqual({ slug: "github", tool: "search" });
  });

  it("splits on the FIRST separator so a tool name may contain one", () => {
    expect(splitQualifiedToolName("srv__do__thing")).toEqual({ slug: "srv", tool: "do__thing" });
  });

  it("rejects a name that is not qualified", () => {
    expect(splitQualifiedToolName("search")).toBeNull();
    expect(splitQualifiedToolName("__search")).toBeNull();
    expect(splitQualifiedToolName("srv__")).toBeNull();
  });

  // Providers cap function names at 64 chars and allow [A-Za-z0-9_-] only.
  it("slugifies to something a model may call", () => {
    expect(slugifyServerName("My Server!")).toBe("my_server");
    expect(slugifyServerName("  --weird-- ")).toBe("weird");
    expect(slugifyServerName("x".repeat(80))).toHaveLength(MAX_SLUG_LENGTH);
    expect(slugifyServerName("!!!")).toBe("");
  });
});

describe("validation", () => {
  it("requires a command for stdio and a URL for http", () => {
    expect(() => normalizeServerInput(input({ command: "" }))).toThrow(/Command is required/);
    expect(() => normalizeServerInput(input({ transport: "http", url: "" }))).toThrow(/URL is required/);
  });

  it("rejects a URL that is not http(s)", () => {
    expect(() => normalizeServerInput(input({ transport: "http", url: "ftp://x" }))).toThrow(/http or https/);
    expect(() => normalizeServerInput(input({ transport: "http", url: "nope" }))).toThrow(/not valid/);
  });

  // Leaving both sets populated would make the stored row ambiguous about how to
  // connect, so the unused transport's fields are cleared.
  it("clears the fields belonging to the other transport", () => {
    const http = normalizeServerInput(input({ transport: "http", url: "https://x/mcp" }));
    expect(http.command).toBe("");
    expect(http.args).toEqual([]);

    const stdio = normalizeServerInput(input({ url: "https://x/mcp" }));
    expect(stdio.url).toBe("");
  });

  it("derives the slug from the name when none is given", () => {
    expect(normalizeServerInput(input({ name: "GitHub API" })).slug).toBe("github_api");
  });

  it("rejects a name with nothing sluggable in it", () => {
    expect(() => normalizeServerInput(input({ name: "!!!" }))).toThrow(/at least one letter or digit/);
  });
});

describe("CRUD", () => {
  it("creates and lists a server", () => {
    const server = createMcpServer(db, input());
    expect(server.slug).toBe("filesystem");
    expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(listMcpServers(db)).toHaveLength(1);
  });

  // The slug prefixes tools, so a duplicate would make two servers' tools
  // indistinguishable — and silently reroute one agent's calls to the other.
  it("refuses a duplicate slug", () => {
    createMcpServer(db, input());
    expect(() => createMcpServer(db, input({ name: "FileSystem!" }))).toThrow(/already uses the name/);
  });

  it("lets a server keep its own slug on update", () => {
    const server = createMcpServer(db, input());
    expect(updateMcpServer(db, server.id, input({ name: "Filesystem", command: "node" })).command).toBe("node");
  });

  it("keeps a stored env value when the update submits a blank one", () => {
    const server = createMcpServer(db, input({ env: { TOKEN: "secret" } }));
    expect(updateMcpServer(db, server.id, input({ env: { TOKEN: "" } })).env).toEqual({ TOKEN: "secret" });
  });

  it("deletes", () => {
    const server = createMcpServer(db, input());
    expect(deleteMcpServer(db, server.id)).toBe(true);
    expect(getMcpServerBySlug(db, "filesystem")).toBeNull();
  });
});

describe("tool catalogue cache", () => {
  it("stores tools and clears the error on success", () => {
    const server = createMcpServer(db, input());
    saveToolCatalogue(db, server.id, [{ name: "read", description: "Read a file" }], null);
    const reloaded = getMcpServerBySlug(db, "filesystem")!;
    expect(reloaded.toolCatalogue).toEqual([{ name: "read", description: "Read a file" }]);
    expect(reloaded.catalogueError).toBeNull();
    expect(reloaded.catalogueRefreshedAt).toBeTruthy();
  });

  // A transient failure must not strip an agent's tool checkboxes off the form.
  it("keeps the previous tools alongside an error", () => {
    const server = createMcpServer(db, input());
    saveToolCatalogue(db, server.id, [{ name: "read", description: "" }], null);
    const stored = getMcpServerBySlug(db, "filesystem")!;
    saveToolCatalogue(db, server.id, stored.toolCatalogue, "connection refused");

    const reloaded = getMcpServerBySlug(db, "filesystem")!;
    expect(reloaded.toolCatalogue).toHaveLength(1);
    expect(reloaded.catalogueError).toBe("connection refused");
  });
});

describe("connectServerTools", () => {
  it("contacts nothing when no server tools are enabled", async () => {
    createMcpServer(db, input());
    const bridge = await connectServerTools(listMcpServers(db), []);
    expect(bridge.tools).toEqual({});
    expect(bridge.missing).toEqual([]);
    await bridge.close();
  });

  // An agent configured against a server that was later deleted must still run,
  // and must say what it lost.
  it("reports enabled tools whose server no longer exists", async () => {
    const bridge = await connectServerTools([], ["gone__search", "gone__fetch"]);
    expect(bridge.tools).toEqual({});
    expect(bridge.missing.sort()).toEqual(["gone__fetch", "gone__search"]);
    await bridge.close();
  });

  it("reports enabled tools when the server cannot be reached", async () => {
    createMcpServer(db, input({
      name: "Dead",
      transport: "http",
      command: "",
      args: [],
      url: "http://127.0.0.1:59999/mcp",
    }));
    const bridge = await connectServerTools(listMcpServers(db), ["dead__search"]);
    expect(bridge.tools).toEqual({});
    expect(bridge.missing).toEqual(["dead__search"]);
    await bridge.close();
  }, 30_000);

  it("ignores malformed enabled names rather than throwing", async () => {
    const bridge = await connectServerTools([], ["not-qualified"]);
    expect(bridge.missing).toEqual([]);
    await bridge.close();
  });
});
