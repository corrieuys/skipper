import type { Transport } from "./transport/types";
import { LocalTransport } from "./transport/local";
import { selectServer } from "./startup";
import { findServer, localServer, serverLabel, loadServers, saveServers, type ServerConfig } from "./servers";
import { Store } from "./model/store";
import type { TaskItem, Team, RecurringSeries, TaskDetail, Note, Message, TimelineEntry, Artifact } from "./model/types";
import { Renderer } from "./render/renderer";
import { TerminalDriver } from "./render/terminal";
import { KeyDecoder, type KeyEvent } from "./input/keyboard";
import { initialUIState, topModal, formValues, visibleListItems, FILTERS, DETAIL_TABS, type UIState, type Modal, type FormModal, type ListModal, type Pane } from "./ui/state";
import { railRows, selectedIndex } from "./ui/view-model";
import { sortedArtifacts } from "./render/detail";
import { ACTIONS, actionForKey, availableActions, openArtifact, type Ctx, type Assignee } from "./ui/actions";
import { setActionHints } from "./ui/hints";
import { toTask, toNote, toMessage, toTimelineEntry, toArtifact, toEscalation } from "./transport/local";

const RENDER_COALESCE_MS = 40;
const ANIM_INTERVAL_MS = 120;
const TOAST_MS = 4500;
const BUNDLE_STALE_MS = 60_000;

export interface DashboardOptions {
  host?: string;
  port?: number;
  /** Skip the picker: `local`, or a saved remote's name/id. */
  server?: string;
}

/**
 * `skipper dashboard`: the interactive terminal bridge to a running daemon,
 * local or remote (Skipper Connect). Wires transport → store → renderer and
 * owns the key loop, the coalesced repaint, the animation heartbeat, per-task
 * loads and the action registry.
 */
export async function runDashboard(opts: DashboardOptions = {}): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("skipper dashboard needs an interactive terminal\n");
    process.exitCode = 1;
    return;
  }
  const host = opts.host ?? process.env.SKIPPER_HOST ?? "127.0.0.1";
  const port = opts.port ?? (Number(process.env.PORT) || 5005);

  let server: ServerConfig;
  if (opts.server) {
    const found = opts.server === "local" ? localServer(host, port) : findServer(opts.server);
    if (!found) {
      process.stderr.write(`unknown server "${opts.server}". run skipper dashboard without --server to pick or add one.\n`);
      process.exitCode = 1;
      return;
    }
    server = found;
  } else {
    server = await selectServer();
    if (server.kind === "local") server = localServer(host, port);
  }

  if (server.kind === "local" && !(await daemonHealthy(server.baseURL))) {
    process.stderr.write(`skipper daemon not reachable on ${server.baseURL}\nstart it first:  skipper start\n`);
    process.exitCode = 1;
    return;
  }

  const transport: Transport = new LocalTransport(server);
  const controller = new Controller(transport, server);
  await controller.start();
}

class Controller implements Ctx {
  store = new Store();
  readonly ui: UIState;
  private readonly driver = new TerminalDriver();
  private readonly renderer = new Renderer(this.driver);
  private readonly keys = new KeyDecoder();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private toastSeq = 0;
  private tailedTaskId: string | null = null;
  private teamsPromise: Promise<Team[]> | null = null;
  private assignees: Assignee[] = [];
  private assigneesLoadedAt = 0;

