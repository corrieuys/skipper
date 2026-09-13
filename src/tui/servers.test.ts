import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServers, saveServers, allServers, findServer, socketURL, dashboardURL, httpBase, authHeaders, serverLabel, localServer, serversPath, type ServerConfig } from "./servers";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-servers-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const remote: ServerConfig = { id: "r1", name: "acme", kind: "remote", baseURL: "https://connect.acme.io", integratorKey: "sk-abc" };

describe("server store", () => {
  it("round-trips remotes and the active id, never storing the local entry", () => {
    const dir = tmp();
    expect(loadServers(dir)).toEqual({ servers: [], activeId: null });
    saveServers({ servers: [localServer(), remote], activeId: "r1" }, dir);
    const back = loadServers(dir);
    expect(back.servers).toEqual([remote]);
    expect(back.activeId).toBe("r1");
    expect(statSync(serversPath(dir)).mode & 0o777).toBe(0o600);
    expect(allServers(dir).map((s) => s.kind)).toEqual(["local", "remote"]);
    expect(findServer("ACME", dir)?.id).toBe("r1");
    expect(findServer("local", dir)?.kind).toBe("local");
    expect(findServer("nope", dir)).toBeNull();
  });

  it("survives a corrupt file", () => {
    const dir = tmp();
    Bun.write(serversPath(dir), "{not json");
    expect(loadServers(dir)).toEqual({ servers: [], activeId: null });
  });
});

describe("URL builders", () => {
  it("builds the loopback sockets for the local daemon", () => {
    const l = localServer("0.0.0.0", 5077);
    expect(socketURL(l)).toBe("ws://127.0.0.1:5077/connect/local");
    expect(dashboardURL(l)).toBe("ws://127.0.0.1:5077/ws/ui?format=json&topics=dashboard");
    expect(httpBase(l)).toBe("http://127.0.0.1:5077");
    expect(authHeaders(l)).toEqual({});
    expect(serverLabel(l)).toBe("local");
  });

  it("builds the integrator consumer socket with the key as token + bearer", () => {
    expect(socketURL(remote)).toBe("wss://connect.acme.io/connect?token=sk-abc");
    expect(socketURL({ ...remote, baseURL: "http://localhost:8787/" })).toBe("ws://localhost:8787/connect?token=sk-abc");
    expect(dashboardURL(remote)).toBeNull();
    expect(httpBase(remote)).toBeNull();
    expect(authHeaders(remote)).toEqual({ Authorization: "Bearer sk-abc" });
    expect(serverLabel(remote)).toBe("acme ⇅");
  });
});
