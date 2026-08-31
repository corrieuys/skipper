import type { Transport } from "./transport/types";
import type { Renderer, UIState, PaneId } from "./render/types";
import { PANES } from "./render/types";
import { Store } from "./model/store";
import { AnsiRenderer } from "./render/ansi-renderer";
import { LocalTransport } from "./transport/local";
import { ConnectTransport } from "./transport/connect";
import { selectTransport } from "./startup";
import { decodeKey } from "./input/keyboard";
import { TerminalDriver } from "./render/terminal";

const RENDER_COALESCE_MS = 60; // ≤ ~16 fps; smooths output bursts
const ANIM_INTERVAL_MS = 120; // ~8 fps spinner / pulse cadence

export interface DashboardOptions {
  host?: string;
  port?: number;
  /** Skip the transport menu (used by tests / --local). */
  transport?: "local" | "connect";
}

/**
 * Entry point for `skipper dashboard`. Wires transport → store → renderer and
 * an input loop. The three layers only meet here; each is swappable in
 * isolation (new transport, new renderer backend, new key bindings).
 */
export async function runDashboard(opts: DashboardOptions = {}): Promise<void> {
  const host = opts.host ?? process.env.SKIPPER_HOST ?? "127.0.0.1";
  const port = opts.port ?? (Number(process.env.PORT) || 5005);

  if (!(await daemonHealthy(host, port))) {
    process.stderr.write(
      `skipper daemon not reachable on http://${localhostish(host)}:${port}\n` +
        `start it first:  skipper start\n`,
    );
    process.exitCode = 1;
    return;
  }

  const choice = opts.transport ?? (await selectTransport({ connectAvailable: false }));
  const transport: Transport = choice === "connect" ? new ConnectTransport() : new LocalTransport(host, port);

  const store = new Store();
  const driver = new TerminalDriver();
  const renderer: Renderer = new AnsiRenderer(driver);
  const ui: UIState = {
    focused: "output",
    scroll: { output: 0, agents: 0, tasks: 0 },
    transportLabel: transport.label,
    frame: 0,
  };

  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const paint = () => {
    renderTimer = null;
    renderer.render({ data: store.snapshot(), conn: store.connStatus(), ui });
  };
  const scheduleRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(paint, RENDER_COALESCE_MS);
  };

  // Animation heartbeat: advance the frame + repaint on a steady cadence so
  // spinners/cubes/pulse keep moving even when no data event arrives.
  const animTimer = setInterval(() => {
    ui.frame = (ui.frame + 1) % 1_000_000;
    paint();
  }, ANIM_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(animTimer);
    if (renderTimer) clearTimeout(renderTimer);
    void transport.close();
    renderer.unmount();
    process.exitCode = code;
    // Give close() a tick, then exit so the raw-mode stdin listener releases.
    setTimeout(() => process.exit(code), 10);
  };

  renderer.mount();
  renderer.onResize(paint);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  driver.onKey((data) => {
    const key = decodeKey(data);
    if (key.type === "quit") return shutdown(0);
    handleKey(key.type, ui, store, renderer);
    scheduleRender();
    if (key.type === "resync") transport.resync?.();
  });

  try {
    await transport.start((event) => {
      store.apply(event);
      scheduleRender();
    });
  } catch (err) {
    renderer.unmount();
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  paint(); // first frame immediately (before any event arrives)
}

function handleKey(type: string, ui: UIState, store: Store, renderer: Renderer): void {
  const counts = laneCounts(store);
  const viewportH = Math.max(renderer.size().rows - 4, 1); // rough; renderer re-clamps
  // The output pane is bottom-anchored: its scroll is scrollback from newest,
  // so "up" means older (increase), inverted from the top-anchored panes.
  const sign = ui.focused === "output" ? -1 : 1;
  const step = (delta: number) => {
    ui.scroll[ui.focused] = clamp(ui.scroll[ui.focused] + sign * delta, counts[ui.focused]);
  };
  switch (type) {
    case "nextPane":
      ui.focused = cyclePane(ui.focused, 1);
      break;
    case "prevPane":
      ui.focused = cyclePane(ui.focused, -1);
      break;
    case "up":
      step(-1);
      break;
    case "down":
      step(1);
      break;
    case "pageUp":
      step(-viewportH);
      break;
    case "pageDown":
      step(viewportH);
      break;
  }
}

function clamp(offset: number, total: number): number {
  const max = Math.max(total - 1, 0);
  return Math.min(Math.max(offset, 0), max);
}

function laneCounts(store: Store): Record<PaneId, number> {
  const s = store.snapshot();
  return {
    output: s.activity.length,
    agents: s.agents.length,
    tasks: s.tasks.length,
  };
}

function cyclePane(cur: PaneId, dir: 1 | -1): PaneId {
  const i = PANES.indexOf(cur);
  const n = PANES.length;
  return PANES[(i + dir + n) % n] as PaneId;
}

async function daemonHealthy(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${localhostish(host)}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function localhostish(host: string): string {
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}
