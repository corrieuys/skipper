import { describe, it, expect } from "bun:test";

// Validates the OS mechanism killAgentTree() relies on: agents are spawned
// detached (their own process group, pid===pgid), so signalling the negative
// pgid terminates the agent AND every subprocess it spawned. Without detach,
// the grandchild would orphan and survive.
describe("process-group kill (killAgentTree mechanism)", () => {
  it("kills a detached child's grandchild via the negative pgid", async () => {
    // Child shell spawns a grandchild `sleep`, prints its PID, then waits.
    const proc = Bun.spawn({
      cmd: ["sh", "-c", "sleep 100 & echo $!; wait"],
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
    });

    // Read just the first line of stdout (the child keeps the stream open via
    // `wait`, so we can't await EOF).
    const reader = proc.stdout.getReader();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const grandchildPid = parseInt(buf.trim().split("\n")[0] ?? "", 10);
    expect(Number.isFinite(grandchildPid)).toBe(true);

    // Grandchild is alive (signal 0 = existence check, no throw).
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    // Kill the whole process group (negative pgid). proc.pid is the group leader.
    process.kill(-proc.pid!, "SIGKILL");

    // Give the OS a moment to reap.
    await new Promise((r) => setTimeout(r, 200));

    // Grandchild is gone — signal 0 now throws ESRCH.
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });
});
