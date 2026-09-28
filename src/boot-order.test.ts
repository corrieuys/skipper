import { it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boot order (index.ts): the HTTP port is bound before startup() runs, because
// daemon.start() SIGTERMs the recorded daemon owner and SIGKILLs every recorded
// agent pid. A second daemon on the same data dir and port must fail on the
// bind and leave the live daemon's processes and rows alone.
//
// Everything runs in a temp dir: data dir, runtime DB and a copy of config/.
// The "live daemon" and its "agent" are `sleep` processes this test owns, and
// the port is one this test already holds, so nothing here reaches port 5005
// or ~/.skipper.

const REPO = join(import.meta.dir, "..");
const TASK = "boot-order-task";
const INSTANCE = "boot-order-instance";

/** "exited" when the process ends within `ms`, else "alive". */
function stateAfter(proc: { exited: Promise<number> }, ms: number): Promise<"exited" | "alive"> {
  return Promise.race([
    proc.exited.then(() => "exited" as const),
    Bun.sleep(ms).then(() => "alive" as const),
  ]);
}

it("a daemon that cannot bind its port exits before it kills the recorded owner and agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skipper-boot-order-"));
  const dataDir = join(dir, "data");
  const dbPath = join(dataDir, "skipper-runtime.db");
  const configDir = join(dir, "config");
  cpSync(join(REPO, "config"), configDir, { recursive: true });

  const agent = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const owner = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const held = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("held") });
  let daemon: ReturnType<typeof Bun.spawn> | null = null;

  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      SKIPPER_DATA_DIR: dataDir,
      SKIPPER_RUNTIME_DB_PATH: dbPath,
      SKIPPER_CONFIG_DIR: configDir,
      SKIPPER_HOST: "127.0.0.1",
      PORT: String(held.port),
    };
    delete env.SKIPPER_ALLOWED_HOSTS;
    delete env.XDG_DATA_HOME;

    // Seed through the daemon's own split-mode init, in its own process (the
    // DB singleton in this test process is not ours to open or close): a
    // running instance with a live pid, and a live pid recorded as owner.
    const seed = join(dir, "seed.ts");
    writeFileSync(seed, [
      `import { initializeDatabase, getDb, closeDb } from ${JSON.stringify(join(REPO, "src/db/connection.ts"))};`,
      `initializeDatabase();`,
      `const db = getDb();`,
      // Settled, so nothing is ever recovered or respawned from this task.
      `db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, 'boot order', 'settled')").run(${JSON.stringify(TASK)});`,
      `db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status, process_pid) VALUES (?, ?, 'skipper', 'running', ?)").run(${JSON.stringify(INSTANCE)}, ${JSON.stringify(TASK)}, ${agent.pid});`,
      `db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES ('owner_pid', ?)").run(${JSON.stringify(String(owner.pid))});`,
      `closeDb();`,
    ].join("\n"));
    const seeded = Bun.spawnSync([process.execPath, seed], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    expect(seeded.exitCode).toBe(0);

    daemon = Bun.spawn([process.execPath, join(REPO, "index.ts")], {
      cwd: dir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await Promise.race([daemon.exited, Bun.sleep(25_000).then(() => "timeout" as const)]);
    expect(code).not.toBe("timeout");
    expect(code).not.toBe(0);
    const output = (await new Response(daemon.stdout as ReadableStream).text()) + (await new Response(daemon.stderr as ReadableStream).text());
    expect(output).toMatch(/EADDRINUSE|in use/);

    // Neither process was signalled: both are still running.
    expect(await stateAfter(agent, 300)).toBe("alive");
    expect(await stateAfter(owner, 300)).toBe("alive");

    // Nor were their rows touched: the owner stays recorded, the instance live.
    const db = new Database(dbPath);
    try {
      const ownerRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'owner_pid'").get() as { value: string } | null;
      expect(ownerRow?.value).toBe(String(owner.pid));
      const instance = db.prepare("SELECT status, process_pid FROM agent_instances WHERE id = ?").get(INSTANCE) as
        { status: string; process_pid: number | null } | null;
      expect(instance).toEqual({ status: "running", process_pid: agent.pid });
    } finally {
      db.close();
    }
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    agent.kill("SIGKILL");
    owner.kill("SIGKILL");
    held.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