  constructor(
    public transport: Transport,
    private server: ServerConfig,
  ) {
    this.ui = initialUIState(serverLabel(server));
    // A remote has no global feed lane; give the detail pane the room instead.
    if (!transport.capabilities().globalFeed) this.ui.feedHidden = true;
    setActionHints((_store, ui) => {
      if (ui.modals.length) return [];
      return availableActions(this)
        .filter((a) => a.hint)
        .slice(0, 9)
        .map((a) => [a.key, a.label.toLowerCase().replace(/ \(.*\)$/, "")] as [string, string]);
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.renderer.mount();
    this.renderer.onResize(() => this.paint());
    process.on("SIGINT", () => this.quit());
    process.on("SIGTERM", () => this.quit());
    this.driver.onKey((data) => {
      for (const k of this.keys.feed(data)) void this.handleKey(k);
      this.scheduleRender();
    });
    this.animTimer = setInterval(() => {
      this.ui.frame = (this.ui.frame + 1) % 1_000_000;
      this.ui.toasts = this.ui.toasts.filter((t) => t.until > Date.now());
      this.paint();
    }, ANIM_INTERVAL_MS);
    try {
      await this.transport.start((event) => this.onTransportEvent(event));
    } catch (err) {
      this.renderer.unmount();
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    this.paint();
  }

  private onTransportEvent(event: Parameters<Parameters<Transport["start"]>[0]>[0]): void {
    const before = this.store.allTasks().length;
    this.store.apply(event);
    if (event.kind === "snapshot") this.afterSnapshot(before === 0);
    if (event.kind === "task_deleted" && this.ui.selectedTaskId === event.taskId) this.selectTask(null);
    if (event.kind === "task" && (event.created || event.started)) this.followNewTask(event.task);
    if (event.kind === "auth_failed") this.toast(event.message, "error");
    this.ensureSelection();
    this.scheduleRender();
  }

  quit(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.animTimer) clearInterval(this.animTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    void this.transport.close();
    this.renderer.unmount();
    setTimeout(() => process.exit(0), 20);
  }

  resync(): void {
    this.transport.resync();
    if (this.ui.selectedTaskId) void this.loadBundle(this.ui.selectedTaskId, true);
    this.ui.recurringLoadedAt = null;
    this.ui.teamsLoadedAt = null;
    this.assigneesLoadedAt = 0;
  }

  currentServer(): ServerConfig {
    return this.server;
  }

  /**
   * Tear down the live connection and attach to another server without
   * leaving the alt screen: fresh store, fresh transport, selection reset.
   */
  async switchServer(next: ServerConfig): Promise<void> {
    const target = next.kind === "local" ? localServer() : next;
    if (target.kind === "local" && !(await daemonHealthy(target.baseURL))) {
      this.toast(`local daemon not reachable on ${target.baseURL}`, "error");
      return;
    }
    void this.transport.close();
    this.tailedTaskId = null;
    this.server = target;
    this.store = new Store();
    this.ui.selectedTaskId = null;
    this.ui.selectedSeriesId = null;
    this.ui.modals = [];
    this.ui.composerActive = false;
    this.ui.composer.clear();
    this.ui.detailScroll = 0;
    this.ui.railScroll = 0;
    this.ui.recurring = [];
    this.ui.recurringLoadedAt = null;
    this.ui.teams = [];
    this.ui.teamsLoadedAt = null;
    this.assignees = [];
    this.assigneesLoadedAt = 0;
    this.ui.transportLabel = serverLabel(target);
    const file = loadServers();
    saveServers({ servers: file.servers, activeId: target.id });
    this.transport = new LocalTransport(target);
    this.ui.feedHidden = !this.transport.capabilities().globalFeed;
    await this.transport.start((event) => this.onTransportEvent(event));
    this.toast(`connected to ${target.name}`, "ok");
    this.scheduleRender();
  }

  httpBase(): string {
    return this.server.baseURL.replace(/\/+$/, "");
  }

  /**
   * A task was just created (or a draft started): jump to it, unless the
   * operator is mid-edit (modal open, composer or search active) — stealing
   * focus while typing would lose input.
   */
  private followNewTask(task: TaskItem): void {
    if (this.ui.modals.length || this.ui.composerActive || this.ui.searchActive) return;
    if (this.ui.selectedTaskId === task.id) return;
    if (task.status === "active" && !["active", "all", "starred"].includes(this.ui.filter)) this.ui.filter = "active";
    else if (task.status === "draft" && !["drafts", "all"].includes(this.ui.filter)) this.ui.filter = "drafts";
    this.selectTask(task.id);
    this.toast(`${task.status === "draft" ? "new draft" : "task started"}: ${task.title || task.id.slice(0, 8)}`, "info");
  }

  /** With nothing selected but rows on the board, select the top row. */
  private ensureSelection(): void {
    if (this.ui.selectedTaskId || this.ui.filter === "recurring" || this.ui.modals.length) return;
    const first = railRows(this.store, this.ui)[0];
    if (first?.kind === "task") this.selectTask(first.task.id);
  }

  private afterSnapshot(first: boolean): void {
    // Keep the selection valid; pick the top row on first hydrate.
    if (this.ui.selectedTaskId && !this.store.task(this.ui.selectedTaskId)) this.ui.selectedTaskId = null;
    if (!this.ui.selectedTaskId && this.ui.filter !== "recurring") {
      const rows = railRows(this.store, this.ui);
      const firstRow = rows[0];
      if (firstRow?.kind === "task") this.selectTask(firstRow.task.id);
    } else if (this.ui.selectedTaskId && !first) {
      void this.loadBundle(this.ui.selectedTaskId, true);
    }
  }

  // ── painting ──────────────────────────────────────────────────────────

  private paint(): void {
    this.renderTimer = null;
    if (this.shuttingDown) return;
    this.renderer.render({ store: this.store, ui: this.ui });
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => this.paint(), RENDER_COALESCE_MS);
  }

  // ── Ctx ───────────────────────────────────────────────────────────────

  selectedTask(): TaskItem | undefined {
    return this.ui.selectedTaskId ? this.store.task(this.ui.selectedTaskId) : undefined;
  }

  selectedSeries(): RecurringSeries | undefined {
    return this.ui.recurring.find((s) => s.id === this.ui.selectedSeriesId);
  }

  toast(text: string, level: "info" | "ok" | "warn" | "error" = "info"): void {
    this.ui.toasts.push({ id: ++this.toastSeq, text, level, until: Date.now() + (level === "error" ? TOAST_MS * 2 : TOAST_MS) });
    if (this.ui.toasts.length > 5) this.ui.toasts.splice(0, this.ui.toasts.length - 5);
    this.scheduleRender();
  }

  push(modal: Modal): void {
    this.ui.modals.push(modal);
    this.scheduleRender();
  }

  pop(): void {
    this.ui.modals.pop();
    this.scheduleRender();
  }

  async exec(fn: () => Promise<string | void>): Promise<void> {
    try {
      const msg = await fn();
      if (msg) this.toast(msg, "ok");
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), "error");
    }
    this.scheduleRender();
  }

