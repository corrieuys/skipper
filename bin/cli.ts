#!/usr/bin/env bun
/**
 * Skipper CLI — the entry point compiled into the standalone binary
 * (`bun build --compile bin/cli.ts`). Dispatches subcommands:
 *
 *   skipper start [--port N]   spawn the server detached; pid + logs in the data dir
 *   skipper stop               SIGTERM the recorded pid (SIGKILL fallback)
 *   skipper restart
 *   skipper status             pid liveness + /health probe
 *   skipper logs [-f]          print (or follow) the daemon log
 *   skipper update [--beta]    self-update to the latest (or latest prerelease) release
 *   skipper serve | run        run the server in the foreground (what `start` execs)
 *   skipper --version | -v
 *   skipper help
 *
 * `serve` is the actual server: it dynamically imports `../index.ts`, whose
 * top-level boot wires the daemon and calls `startServer()`, and which installs
 * SIGTERM/SIGINT handlers — so `skipper stop` shuts it down cleanly.
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import { isCompiledBinary } from "../src/assets";
import { getPidFile, getLogFile, ensureDataDir } from "../src/paths";

// Injected at build time via `--define`; falls back to "dev" under `bun run`.
declare const __SKIPPER_VERSION__: string;
const VERSION = typeof __SKIPPER_VERSION__ !== "undefined" ? __SKIPPER_VERSION__ : "dev";

const PORT = process.env.PORT || "5005";
const REPO = "corrieuys/skipper"; // GitHub owner/repo for `update`

function readPid(): number | null {
  try {
    const n = Number(readFileSync(getPidFile(), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** True if the process exists (EPERM counts — it exists, we just can't signal it). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function clearPidFile(): void {
  try {
    unlinkSync(getPidFile());
  } catch {
    /* already gone */
  }
}

/** How to re-invoke ourselves in foreground `serve` mode (binary vs `bun run`). */
function serveInvocation(): { cmd: string; args: string[] } {
  if (isCompiledBinary()) return { cmd: process.execPath, args: ["serve"] };
  return { cmd: process.execPath, args: [Bun.main, "serve"] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll /health until the server answers, up to ~timeoutMs. */
async function waitForHealth(url: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** Open a URL in the OS default browser. Best-effort; silent if no opener/display. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // opener missing (e.g. headless server) — ignore
    child.unref();
  } catch {
    /* ignore */
  }
}

async function start(): Promise<void> {
  const existing = readPid();
  if (existing && isAlive(existing)) {
    console.log(`skipper already running (pid ${existing})`);
    return;
  }
  if (existing) clearPidFile(); // stale

  ensureDataDir();
  const logPath = getLogFile();
  const out = openSync(logPath, "a");
  const { cmd, args } = serveInvocation();
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  if (child.pid) writeFileSync(getPidFile(), String(child.pid));
  child.unref();
  const url = `http://localhost:${PORT}`;
  console.log(`skipper started (pid ${child.pid}) on ${url}`);
  console.log(`logs: ${logPath}`);

  // Open the UI once the server is actually responding (skip with --no-open).
  if (!process.argv.includes("--no-open")) {
    if (await waitForHealth(url)) openBrowser(url);
    else console.log(`server not responding yet — open ${url} once it's up (see logs)`);
  }
}

async function stop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log("skipper not running (no pidfile)");
    return;
  }
  if (!isAlive(pid)) {
    console.log(`skipper not running (stale pid ${pid})`);
    clearPidFile();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* raced */
  }
  for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100); // up to 5s
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* raced */
    }
    console.log(`skipper force-killed (pid ${pid})`);
  } else {
    console.log(`skipper stopped (pid ${pid})`);
  }
  clearPidFile();
}

async function status(): Promise<void> {
  const pid = readPid();
  const running = pid !== null && isAlive(pid);
  if (!running) {
    console.log("skipper: stopped");
    return;
  }
  console.log(`skipper: running (pid ${pid})`);
  try {
    const res = await fetch(`http://localhost:${PORT}/health`);
    if (res.ok) {
      const body = (await res.json()) as { status?: string; uptime?: number };
      console.log(`  health: ${body.status ?? "ok"}, uptime ${Math.round(body.uptime ?? 0)}s`);
    } else {
      console.log(`  health: HTTP ${res.status}`);
    }
  } catch {
    console.log(`  health: unreachable on port ${PORT}`);
  }
}

