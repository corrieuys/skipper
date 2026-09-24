import { describe, expect, test } from "bun:test";
import { instanceListItems } from "./actions";

const row = (id: string, agent_name: string, extra: Partial<Parameters<typeof instanceListItems>[0][number]> = {}) => ({
  id,
  template_agent_id: agent_name.toLowerCase(),
  agent_name,
  status: "running",
  parent_instance_id: null,
  process_pid: 100,
  can_steer: true,
  disabled_reason: null,
  ...extra,
});

describe("instanceListItems", () => {
  test("numbers parallel instances of one agent in list order and leaves singles unnumbered", () => {
    const items = instanceListItems([row("a1", "Coder"), row("t1", "Tester"), row("a2", "Coder", { parent_instance_id: "root" })]);
    expect(items.map((i) => i.label)).toEqual(["Coder #1", "Tester", "Coder #2"]);
    expect(items[0]!.hint).toContain("root");
    expect(items[2]!.hint).toContain("delegated");
    expect(items[2]!.data).toMatchObject({ id: "a2" });
  });

  test("shows why an instance cannot be steered", () => {
    const items = instanceListItems([
      row("w", "Coder", { status: "waiting_delegation", can_steer: false, disabled_reason: "Runtime is waiting on delegation and cannot be steered." }),
      row("n", "Coder", { can_steer: false, disabled_reason: "Runtime has no resumable session yet." }),
      row("ok", "Coder"),
    ]);
    expect(items[0]!.right).toBe("waiting on delegation");
    expect(items[0]!.glyph).toBe("◌");
    expect(items[0]!.detail).toContain("waiting on delegation");
    expect(items[1]!.right).toBe("running · not steerable");
    expect(items[1]!.detail).toBe("Runtime has no resumable session yet.");
    expect(items[2]!.right).toBe("running");
    expect(items[2]!.detail).toBeUndefined();
  });
});
