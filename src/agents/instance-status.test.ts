import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { eventBus, type InstanceStateChangedEvent } from "../events/bus";
import { updateInstanceStatus, finalizeActiveInstancesForTask, emitInstanceState } from "./instance-status";

let db: Database;
let seen: InstanceStateChangedEvent[];
const handler = (e: InstanceStateChangedEvent) => seen.push(e);

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'T', 'active')").run();
  const ins = db.prepare(
    "INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, process_pid) VALUES (?, 't1', ?, ?, ?, ?, 4242)",
  );
  ins.run("root", "skipper", null, "root", "waiting_delegation");
  ins.run("child-a", "coder", "root", "root", "running");
  ins.run("child-b", "coder", "root", "root", "running");
  ins.run("done", "coder", "root", "root", "completed");
  seen = [];
  eventBus.on("instance:state_changed", handler);
});

afterEach(() => {
  eventBus.off("instance:state_changed", handler);
  db.close();
});

describe("instance status writes announce themselves", () => {
  it("updateInstanceStatus writes and emits the row's identity in one step", () => {
    expect(updateInstanceStatus(db, "child-a", "failed", { clearPid: true })).toBe(true);
    expect(seen).toEqual([
      { instanceId: "child-a", templateAgentId: "coder", taskId: "t1", parentInstanceId: "root", rootInstanceId: "root", status: "failed" },
    ]);
    const row = db.prepare("SELECT status, process_pid FROM agent_instances WHERE id = 'child-a'").get() as { status: string; process_pid: number | null };
    expect(row).toEqual({ status: "failed", process_pid: null });
  });

  it("reports false and stays silent for an id with no instance row", () => {
    expect(updateInstanceStatus(db, "skipper", "completed")).toBe(false);
    expect(emitInstanceState(db, "nope")).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("finalizeActiveInstancesForTask announces every instance it closes, and only those", () => {
    finalizeActiveInstancesForTask(db, "t1", "stopped");
    expect(seen.map((e) => e.instanceId).sort()).toEqual(["child-a", "child-b", "root"]);
    expect(seen.every((e) => e.status === "stopped")).toBe(true);
  });
});
