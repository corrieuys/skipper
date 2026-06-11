import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { GlobalStoreManager } from "./manager";

let db: Database;
let store: GlobalStoreManager;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  store = new GlobalStoreManager(db);
});

afterEach(() => {
  db.close();
});

describe("GlobalStoreManager", () => {
  it("set then get roundtrips", () => {
    const row = store.set({ name: "checklist", type: "list", data: "[]", status: "open" });
    expect(row.name).toBe("checklist");
    expect(row.type).toBe("list");
    expect(row.data).toBe("[]");
    expect(row.status).toBe("open");
    expect(store.get("checklist")).toEqual(row);
  });

  it("get returns null for missing name", () => {
    expect(store.get("nope")).toBeNull();
  });

  it("set upserts by name (one row, fields updated)", () => {
    store.set({ name: "k", type: "t1", data: "d1", status: "open" });
    store.set({ name: "k", status: "done" });
    const rows = store.query({});
    expect(rows.length).toBe(1);
    const row = store.get("k")!;
    expect(row.status).toBe("done");
    // partial update preserves untouched columns
    expect(row.type).toBe("t1");
    expect(row.data).toBe("d1");
  });

  it("records provenance", () => {
    const row = store.set({ name: "k", data: "x", updatedByAgentId: "agent-1", taskId: "task-1" });
    expect(row.updated_by_agent_id).toBe("agent-1");
    expect(row.task_id).toBe("task-1");
  });

  it("query filters by each field", () => {
    store.set({ name: "a", type: "checklist", status: "open", data: "alpha" });
    store.set({ name: "b", type: "log", status: "done", data: "beta" });
    store.set({ name: "c", type: "checklist", status: "done", data: "gamma" });

    expect(store.query({ name: "b" }).map((r) => r.name)).toEqual(["b"]);
    expect(store.query({ type: "checklist" }).map((r) => r.name).sort()).toEqual(["a", "c"]);
    expect(store.query({ status: "done" }).map((r) => r.name).sort()).toEqual(["b", "c"]);
    expect(store.query({ data_contains: "amm" }).map((r) => r.name)).toEqual(["c"]);
  });

  it("query with no filters returns all", () => {
    store.set({ name: "a" });
    store.set({ name: "b" });
    expect(store.query({}).length).toBe(2);
  });

  it("query respects limit", () => {
    store.set({ name: "a" });
    store.set({ name: "b" });
    store.set({ name: "c" });
    expect(store.query({ limit: 2 }).length).toBe(2);
  });

  it("delete returns true then false", () => {
    store.set({ name: "k" });
    expect(store.delete("k")).toBe(true);
    expect(store.delete("k")).toBe(false);
    expect(store.get("k")).toBeNull();
  });
});