  async loadTeams(force = false): Promise<Team[]> {
    const fresh = this.ui.teamsLoadedAt && Date.now() - this.ui.teamsLoadedAt < BUNDLE_STALE_MS;
    if (!force && fresh) return this.ui.teams;
    if (this.teamsPromise && !force) return this.teamsPromise;
    this.teamsPromise = this.transport
      .request<Record<string, unknown>[]>("teams", "list-all")
      .then((rows) => {
        this.ui.teams = rows.map(toTeam);
        this.ui.teamsLoadedAt = Date.now();
        this.scheduleRender();
        return this.ui.teams;
      })
      .finally(() => {
        this.teamsPromise = null;
      });
    return this.teamsPromise;
  }

  async loadAssignees(force = false): Promise<Assignee[]> {
    if (!force && this.assignees.length && Date.now() - this.assigneesLoadedAt < BUNDLE_STALE_MS) return this.assignees;
    // `teams/list` is the assignable set: local teams plus custom (`ca:`) and
    // single (`sa:`) agents projected as solo teams — the same list the web form shows.
    const rows = await this.transport.request<Record<string, unknown>[]>("teams", "list");
    this.assignees = rows.map((r) => {
      const id = String(r.id ?? "");
      return {
        id,
        name: String(r.name ?? id),
        phaseCount: Number(r.phase_count) || 0,
        kind: id.startsWith("ca:") ? "custom-agent" : id.startsWith("sa:") ? "single-agent" : "team",
      };
    });
    this.assigneesLoadedAt = Date.now();
    return this.assignees;
  }