function logs(follow: boolean): void {
  const logPath = getLogFile();
  if (!existsSync(logPath)) {
    console.log(`no log file yet at ${logPath}`);
    return;
  }
  if (follow) {
    const child = spawn("tail", ["-f", "-n", "200", logPath], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const lines = readFileSync(logPath, "utf8").split("\n");
  console.log(lines.slice(-200).join("\n"));
}

function platformAsset(): string | null {
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return os && arch ? `skipper-${os}-${arch}` : null;
}

/**
 * Resolve the release to update to. Stable channel uses /releases/latest, which
 * GitHub guarantees excludes prereleases. Beta channel lists /releases (newest
 * first, prereleases included) and takes the top entry.
 */
async function resolveLatestTag(beta: boolean): Promise<string | null> {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "skipper-cli" };
  if (beta) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers });
    if (!res.ok) {
      console.error(`could not list releases: HTTP ${res.status}`);
      process.exit(1);
    }
    const list = (await res.json()) as Array<{ tag_name?: string }>;
    return list[0]?.tag_name ?? null;
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (!res.ok) {
    console.error(`could not check latest release: HTTP ${res.status}`);
    process.exit(1);
  }
  return ((await res.json()) as { tag_name?: string }).tag_name ?? null;
}

/** Self-update: download the matching binary from the latest GitHub release. */
async function update(): Promise<void> {
  if (!isCompiledBinary()) {
    console.log("update applies to the packaged binary only. In a dev checkout: git pull && bun run build.");
    return;
  }
  const asset = platformAsset();
  if (!asset) {
    console.error(`unsupported platform: ${process.platform}/${process.arch}`);
    process.exit(1);
  }
  const beta = process.argv.includes("--beta") || process.argv.includes("--pre");
  const tag = await resolveLatestTag(beta);
  const latest = String(tag ?? "").replace(/^v/, "");
  if (!latest) {
    console.error(beta ? "no releases found" : "no published release found");
    process.exit(1);
  }
  if (latest === VERSION) {
    console.log(`already up to date (${VERSION})`);
    return;
  }
  console.log(`updating ${VERSION} → ${latest}`);
  const url = `https://github.com/${REPO}/releases/download/v${latest}/${asset}`;
  const dl = await fetch(url);
  if (!dl.ok) {
    console.error(`download failed: HTTP ${dl.status} (${url})`);
    process.exit(1);
  }
  const bytes = new Uint8Array(await dl.arrayBuffer());
  const target = process.execPath;
  const tmp = `${target}.new`;
  try {
    writeFileSync(tmp, bytes);
    chmodSync(tmp, 0o755);
    renameSync(tmp, target); // atomic swap; the running process keeps the old inode
  } catch (e) {
    const msg =
      (e as NodeJS.ErrnoException)?.code === "EACCES"
        ? `no write permission for ${target} — re-run the install script or use sudo.`
        : String(e);
    console.error(`update failed: ${msg}`);
    process.exit(1);
  }
  console.log(`updated to ${latest}. If the server is running: skipper restart`);
}

function usage(): void {
  console.log(`skipper ${VERSION}

Usage:
  skipper start [--port N] [--no-open]   Start in the background (opens the UI)
  skipper stop               Stop the background server
  skipper restart            Restart the background server
  skipper status             Show running state + health
  skipper logs [-f]          Print (or follow with -f) the server log
  skipper serve              Run the server in the foreground
  skipper update [--beta]    Update to the latest release (--beta includes prereleases)
  skipper --version          Print version
`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  // `--port N` sets PORT for start/serve if not already set.
  const portFlag = process.argv.indexOf("--port");
  if (portFlag !== -1 && process.argv[portFlag + 1]) {
    process.env.PORT = process.argv[portFlag + 1];
  }

  switch (cmd) {
    case "serve":
    case "run":
      await import("../index.ts"); // boots the server (foreground)
      break;
    case "start":
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await stop();
      await start();
      break;
    case "status":
      await status();
      break;
    case "logs":
      logs(process.argv.includes("-f") || process.argv.includes("--follow"));
      break;
    case "update":
      await update();
      break;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