  async loadRecurring(force = false): Promise<RecurringSeries[]> {
    const fresh = this.ui.recurringLoadedAt && Date.now() - this.ui.recurringLoadedAt < 15_000;
    if (!force && fresh) return this.ui.recurring;
    try {
      const rows = await this.transport.request<Record<string, unknown>[]>("recurring", "list");
      this.ui.recurring = rows.map(toSeries);
      this.ui.recurringLoadedAt = Date.now();
      if (!this.ui.selectedSeriesId || !this.ui.recurring.some((s) => s.id === this.ui.selectedSeriesId)) {
        this.ui.selectedSeriesId = this.ui.recurring[0]?.id ?? null;
      }
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), "error");
    }
    this.scheduleRender();
    return this.ui.recurring;
  }

  selectTask(id: string | null): void {
    if (this.ui.selectedTaskId !== id) {
      this.ui.detailScroll = 0;
      this.ui.artifactIndex = 0;
      if (this.ui.composerActive) {
        this.ui.composerActive = false;
        this.ui.composer.clear();
      }
    }
    this.ui.selectedTaskId = id;
    // One live output tail at a time (the daemon caps subscriptions per socket).
    if (this.tailedTaskId && this.tailedTaskId !== id) {
      this.transport.unsubscribeOutputs(this.tailedTaskId);
      this.store.clearOutput(this.tailedTaskId);
      this.tailedTaskId = null;
    }
    if (id) {
      if (this.tailedTaskId !== id) {
        this.transport.subscribeOutputs(id);
        this.tailedTaskId = id;
      }
      void this.loadBundle(id, false);
    }
    this.scheduleRender();
  }

  reloadTask(id: string): void {
    void this.loadBundle(id, true);
  }

  openComposer(): void {
    if (!this.selectedTask()) return;
    this.ui.composerActive = true;
    if (this.ui.focus !== "main") this.ui.focus = "main";
    if (this.ui.singleView !== "main") this.ui.singleView = "main";
    this.scheduleRender();
  }

  // ── loads ─────────────────────────────────────────────────────────────

  private async loadBundle(taskId: string, force: boolean): Promise<void> {
    const b = this.store.bundle(taskId);
    if (b.loading) return;
    if (!force && b.loadedAt && Date.now() - b.loadedAt < BUNDLE_STALE_MS) return;
    this.store.setBundleLoading(taskId, true);
    this.scheduleRender();
    const t = this.transport;
    const [detail, notes, messages, timeline, artifacts, resolved] = await Promise.allSettled([
      t.request<Record<string, unknown> | null>("tasks", "read", { id: taskId }),
      t.request<Record<string, unknown>[]>("notes", "list", { taskId }),
      t.request<Record<string, unknown>[]>("messages", "list", { taskId, limit: 200 }),
      t.request<Record<string, unknown>[]>("timeline", "list", { taskId, limit: 300 }),
      t.request<Record<string, unknown>[]>("artifacts", "list", { taskId }),
      // escalations/list has no task filter; resolved ones are narrowed client-side.
      t.request<Record<string, unknown>[]>("escalations", "list", { status: "resolved" }),
    ]);
    if (detail.status === "rejected") {
      this.store.failBundle(taskId, detail.reason instanceof Error ? detail.reason.message : String(detail.reason));
      this.scheduleRender();
      return;
    }
    const val = <T>(r: PromiseSettledResult<Record<string, unknown>[]>, map: (o: Record<string, unknown>) => T): T[] =>
      r.status === "fulfilled" && Array.isArray(r.value) ? r.value.map(map) : [];
    this.store.hydrateBundle(taskId, {
      detail: detail.value ? toDetail(detail.value) : null,
      notes: val<Note>(notes, toNote),
      messages: val<Message>(messages, toMessage).reverse(), // newest-first on the wire
      timeline: val<TimelineEntry>(timeline, toTimelineEntry),
      artifacts: val<Artifact>(artifacts, toArtifact),
      resolvedEscalations: val(resolved, toEscalation)
        .filter((e) => e.taskId === taskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
    this.scheduleRender();
  }

  // ── keys ──────────────────────────────────────────────────────────────

  private async handleKey(k: KeyEvent): Promise<void> {
    const modal = topModal(this.ui);
    if (modal) return this.handleModalKey(k, modal);
    if (this.ui.composerActive) return this.handleComposerKey(k);
    if (this.ui.searchActive) return this.handleSearchKey(k);

    // Global navigation first.
    if (k.type === "key") {
      switch (k.name) {
        case "tab":
          this.cycleFocus(1);
          return;
        case "backtab":
          this.cycleFocus(-1);
          return;
        case "up":
          return this.move(-1);
        case "down":
          return this.move(1);
        case "pageup":
          return this.move(-this.pageSize());
        case "pagedown":
          return this.move(this.pageSize());
        case "home":
          return this.move(-1_000_000);
        case "end":
          return this.move(1_000_000);
        case "enter":
          if (this.ui.focus === "rail" || this.ui.singleView === "rail") {
            this.ui.focus = "main";
            this.ui.singleView = "main";
          } else if (this.ui.focus === "main") {
            if (this.ui.detailTab === "artifacts") {
              const t = this.selectedTask();
              const arts = t ? sortedArtifacts(this.store, t.id) : [];
              const a = arts[Math.min(Math.max(this.ui.artifactIndex, 0), Math.max(arts.length - 1, 0))];
              if (a) await openArtifact(this, a);
              return;
            }
            this.openComposer();
          }
          return;
        case "escape":
          if (this.ui.search.length) {
            this.ui.search.clear();
            return;
          }
          this.ui.detailScroll = 0;
          this.ui.feedScroll = 0;
          return;
        case "left":
          return this.cycleTab(-1);
        case "right":
          return this.cycleTab(1);
        default:
          return;
      }
    }
    if (k.type === "char" && !k.alt) {
      switch (k.ch) {
        case "j":
          return this.move(1);
        case "k":
          return this.move(-1);
        case "g":
          return this.move(-1_000_000);
        case "G":
          return this.move(1_000_000);
        case "/":
          this.ui.searchActive = true;
          return;
        case "[":
          return this.cycleTab(-1);
        case "]":
          return this.cycleTab(1);
        case "h":
          return this.cycleFocus(-1);
        case "l":
          return this.cycleFocus(1);
        case "r":
          if (this.ui.filter === "recurring") {
            await this.loadRecurring(true);
            this.toast("recurring list refreshed", "info");
            return;
          }
          break;
      }
      const flt = FILTERS.find((f) => f.key === k.ch);
      if (flt) return this.setFilter(flt.id);
    }
    if (k.type === "ctrl" && k.ch === "l") {
      this.renderer.mount();
      return;
    }
    const action = actionForKey(this, k);
    if (action) await action.run(this);
  }

  private pageSize(): number {
    const f = this.renderer.lastFrame;
    if (!f) return 10;
    const pane = this.activePane();
    const n = pane === "rail" ? f.railRows : pane === "feed" ? f.feedRows : f.detailBodyRows;
    return Math.max(Math.floor(n * 0.8), 1);
  }

  private activePane(): Pane {
    const f = this.renderer.lastFrame;
    if (f?.layout.mode === "single") return this.ui.singleView;
    return this.ui.focus;
  }

  private cycleFocus(dir: 1 | -1): void {
    const f = this.renderer.lastFrame;
    const panes: Pane[] = f?.layout.mode === "single" ? ["rail", "main", "feed"] : f?.layout.feed ? ["rail", "main", "feed"] : ["rail", "main"];
    const cur = this.activePane();
    const i = panes.indexOf(cur);
    const next = panes[(i + dir + panes.length) % panes.length]!;
    this.ui.focus = next;
    this.ui.singleView = next;
  }

  private cycleTab(dir: 1 | -1): void {
    if (this.activePane() !== "main") return;
    const i = DETAIL_TABS.findIndex((t) => t.id === this.ui.detailTab);
    this.ui.detailTab = DETAIL_TABS[(i + dir + DETAIL_TABS.length) % DETAIL_TABS.length]!.id;
    this.ui.detailScroll = 0;
    this.ui.artifactIndex = 0;
  }

  private setFilter(filter: UIState["filter"]): void {
    this.ui.filter = filter;
    this.ui.railScroll = 0;
    this.ui.focus = "rail";
    this.ui.singleView = "rail";
    if (filter === "recurring") {
      void this.loadRecurring(false);
      return;
    }
    const rows = railRows(this.store, this.ui);
    if (selectedIndex(rows, this.ui) < 0) {
      const first = rows[0];
      this.selectTask(first?.kind === "task" ? first.task.id : null);
    }
  }

  private move(delta: number): void {
    const pane = this.activePane();
    if (pane === "main") {
      if (this.ui.detailTab === "artifacts") {
        const t = this.selectedTask();
        const n = t ? sortedArtifacts(this.store, t.id).length : 0;
        this.ui.artifactIndex = Math.min(Math.max(this.ui.artifactIndex + delta, 0), Math.max(n - 1, 0));
        return;
      }
      // Bottom-anchored bodies: up = older (scrollback grows). Info/notes are top-anchored.
      const topAnchored = this.ui.detailTab === "info" || this.ui.detailTab === "notes";
      const sign = topAnchored ? 1 : -1;
      this.ui.detailScroll = Math.max(0, this.ui.detailScroll + sign * delta);
      return;
    }
    if (pane === "feed") {
      this.ui.feedScroll = Math.max(0, this.ui.feedScroll - delta);
      return;
    }
    const rows = railRows(this.store, this.ui);
    if (rows.length === 0) return;
    const cur = selectedIndex(rows, this.ui);
    const next = Math.min(Math.max(cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta, 0), rows.length - 1);
    const row = rows[next]!;
    if (row.kind === "task") this.selectTask(row.task.id);
    else this.ui.selectedSeriesId = row.series.id;
  }

  // ── composer ──────────────────────────────────────────────────────────

  private async handleComposerKey(k: KeyEvent): Promise<void> {
    if (k.type === "key" && k.name === "escape") {
      this.ui.composerActive = false;
      this.ui.composer.clear();
      return;
    }
    if (k.type === "key" && k.name === "enter" && !k.alt && !k.shift) {
      const text = this.ui.composer.value.trim();
      const t = this.selectedTask();
      if (!text || !t) return;
      this.ui.composer.clear();
      this.ui.composerActive = false;
      await this.exec(async () => {
        const r = (await this.transport.request("tasks", "input", { id: t.id, text })) as { delivered?: string };
        const how = r.delivered ?? "sent";
        return t.status === "draft" ? "appended to the draft" : t.status === "settled" ? "revived with your input" : `input ${how}`;
      });
      void this.loadBundle(t.id, true);
      return;
    }
    this.ui.composer.handle(k);
  }

  private handleSearchKey(k: KeyEvent): void {
    if (k.type === "key" && (k.name === "enter" || k.name === "tab")) {
      this.ui.searchActive = false;
      return;
    }
    if (k.type === "key" && k.name === "escape") {
      this.ui.search.clear();
      this.ui.searchActive = false;
      return;
    }
    if (k.type === "key" && (k.name === "up" || k.name === "down")) {
      this.move(k.name === "up" ? -1 : 1);
      return;
    }
    this.ui.search.handle(k);
    // Keep the selection on a visible row while filtering.
    const rows = railRows(this.store, this.ui);
    if (rows.length && selectedIndex(rows, this.ui) < 0) {
      const first = rows[0]!;
      if (first.kind === "task") this.selectTask(first.task.id);
      else this.ui.selectedSeriesId = first.series.id;
    }
  }

  // ── modals ────────────────────────────────────────────────────────────

  private async handleModalKey(k: KeyEvent, m: Modal): Promise<void> {
    if (k.type === "key" && k.name === "escape") {
      if (m.kind === "list" && m.filterable && m.filter.length) {
        m.filter.clear();
        m.index = 0;
        return;
      }
      if (!("busy" in m) || !m.busy) this.pop();
      return;
    }
    switch (m.kind) {
      case "form":
        return this.handleFormKey(k, m);
      case "confirm":
        if (m.busy) return;
        if (k.type === "key" && k.name === "enter") {
          m.busy = true;
          m.error = null;
          this.scheduleRender();
          try {
            const msg = await m.onConfirm();
            this.pop();
            if (msg) this.toast(msg, "ok");
          } catch (err) {
            m.busy = false;
            m.error = err instanceof Error ? err.message : String(err);
          }
        }
        return;
      case "list":
        return this.handleListKey(k, m);
      case "text":
        if (m.onKey && (await m.onKey(k, m))) return;
        if (k.type === "key" && k.name === "up") m.scroll = Math.max(0, m.scroll - 1);
        else if (k.type === "key" && k.name === "down") m.scroll += 1;
        else if (k.type === "key" && k.name === "pageup") m.scroll = Math.max(0, m.scroll - 10);
        else if (k.type === "key" && k.name === "pagedown") m.scroll += 10;
        else if (k.type === "char" && k.ch === "k") m.scroll = Math.max(0, m.scroll - 1);
        else if (k.type === "char" && k.ch === "j") m.scroll += 1;
        else if (k.type === "char" && (k.ch === "q" || k.ch === "?")) this.pop();
        return;
    }
  }

  private async handleFormKey(k: KeyEvent, m: FormModal): Promise<void> {
    if (m.busy) return;
    if (m.onKey?.(k, m)) return;
    const field = m.fields[m.active];
    const isEditable = (i: number) => m.fields[i]?.kind !== "static";
    const step = (dir: 1 | -1) => {
      let i = m.active;
      for (let n = 0; n < m.fields.length; n++) {
        i = (i + dir + m.fields.length) % m.fields.length;
        if (isEditable(i)) break;
      }
      m.active = i;
    };
    // Submit: ctrl+s anywhere; enter on a non-textarea field.
    const submit = async () => {
      for (const f of m.fields) {
        if ((f.kind === "text" || f.kind === "textarea") && f.required && !f.buf.value.trim()) {
          m.error = `${f.label} is required`;
          m.active = m.fields.indexOf(f);
          return;
        }
      }
      m.busy = true;
      m.error = null;
      this.scheduleRender();
      try {
        const msg = await m.onSubmit(formValues(m));
        // The submit may have replaced the top modal (e.g. opened a follow-up); only pop ourselves.
        const idx = this.ui.modals.indexOf(m);
        if (idx >= 0) this.ui.modals.splice(idx, 1);
        if (msg) this.toast(msg, "ok");
      } catch (err) {
        m.busy = false;
        m.error = err instanceof Error ? err.message : String(err);
      }
      this.scheduleRender();
    };
    if (k.type === "ctrl" && k.ch === "s") return submit();
    if (k.type === "key" && k.name === "tab") return step(1);
    if (k.type === "key" && k.name === "backtab") return step(-1);
    if (!field) return;
    switch (field.kind) {
      case "text":
        if (k.type === "key" && k.name === "enter") return submit();
        if (k.type === "key" && (k.name === "up" || k.name === "down")) return step(k.name === "up" ? -1 : 1);
        field.buf.handle(k);
        return;
      case "textarea":
        if (k.type === "key" && k.name === "enter" && !k.alt && !k.shift) {
          // Enter in a textarea = newline (ctrl+s / ctrl+enter submits). Single-row areas submit.
          if (field.rows <= 1) return submit();
          field.buf.insert("\n");
          return;
        }
        field.buf.handle(k);
        return;
      case "select": {
        const n = field.options.length;
        if (n === 0) return;
        if (k.type === "key" && k.name === "enter") return submit();
        if ((k.type === "key" && (k.name === "right" || k.name === "down")) || (k.type === "char" && (k.ch === " " || k.ch === "l" || k.ch === "j"))) field.index = (field.index + 1) % n;
        else if ((k.type === "key" && (k.name === "left" || k.name === "up")) || (k.type === "char" && (k.ch === "h" || k.ch === "k"))) field.index = (field.index - 1 + n) % n;
        else if (k.type === "char") {
          // Jump by first letter (ignoring a leading glyph such as "⬢ ").
          const starts = (label: string) => label.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase().startsWith(k.ch.toLowerCase());
          const i = field.options.findIndex((o, idx) => idx > field.index && starts(o.label));
          const j = i >= 0 ? i : field.options.findIndex((o) => starts(o.label));
          if (j >= 0) field.index = j;
        }
        return;
      }
      case "toggle":
        if (k.type === "key" && k.name === "enter") return submit();
        if ((k.type === "char" && (k.ch === " " || k.ch === "x")) || (k.type === "key" && (k.name === "left" || k.name === "right"))) field.value = !field.value;
        else if (k.type === "key" && (k.name === "up" || k.name === "down")) step(k.name === "up" ? -1 : 1);
        return;
      case "static":
        step(1);
        return;
    }
  }

  private async handleListKey(k: KeyEvent, m: ListModal): Promise<void> {
    if (m.busy) return;
    const items = visibleListItems(m);
    const cur = items[Math.min(m.index, Math.max(items.length - 1, 0))] ?? null;
    const filterFocused = m.filterable && m.filterFocused !== false;
    const moveBy = (d: number) => {
      m.index = Math.min(Math.max(Math.min(m.index, items.length - 1) + d, 0), Math.max(items.length - 1, 0));
    };
    const pick = async () => {
      if (!cur || cur.disabled) return;
      m.busy = true;
      this.scheduleRender();
      try {
        const msg = await m.onPick(cur);
        if (msg) this.toast(msg, "ok");
      } catch (err) {
        m.error = err instanceof Error ? err.message : String(err);
      } finally {
        m.busy = false;
      }
    };
    if (k.type === "key") {
      switch (k.name) {
        case "up":
          if (filterFocused && m.index === 0) return;
          moveBy(-1);
          return;
        case "down":
          if (filterFocused) {
            m.filterFocused = false;
            return;
          }
          moveBy(1);
          return;
        case "pageup":
          moveBy(-8);
          return;
        case "pagedown":
          moveBy(8);
          return;
        case "tab":
          if (m.filterable) m.filterFocused = !filterFocused;
          return;
        case "enter":
          // Enter on the filter line with one match picks it; otherwise hands focus to the list.
          if (filterFocused && items.length !== 1) {
            m.filterFocused = false;
            return;
          }
          await pick();
          return;
        default:
          break;
      }
    }
    if (filterFocused) {
      if (m.filter.handle(k)) m.index = 0;
      return;
    }
    // List focus: `/` back to the filter, j/k move, per-list keys, q closes.
    if (k.type === "char" && k.ch === "/" && m.filterable) {
      m.filterFocused = true;
      return;
    }
    if (k.type === "char" && k.ch === "j") return moveBy(1);
    if (k.type === "char" && k.ch === "k") return moveBy(-1);
    if (k.type === "char" && k.ch === "g") {
      m.index = 0;
      return;
    }
    if (k.type === "char" && k.ch === "G") {
      m.index = Math.max(items.length - 1, 0);
      return;
    }
    if (m.onKey) {
      m.busy = true;
      try {
        if (await m.onKey(k, cur, m)) return;
      } catch (err) {
        m.error = err instanceof Error ? err.message : String(err);
        return;
      } finally {
        m.busy = false;
      }
    }
    if (k.type === "char" && k.ch === "q") this.pop();
  }
}

// ── wire → domain for the controller's own loads ───────────────────────────

function toDetail(o: Record<string, unknown>): TaskDetail {
  const base = toTask(o);
  const phases = Array.isArray(o.phases)
    ? (o.phases as Record<string, unknown>[]).map((p) => ({ name: String(p.name ?? ""), prompt: String(p.prompt ?? ""), review: p.review === true }))
    : null;
  const tiles = Array.isArray(o.agent_tiles)
    ? (o.agent_tiles as Record<string, unknown>[]).map((t) => ({
        template_agent_id: String(t.template_agent_id ?? ""),
        agent_name: String(t.agent_name ?? ""),
        color: t.color == null ? null : String(t.color),
        character: t.character == null ? null : String(t.character),
        instance_count: Number(t.instance_count) || 0,
        is_active: t.is_active === true,
      }))
    : [];
  return {
    ...base,
    description: o.description == null ? null : String(o.description),
    result: o.result ?? null,
    working_directory: o.working_directory == null ? null : String(o.working_directory),
    run_input: o.run_input == null ? null : String(o.run_input),
    completed_at: o.completed_at == null ? null : String(o.completed_at),
    settled_at: o.settled_at == null ? null : String(o.settled_at),
    regression_count: Number(o.regression_count) || 0,
    phases,
    agent_tiles: tiles,
  };
}

function toTeam(o: Record<string, unknown>): Team {
  const agents = Array.isArray(o.agents) ? (o.agents as Record<string, unknown>[]) : [];
  const phases = Array.isArray(o.phases) ? (o.phases as Record<string, unknown>[]) : [];
  return {
    id: String(o.id ?? ""),
    name: String(o.name ?? ""),
    mode: String(o.mode ?? "workflow"),
    phaseCount: Number(o.phaseCount) || phases.length,
    agentCount: Number(o.agentCount) || agents.length,
    phases: phases.map((p) => ({ name: String(p.name ?? ""), prompt: String(p.prompt ?? ""), review: p.review === true })),
    agents: agents.map((a) => ({
      id: String(a.id ?? ""),
      name: String(a.name ?? ""),
      type: String(a.type ?? ""),
      model: String(a.model ?? ""),
      instruction: String(a.instruction ?? ""),
      role: a.role == null ? null : String(a.role),
    })),
    slackEnabled: o.slackEnabled === true,
    slashCommand: String(o.slashCommand ?? ""),
  };
}

function toSeries(o: Record<string, unknown>): RecurringSeries {
  const runs = Array.isArray(o.runs) ? (o.runs as Record<string, unknown>[]) : [];
  return {
    id: String(o.id ?? ""),
    title: String(o.title ?? ""),
    description: o.description == null ? null : String(o.description),
    teamId: o.teamId == null ? null : String(o.teamId),
    teamName: o.teamName == null ? null : String(o.teamName),
    scheduleUnit: o.scheduleUnit == null ? null : String(o.scheduleUnit),
    scheduleAmount: o.scheduleAmount == null ? null : Number(o.scheduleAmount),
    status: String(o.status ?? ""),
    starred: o.starred === true,
    nextRunAt: o.nextRunAt == null ? null : String(o.nextRunAt),
    lastRunAt: o.lastRunAt == null ? null : String(o.lastRunAt),
    memoryMode: String(o.memoryMode ?? "off"),
    runs: runs.map((r) => ({
      id: String(r.id ?? ""),
      title: String(r.title ?? ""),
      status: String(r.status ?? ""),
      createdAt: String(r.createdAt ?? ""),
      completedAt: r.completedAt == null ? null : String(r.completedAt),
    })),
  };
}

async function daemonHealthy(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export { ACTIONS };
