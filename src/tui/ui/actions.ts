import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "../model/store";
import type { Transport } from "../transport/types";
import type { TaskItem, Team, RecurringSeries, Artifact } from "../model/types";
import { TextBuffer } from "../input/text-editor";
import type { KeyEvent } from "../input/keyboard";
import { C } from "../render/theme";
import { type UIState, type Modal, type FormModal, type ListItem, type ListModal, type FormValues, formValues, visibleListItems } from "./state";
import { scheduleLabel, shortId } from "./view-model";
import { toOneLine, toPlainText } from "./plain-text";
import { allServers, loadServers, saveServers, type ServerConfig } from "../servers";
import { sortedArtifacts, humanBytes } from "../render/detail";

/**
 * The controller surface actions need. `run.ts` implements it; actions never
 * touch the terminal or the renderer directly.
 */
export interface Ctx {
  store: Store;
  ui: UIState;
  transport: Transport;
  selectedTask(): TaskItem | undefined;
  selectedSeries(): RecurringSeries | undefined;
  toast(text: string, level?: "info" | "ok" | "warn" | "error"): void;
  push(modal: Modal): void;
  pop(): void;
  /** Run an async mutation; errors become error toasts, a returned string an ok toast. */
  exec(fn: () => Promise<string | void>): Promise<void>;
  loadTeams(force?: boolean): Promise<Team[]>;
  /** Everything a task can be assigned to: teams plus custom/single agents projected as solo teams. */
  loadAssignees(force?: boolean): Promise<Assignee[]>;
  loadRecurring(force?: boolean): Promise<RecurringSeries[]>;
  selectTask(id: string | null): void;
  /** Re-read a task's detail bundle (after a write whose event may not reach this client). */
  reloadTask(id: string): void;
  openComposer(): void;
  quit(): void;
  resync(): void;
  httpBase(): string;
  currentServer(): ServerConfig;
  switchServer(server: ServerConfig): Promise<void>;
}

export interface Assignee {
  id: string;
  name: string;
  phaseCount: number;
  kind: "team" | "custom-agent" | "single-agent";
}

export interface Action {
  id: string;
  label: string;
  /** Display chord for hints / palette. */
  key: string;
  /** Physical key(s) that trigger it outside modals/editors. */
  keys: KeyMatch[];
  group: "task" | "review" | "view" | "create" | "teams" | "recurring" | "app";
  /** Show in the footer when available (most task actions do). */
  hint?: boolean;
  when: (ctx: Ctx) => boolean;
  run: (ctx: Ctx) => void | Promise<void>;
}

export type KeyMatch = { ch: string } | { ctrl: string } | { name: string; shift?: boolean };

export function keyMatches(k: KeyEvent, m: KeyMatch): boolean {
  if ("ch" in m) return k.type === "char" && !k.alt && k.ch === m.ch;
  if ("ctrl" in m) return k.type === "ctrl" && k.ch === m.ctrl;
  return k.type === "key" && k.name === m.name && !!k.shift === !!m.shift;
}

const isTask = (ctx: Ctx) => !!ctx.selectedTask() && ctx.ui.filter !== "recurring";
const isActive = (ctx: Ctx) => isTask(ctx) && ctx.selectedTask()!.status === "active";
const isDraft = (ctx: Ctx) => isTask(ctx) && ctx.selectedTask()!.status === "draft";
const isSettled = (ctx: Ctx) => isTask(ctx) && ctx.selectedTask()!.status === "settled";

function req(ctx: Ctx, taskId: string, action: string, params: Record<string, unknown> = {}) {
  return ctx.transport.request(`tasks`, action, { id: taskId, ...params });
}

export const ACTIONS: Action[] = [
  // ── create ──
  {
    id: "new-task",
    label: "New task",
    key: "n",
    keys: [{ ch: "n" }],
    group: "create",
    hint: true,
    when: () => true,
    run: (ctx) => openTaskForm(ctx, null),
  },
  {
    id: "new-recurring",
    label: "New recurring task",
    key: "ctrl+n",
    keys: [{ ctrl: "n" }],
    group: "create",
    when: () => true,
    run: (ctx) => openRecurringForm(ctx),
  },
  {
    id: "import-team",
    label: "Import team from JSON",
    key: "I",
    keys: [{ ch: "I" }],
    group: "teams",
    when: () => true,
    run: (ctx) => openImportTeam(ctx),
  },
  {
    id: "teams",
    label: "Browse teams",
    key: "T",
    keys: [{ ch: "T" }],
    group: "teams",
    when: () => true,
    run: (ctx) => openTeams(ctx),
  },
  // ── task lifecycle ──
  {
    id: "input",
    label: "Send input / message",
    key: "i",
    keys: [{ ch: "i" }],
    group: "task",
    hint: true,
    when: isTask,
    run: (ctx) => ctx.openComposer(),
  },
  {
    id: "edit",
    label: "Edit task",
    key: "e",
    keys: [{ ch: "e" }],
    group: "task",
    hint: true,
    when: isTask,
    run: (ctx) => openTaskForm(ctx, ctx.selectedTask()!),
  },
  {
    id: "approve",
    label: "Approve (start)",
    key: "a",
    keys: [{ ch: "a" }],
    group: "task",
    hint: true,
    when: isDraft,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      return ctx.exec(async () => {
        await req(ctx, t.id, "approve");
        return `approved: ${t.title}`;
      });
    },
  },
  {
    id: "unapprove",
    label: "Back to draft",
    key: "u",
    keys: [{ ch: "u" }],
    group: "task",
    hint: true,
    when: (ctx) => isActive(ctx) && ctx.selectedTask()!.display_status === "queued" && !ctx.selectedTask()!.started_at,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      return ctx.exec(async () => {
        await req(ctx, t.id, "unapprove");
        return `back to draft: ${t.title}`;
      });
    },
  },
  {
    id: "pause",
    label: "Pause",
    key: "p",
    keys: [{ ch: "p" }],
    group: "task",
    hint: true,
    when: (ctx) => isActive(ctx) && !ctx.selectedTask()!.paused,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      return ctx.exec(async () => {
        await req(ctx, t.id, "pause");
        return `paused: ${t.title}`;
      });
    },
  },
  {
    id: "resume",
    label: "Resume",
    key: "p",
    keys: [{ ch: "p" }],
    group: "task",
    hint: true,
    when: (ctx) => isActive(ctx) && ctx.selectedTask()!.paused,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      return ctx.exec(async () => {
        await req(ctx, t.id, "resume-from-pause");
        return `resumed: ${t.title}`;
      });
    },
  },
  {
    id: "star",
    label: "Toggle star",
    key: "s",
    keys: [{ ch: "s" }],
    group: "task",
    hint: true,
    when: isTask,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      return ctx.exec(async () => {
        const r = (await req(ctx, t.id, "star")) as { starred?: boolean };
        return r.starred ? `★ starred: ${t.title}` : `unstarred: ${t.title}`;
      });
    },
  },
  {
    id: "autopilot",
    label: "Toggle autopilot",
    key: "A",
    keys: [{ ch: "A" }],
    group: "task",
    hint: true,
    when: (ctx) => isTask(ctx) && !isSettled(ctx),
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      const on = t.mode !== "workflow";
      return ctx.exec(async () => {
        await req(ctx, t.id, "set-autopilot", { on });
        return on ? `⚡ autopilot on: ${t.title}` : `☾ manual: ${t.title}`;
      });
    },
  },
  {
    id: "memory",
    label: "Toggle memory",
    key: "m",
    keys: [{ ch: "m" }],
    group: "task",
    when: (ctx) => isTask(ctx) && !ctx.selectedTask()!.source_scheduled_task_id,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      const on = !t.memory_enabled;
      return ctx.exec(async () => {
        const r = (await req(ctx, t.id, "set-memory", { on })) as { backfilled?: number };
        return on ? `◈ memory on (${r.backfilled ?? 0} backfilled)` : "memory off";
      });
    },
  },
  {
    id: "icon",
    label: "Set icon + colour",
    key: "c",
    keys: [{ ch: "c" }],
    group: "task",
    when: isTask,
    run: (ctx) => openIconForm(ctx, ctx.selectedTask()!),
  },
  {
    id: "note",
    label: "Add note",
    key: "+",
    keys: [{ ch: "+" }],
    group: "task",
    when: isTask,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      const buf = new TextBuffer("", true);
      ctx.push(form(ctx, {
        title: `Add note · ${shortId(t.id)}`,
        subtitle: "Notes are shared context for every agent on the task.",
        fields: [{ kind: "textarea", key: "content", label: "Note", buf, rows: 6, required: true }],
        submitLabel: "Add note",
        onSubmit: async (v) => {
          await ctx.transport.request("notes", "create", { taskId: t.id, content: String(v.content) });
          return "note added";
        },
      }));
    },
  },
  {
    id: "settle",
    label: "Mark completed (settle)",
    key: "S",
    keys: [{ ch: "S" }],
    group: "task",
    when: isActive,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      ctx.push({
        kind: "confirm",
        title: "Settle task",
        body: `Finish "${t.title}" now? Live agents are stopped and the task presents as Completed. You can revive it later with input.`,
        confirmLabel: "Settle",
        danger: false,
        busy: false,
        error: null,
        onConfirm: async () => {
          await req(ctx, t.id, "settle");
          return `settled: ${t.title}`;
        },
      });
    },
  },
  {
    id: "cancel",
    label: "Cancel (fail)",
    key: "x",
    keys: [{ ch: "x" }],
    group: "task",
    hint: true,
    when: isActive,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      ctx.push({
        kind: "confirm",
        title: "Cancel task",
        body: `Cancel "${t.title}"? Agents are killed and the task presents as Failed.`,
        confirmLabel: "Cancel task",
        danger: true,
        busy: false,
        error: null,
        onConfirm: async () => {
          await req(ctx, t.id, "cancel");
          return `cancelled: ${t.title}`;
        },
      });
    },
  },
  {
    id: "revive",
    label: "Revive",
    key: "v",
    keys: [{ ch: "v" }],
    group: "task",
    hint: true,
    when: isSettled,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      return ctx.exec(async () => {
        await req(ctx, t.id, "revive");
        return `revived: ${t.title}`;
      });
    },
  },
  {
    id: "delete",
    label: "Delete task",
    key: "D",
    keys: [{ ch: "D" }],
    group: "task",
    when: isTask,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      ctx.push({
        kind: "confirm",
        title: "Delete task",
        body: `Permanently delete "${t.title}" and everything recorded under it (notes, artifacts, output)? A task with live agents must be cancelled first.`,
        confirmLabel: "Delete",
        danger: true,
        busy: false,
        error: null,
        onConfirm: async () => {
          await req(ctx, t.id, "delete");
          ctx.selectTask(null);
          return `deleted: ${t.title}`;
        },
      });
    },
  },
  {
    id: "open-web",
    label: "Open in web UI",
    key: "w",
    keys: [{ ch: "w" }],
    group: "task",
    when: (ctx) => isTask(ctx) && !ctx.transport.capabilities().remote,
    run: (ctx) => {
      const t = ctx.selectedTask()!;
      openBrowser(`${ctx.httpBase()}/workspace/task/${t.id}`);
      ctx.toast("opened in browser", "info");
    },
  },
  {
    id: "open-artifact",
    label: "Open selected artifact",
    key: "enter",
    keys: [],
    group: "task",
    when: (ctx) => isTask(ctx) && ctx.ui.detailTab === "artifacts" && sortedArtifacts(ctx.store, ctx.selectedTask()!.id).length > 0,
    run: (ctx) => {
      const arts = sortedArtifacts(ctx.store, ctx.selectedTask()!.id);
      const a = arts[Math.min(Math.max(ctx.ui.artifactIndex, 0), arts.length - 1)];
      if (a) return openArtifact(ctx, a);
    },
  },
  // ── review + escalation ──
  {
    id: "review-approve",
    label: "Approve review → next phase",
    key: "y",
    keys: [{ ch: "y" }],
    group: "review",
    hint: true,
    when: (ctx) => isTask(ctx) && ctx.selectedTask()!.needs_review,
    run: (ctx) => openReviewForm(ctx, ctx.selectedTask()!, "approve"),
  },
  {
    id: "review-reject",
    label: "Reject review → regress",
    key: "N",
    keys: [{ ch: "N" }],
    group: "review",
    hint: true,
    when: (ctx) => isTask(ctx) && ctx.selectedTask()!.needs_review,
    run: (ctx) => openReviewForm(ctx, ctx.selectedTask()!, "reject"),
  },
  {
    id: "escalation",
    label: "Respond to escalation",
    key: "E",
    keys: [{ ch: "E" }],
    group: "review",
    hint: true,
    when: (ctx) => isTask(ctx) && ctx.store.escalationsFor(ctx.selectedTask()!.id).length > 0,
    run: (ctx) => openEscalationForm(ctx, ctx.selectedTask()!),
  },
  {
    id: "escalations-all",
    label: "All open escalations",
    key: "ctrl+e",
    keys: [{ ctrl: "e" }],
    group: "review",
    when: (ctx) => ctx.store.openEscalations().length > 0,
    run: (ctx) => openEscalationList(ctx),
  },
  // ── recurring ──
  {
    id: "run-recurring",
    label: "Run recurring task now",
    key: "R",
    keys: [{ ch: "R" }],
    group: "recurring",
    hint: true,
    when: (ctx) => ctx.ui.filter === "recurring" && !!ctx.selectedSeries(),
    run: (ctx) => {
      const sr = ctx.selectedSeries()!;
      const buf = new TextBuffer("", true);
      ctx.push(form(ctx, {
        title: `Run now · ${sr.title}`,
        subtitle: `${sr.teamName ?? "no team"} · ${scheduleLabel(sr)}. Optional one-off input for this run.`,
        fields: [{ kind: "textarea", key: "input", label: "Run input", buf, rows: 4, placeholder: "(none)" }],
        submitLabel: "Run now",
        onSubmit: async (v) => {
          await ctx.transport.request("tasks", "run-recurring", { id: sr.id, input: String(v.input) });
          await ctx.loadRecurring(true);
          return `run started: ${sr.title}`;
        },
      }));
    },
  },
  {
    id: "edit-recurring",
    label: "Edit recurring task",
    key: "e",
    keys: [{ ch: "e" }],
    group: "recurring",
    hint: true,
    when: (ctx) => ctx.ui.filter === "recurring" && !!ctx.selectedSeries(),
    run: (ctx) => openRecurringForm(ctx, ctx.selectedSeries()!),
  },
  {
    id: "approve-recurring",
    label: "Approve recurring task (schedule runs)",
    key: "a",
    keys: [{ ch: "a" }],
    group: "recurring",
    hint: true,
    when: (ctx) => ctx.ui.filter === "recurring" && ctx.selectedSeries()?.status === "draft",
    run: (ctx) => {
      const sr = ctx.selectedSeries()!;
      return ctx.exec(async () => {
        await ctx.transport.request("recurring", "approve", { id: sr.id });
        await ctx.loadRecurring(true);
        return `approved: ${sr.title}`;
      });
    },
  },
  {
    id: "unapprove-recurring",
    label: "Recurring task back to draft (stop scheduling)",
    key: "u",
    keys: [{ ch: "u" }],
    group: "recurring",
    hint: true,
    when: (ctx) => ctx.ui.filter === "recurring" && ctx.selectedSeries()?.status === "approved",
    run: (ctx) => {
      const sr = ctx.selectedSeries()!;
      return ctx.exec(async () => {
        await ctx.transport.request("recurring", "unapprove", { id: sr.id });
        await ctx.loadRecurring(true);
        return `back to draft: ${sr.title}`;
      });
    },
  },
  {
    id: "star-recurring",
    label: "Toggle star (series)",
    key: "s",
    keys: [{ ch: "s" }],
    group: "recurring",
    when: (ctx) => ctx.ui.filter === "recurring" && !!ctx.selectedSeries(),
    run: (ctx) => ctx.toast("star a recurring series from the web UI (not exposed over Connect yet)", "warn"),
  },
  // ── view / app ──
  {
    id: "servers",
    label: "Switch server",
    key: "@",
    keys: [{ ch: "@" }],
    group: "app",
    when: () => true,
    run: (ctx) => openServers(ctx),
  },
  {
    id: "palette",
    label: "Command palette",
    key: ":",
    keys: [{ ch: ":" }, { ctrl: "k" }, { ctrl: "p" }],
    group: "app",
    when: () => true,
    run: (ctx) => openPalette(ctx),
  },
  {
    id: "help",
    label: "Help / keys",
    key: "?",
    keys: [{ ch: "?" }],
    group: "app",
    when: () => true,
    run: (ctx) => openHelp(ctx),
  },
  {
    id: "feed",
    label: "Toggle live feed column",
    key: "o",
    keys: [{ ch: "o" }],
    group: "view",
    when: (ctx) => ctx.transport.capabilities().globalFeed,
    run: (ctx) => {
      ctx.ui.feedHidden = !ctx.ui.feedHidden;
      if (ctx.ui.feedHidden && ctx.ui.focus === "feed") ctx.ui.focus = "main";
    },
  },
  {
    id: "resync",
    label: "Resync from daemon",
    key: "ctrl+r",
    keys: [{ ctrl: "r" }],
    group: "app",
    when: () => true,
    run: (ctx) => {
      ctx.resync();
      ctx.toast("resyncing…", "info");
    },
  },
  {
    id: "quit",
    label: "Quit",
    key: "q",
    keys: [{ ch: "q" }, { ctrl: "c" }],
    group: "app",
    when: () => true,
    run: (ctx) => ctx.quit(),
  },
];

export function availableActions(ctx: Ctx): Action[] {
  return ACTIONS.filter((a) => a.when(ctx));
}

export function actionForKey(ctx: Ctx, k: KeyEvent): Action | null {
  for (const a of ACTIONS) {
    if (!a.keys.some((m) => keyMatches(k, m))) continue;
    if (a.when(ctx)) return a;
  }
  return null;
}

// ── modal builders ────────────────────────────────────────────────────────

function form(
  _ctx: Ctx,
  spec: Omit<FormModal, "kind" | "active" | "error" | "busy" | "width"> & { width?: number },
): FormModal {
  return { kind: "form", active: 0, error: null, busy: false, width: spec.width ?? 78, ...spec };
}

/** Field that accepts `ctrl+o` to replace its contents with a file's text. */
function fileLoadKeyHandler(bufKey: string): (key: KeyEvent, modal: FormModal) => boolean {
  return (key, modal) => {
    if (!(key.type === "ctrl" && key.ch === "o")) return false;
    const field = modal.fields[modal.active];
    const target = modal.fields.find((f) => f.key === bufKey);
    if (!field || !target || !("buf" in target)) return false;
    if (field.kind !== "text" || field.key !== "path") {
      modal.error = "move to the file path field, type a path, then ctrl+o";
      return true;
    }
    const p = resolve(field.buf.value.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    try {
      target.buf.value = readFileSync(p, "utf8");
      target.buf.caret = 0;
      modal.error = null;
      modal.active = modal.fields.indexOf(target);
    } catch (err) {
      modal.error = `cannot read ${p}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return true;
  };
}

export async function openTaskForm(ctx: Ctx, existing: TaskItem | null): Promise<void> {
  const assignees = await ctx.loadAssignees().catch(() => [] as Assignee[]);
  const detail = existing ? ctx.store.peekBundle(existing.id)?.detail : null;
  const kindLabel = (a: Assignee) => (a.kind === "custom-agent" ? "custom agent" : a.kind === "single-agent" ? "single agent" : `team · ${a.phaseCount} phases`);
  const order = { team: 0, "custom-agent": 1, "single-agent": 2 } as const;
  const sorted = [...assignees].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  const teamOptions = [
    { value: "", label: "none (solo / conversational)" },
    ...sorted.map((a) => ({ value: a.id, label: `${a.kind === "team" ? "⬢" : "◉"} ${a.name}`, hint: kindLabel(a) })),
  ];
  const teamIdx = Math.max(0, teamOptions.findIndex((o) => o.value === (existing?.team_id ?? "")));
  const modeOptions = [
    { value: "workflow", label: "⚡ autopilot (workflow)", hint: "system drives to the end of the phases" },
    { value: "conversational", label: "☾ manual (conversational)", hint: "you drive; agents finish the instruction and rest" },
  ];
  const isDraftEdit = !!existing && existing.status === "draft";
  const fields: FormModal["fields"] = [
    { kind: "text", key: "title", label: "Title", buf: new TextBuffer(existing?.title ?? ""), placeholder: ctx.store.titleGeneratorConfigured ? "blank = generated from the description" : "what should happen?", required: !ctx.store.titleGeneratorConfigured || !!existing },
    { kind: "textarea", key: "description", label: "Description", buf: new TextBuffer(detail?.description ?? "", true), rows: 8, placeholder: "the brief the team receives. ctrl+j for a new line, paste is fine." },
    { kind: "select", key: "teamId", label: "Assign to", options: teamOptions, index: teamIdx, hint: "←/→ cycle · type a letter to jump" },
  ];
  if (!existing || isDraftEdit) {
    fields.push({ kind: "select", key: "mode", label: "Mode", options: modeOptions, index: existing?.mode === "conversational" ? 1 : 0 });
  } else {
    fields.push({ kind: "static", key: "mode", label: "Mode", text: `${existing.mode === "workflow" ? "⚡ autopilot" : "☾ manual"}  (toggle with A)` });
  }
  fields.push({ kind: "text", key: "workingDirectory", label: "Working directory", buf: new TextBuffer(detail?.working_directory ?? (existing ? "" : process.cwd())) });
  if (!existing) {
    fields.push({
      kind: "select",
      key: "summary",
      label: "Transcript summary",
      options: [
        { value: "", label: "global setting", hint: "config page default" },
        { value: "true", label: "on", hint: "summarizer digest per audio chunk" },
        { value: "false", label: "off", hint: "raw transcript straight to the timeline" },
      ],
      index: 0,
    });
    fields.push({ kind: "text", key: "windowSeconds", label: "Audio chunk seconds", buf: new TextBuffer(""), placeholder: "blank = global (5..600)" });
    fields.push({ kind: "toggle", key: "memory", label: "Memory", value: false, hint: "record exchanges for query_task_memory" });
    fields.push({ kind: "toggle", key: "approve", label: "Approve immediately", value: true, hint: "off = stays a draft" });
  }
  ctx.push(form(ctx, {
    title: existing ? `Edit · ${shortId(existing.id)}${isDraftEdit ? "" : ` (${existing.display_status})`}` : "New task",
    subtitle: existing && !isDraftEdit
      ? ctx.transport.capabilities().editAnyStatus
        ? "Edits land on the stored task; a running agent sees them on its next turn."
        : "Remote: only drafts can be edited over Connect; this save will be refused by the daemon."
      : undefined,
    fields,
    submitLabel: existing ? "Save" : "Create",
    width: 86,
    onSubmit: async (v: FormValues) => {
      const title = String(v.title).trim();
      const teamId = String(v.teamId);
      const mode = String(v.mode ?? "");
      const workingDirectory = String(v.workingDirectory ?? "").trim();
      if (existing) {
        if (isDraftEdit) {
          await ctx.transport.request("tasks", "update", { id: existing.id, title, description: String(v.description), teamId, mode });
        } else {
          await ctx.transport.updateTask(existing.id, { title, description: String(v.description), teamId, ...(workingDirectory ? { workingDirectory } : {}) });
          ctx.reloadTask(existing.id);
        }
        return `saved: ${title}`;
      }
      if (!title && !ctx.store.titleGeneratorConfigured) throw new Error("title is required");
      if (mode === "workflow" && !teamId && v.approve) throw new Error("an autopilot task needs an assignee to be approved. pick one, switch to manual, or untick approve.");
      const created = (await ctx.transport.request("tasks", "create", {
        title,
        description: String(v.description),
        teamId: teamId || undefined,
        mode,
        workingDirectory: workingDirectory || process.cwd(),
        memoryEnabled: v.memory === true,
        ...(v.summary === "true" || v.summary === "false" ? { summaryEnabled: v.summary === "true" } : {}),
        ...(String(v.windowSeconds ?? "").trim() ? { windowSeconds: Number(String(v.windowSeconds).trim()) } : {}),
      })) as { id: string; title?: string };
      if (v.approve) await ctx.transport.request("tasks", "approve", { id: created.id });
      ctx.ui.filter = v.approve ? "active" : "drafts";
      ctx.selectTask(created.id);
      return v.approve ? `created + approved: ${title || created.title || shortId(created.id)}` : `draft created: ${title || shortId(created.id)}`;
    },
  }));
}

/** Create a recurring series, or edit `existing` in place (`recurring/update`). */
export async function openRecurringForm(ctx: Ctx, existing: RecurringSeries | null = null): Promise<void> {
  const teams = await ctx.loadAssignees().catch(() => [] as Assignee[]);
  const teamOptions = teams.map((t) => ({ value: t.id, label: t.name, hint: t.kind === "team" ? `team · ${t.phaseCount} phases` : t.kind.replace("-", " ") }));
  if (teamOptions.length === 0) {
    ctx.toast("a recurring task needs a team. import or create one first (T).", "warn");
    return;
  }
  const cadence = [
    { value: "", label: "manual only" },
    { value: "minutes", label: "every N minutes" },
    { value: "hours", label: "every N hours" },
    { value: "days", label: "every N days" },
  ];
  const teamIdx = Math.max(0, teamOptions.findIndex((o) => o.value === (existing?.teamId ?? "")));
  const unitIdx = existing ? Math.max(0, cadence.findIndex((o) => o.value === (existing.scheduleUnit ?? ""))) : 2;
  const fields: FormModal["fields"] = [
    { kind: "text", key: "title", label: "Title", buf: new TextBuffer(existing?.title ?? ""), required: true },
    { kind: "textarea", key: "description", label: "Description", buf: new TextBuffer(existing?.description ?? "", true), rows: 6 },
    { kind: "select", key: "teamId", label: "Team", options: teamOptions, index: teamIdx },
    { kind: "select", key: "unit", label: "Cadence", options: cadence, index: unitIdx },
    { kind: "text", key: "amount", label: "N", buf: new TextBuffer(String(existing?.scheduleAmount ?? 1)), hint: "ignored for manual" },
  ];
  if (existing) fields.push({ kind: "static", key: "status", label: "Status", text: `${existing.status}  (a approve · u back to draft)` });
  else fields.push({ kind: "toggle", key: "approve", label: "Approve immediately", value: true, hint: "off = inert draft series" });
  ctx.push(form(ctx, {
    title: existing ? `Edit recurring · ${existing.title}` : "New recurring task",
    subtitle: existing
      ? "Saves in place. An approved series is re-approved after the edit, so the next run is recomputed from the new schedule."
      : "Runs spawn as normal tasks on the schedule. Pick manual for a webhook / run-now only series.",
    fields,
    submitLabel: existing ? "Save" : "Create",
    onSubmit: async (v) => {
      const unit = String(v.unit);
      const amount = Number(String(v.amount).trim());
      if (unit && (!Number.isFinite(amount) || amount <= 0)) throw new Error("N must be a positive number");
      if (existing) {
        await ctx.transport.request("recurring", "update", {
          id: existing.id,
          title: String(v.title).trim(),
          description: String(v.description),
          teamId: String(v.teamId),
          scheduleUnit: unit || undefined,
          scheduleAmount: unit ? amount : undefined,
        });
        await ctx.loadRecurring(true);
        return `saved: ${String(v.title).trim()}`;
      }
      await ctx.transport.request("tasks", "create", {
        kind: "recurring",
        title: String(v.title).trim(),
        description: String(v.description),
        teamId: String(v.teamId),
        scheduleUnit: unit || undefined,
        scheduleAmount: unit ? amount : undefined,
        autoApprove: v.approve === true,
      });
      ctx.ui.filter = "recurring";
      await ctx.loadRecurring(true);
      return `recurring task created: ${String(v.title).trim()}`;
    },
  }));
}

export function openImportTeam(ctx: Ctx): void {
  const json = new TextBuffer("", true);
  const modal = form(ctx, {
    title: "Import team",
    subtitle: ctx.transport.capabilities().fullTeamImport
      ? "Paste a team export (one team, an array, or { teams: [...] }). Same id = update in place. Or type a path and press ctrl+o to load the file."
      : "Remote import goes over Connect: name, phases, agents and mode land; skipper_prompt, hooks and Slack config in the export are dropped. Same id = update in place.",
    fields: [
      { kind: "text", key: "path", label: "File path", buf: new TextBuffer(""), placeholder: "./team.json  (optional)", hint: "ctrl+o loads it" },
      { kind: "textarea", key: "json", label: "Team JSON", buf: json, rows: 14, placeholder: '{ "name": "…", "phases": [...], "agents": [...] }', required: true, hint: "paste here" },
    ],
    submitLabel: "Import",
    width: 96,
    footerHint: "ctrl+o load file · ctrl+s import · esc cancel",
    onSubmit: async (v) => {
      let text = String(v.json).trim();
      const path = String(v.path).trim();
      if (!text && path) text = readFileSync(resolve(path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")), "utf8");
      if (!text) throw new Error("paste team JSON or give a file path");
      const r = await ctx.transport.importTeams(text);
      await ctx.loadTeams(true);
      if (r.errors.length) {
        const first = r.errors[0]!;
        throw new Error(`${r.imported} imported, ${r.updated} updated, ${r.errors.length} failed: ${first.team}: ${first.error}`);
      }
      return `teams imported: ${r.imported} new, ${r.updated} updated`;
    },
  });
  modal.onKey = fileLoadKeyHandler("json");
  ctx.push(modal);
}

export async function openTeams(ctx: Ctx): Promise<void> {
  const teams = await ctx.loadTeams(true).catch((e: Error) => {
    ctx.toast(e.message, "error");
    return [] as Team[];
  });
  const items: ListItem[] = teams.map(teamListItem);
  const modal: ListModal = {
    kind: "list",
    title: `Teams · ${teams.length}`,
    items,
    index: 0,
    filter: new TextBuffer(""),
    filterable: true,
    filterFocused: true,
    width: Math.min(110, 120),
    height: 26,
    error: null,
    busy: false,
    hint: "↓ to the list · enter details · e edit · n task with team · x export · X all · d delete · I import · / filter",
    emptyText: "no teams yet. press I to import one.",
    onPick: (item) => openTeamDetail(ctx, item.data as Team),
    onKey: async (key, item) => {
      if (key.type !== "char") return false;
      const team = item?.data as Team | undefined;
      switch (key.ch) {
        case "I":
          openImportTeam(ctx);
          return true;
        case "e": {
          if (!team) return true;
          openTeamEditor(ctx, team, async () => {
            const fresh = await ctx.loadTeams(true);
            modal.items = fresh.map(teamListItem);
            modal.title = `Teams · ${fresh.length}`;
          });
          return true;
        }
        case "x": {
          if (!team) return true;
          await ctx.exec(async () => {
            const json = await ctx.transport.exportTeams(team.id);
            const file = resolve(process.cwd(), `team-${slug(team.name)}.json`);
            writeFileSync(file, json);
            return `exported → ${file}`;
          });
          return true;
        }
        case "X": {
          await ctx.exec(async () => {
            const json = await ctx.transport.exportTeams();
            const file = resolve(process.cwd(), `teams-export.json`);
            writeFileSync(file, json);
            return `exported ${teams.length} teams → ${file}`;
          });
          return true;
        }
        case "n": {
          if (!team) return true;
          ctx.pop();
          await openTaskForm(ctx, null);
          const top = ctx.ui.modals[ctx.ui.modals.length - 1];
          if (top?.kind === "form") {
            const f = top.fields.find((x) => x.key === "teamId");
            if (f?.kind === "select") f.index = Math.max(0, f.options.findIndex((o) => o.value === team.id));
          }
          return true;
        }
        case "d": {
          if (!team) return true;
          ctx.push({
            kind: "confirm",
            title: "Delete team",
            body: `Delete team "${team.name}" (${team.agentCount} agents, ${team.phaseCount} phases)? Tasks already assigned keep running; new tasks cannot pick it.`,
            confirmLabel: "Delete team",
            danger: true,
            busy: false,
            error: null,
            onConfirm: async () => {
              await ctx.transport.request("teams", "delete", { id: team.id });
              modal.items = modal.items.filter((i) => i.id !== team.id);
              modal.title = `Teams · ${modal.items.length}`;
              await ctx.loadTeams(true);
              return `deleted team: ${team.name}`;
            },
          });
          return true;
        }
        default:
          return false;
      }
    },
  };
  ctx.push(modal);
}

function teamListItem(t: Team): ListItem {
  return {
    id: t.id,
    label: t.name,
    right: `${t.agentCount} agents · ${t.phaseCount} phases · ${t.mode === "workflow" ? "⚡" : "☾"}`,
    detail: [t.agents.map((a) => `${a.name}(${a.type})`).join(", "), t.phases.map((p) => p.name).join(" › ")].filter(Boolean).join("  ·  "),
    glyph: "⬢",
    color: C.accent,
    data: t,
  };
}

type EditPhase = Team["phases"][number];
type EditAgent = Team["agents"][number];

/**
 * Team editor: a list of the team's fields, phases and agents. Enter opens the
 * row's form, `a`/`A` add a phase/agent, `d` deletes, `J`/`K` reorder. Nothing
 * reaches the daemon until ctrl+s, which sends the whole team through
 * `teams/update` (the daemon keeps skipper_prompt, hooks, Slack config and each
 * surviving agent's tools/identity, which this editor never shows).
 */
export function openTeamEditor(ctx: Ctx, team: Team, onSaved?: () => Promise<void> | void): void {
  const draft = {
    name: team.name,
    mode: team.mode === "conversational" ? "conversational" : "workflow",
    phases: team.phases.map((p) => ({ ...p })) as EditPhase[],
    agents: team.agents.map((a) => ({ ...a })) as EditAgent[],
  };
  const oneLine = (s: string, n = 90) => s.replace(/\s+/g, " ").trim().slice(0, n);

  const buildItems = (): ListItem[] => {
    const items: ListItem[] = [
      { id: "name", glyph: "⬢", color: C.accent, label: `Name   ${draft.name}`, hint: "enter renames" },
      { id: "mode", glyph: draft.mode === "workflow" ? "⚡" : "☾", color: draft.mode === "workflow" ? C.warn : C.info, label: `Mode   ${draft.mode === "workflow" ? "autopilot (workflow)" : "manual (conversational)"}`, hint: "enter toggles" },
      { id: "h-phases", glyph: " ", label: `PHASES · ${draft.phases.length}`, right: "a add", disabled: true },
    ];
    draft.phases.forEach((p, i) => items.push({
      id: `p:${i}`,
      glyph: `${i + 1}.`,
      color: C.accent,
      label: p.name || "(unnamed phase)",
      right: p.review ? "✎ review gate" : "",
      detail: p.prompt ? oneLine(p.prompt) : "(no prompt)",
      data: { kind: "phase", i },
    }));
    if (draft.phases.length === 0) items.push({ id: "p-none", glyph: " ", label: "no phases: the team runs as a single conversation", disabled: true });
    items.push({ id: "h-agents", glyph: " ", label: `AGENTS · ${draft.agents.length}`, right: "A add", disabled: true });
    draft.agents.forEach((a, i) => items.push({
      id: `a:${i}`,
      glyph: "⬢",
      color: C.violet,
      label: `${a.name || "(unnamed)"}   ${a.type}${a.model ? ` · ${a.model}` : ""}${a.role ? ` · ${a.role}` : ""}`,
      detail: a.instruction ? oneLine(a.instruction) : "(no instruction)",
      data: { kind: "agent", i },
    }));
    if (draft.agents.length === 0) items.push({ id: "a-none", glyph: " ", label: "no agents: add one with A", disabled: true });
    return items;
  };

  const modal: ListModal = {
    kind: "list",
    title: `Edit team · ${team.name}`,
    items: buildItems(),
    index: 0,
    filter: new TextBuffer(""),
    filterable: false,
    width: 100,
    height: 30,
    error: null,
    busy: false,
    hint: "enter edit row · a phase · A agent · d delete · J/K move · ctrl+s save · esc close",
    onPick: (item) => pick(item),
    onKey: async (key, item) => {
      if (key.type === "ctrl" && key.ch === "s") {
        await save();
        return true;
      }
      if (key.type !== "char") return false;
      const sel = item?.data as { kind: "phase" | "agent"; i: number } | undefined;
      switch (key.ch) {
        case "a":
          openPhaseForm(null);
          return true;
        case "A":
          openAgentForm(null);
          return true;
        case "d":
          if (!sel) return true;
          if (sel.kind === "phase") draft.phases.splice(sel.i, 1);
          else draft.agents.splice(sel.i, 1);
          touch();
          return true;
        case "J":
        case "K": {
          if (!sel) return true;
          const list: unknown[] = sel.kind === "phase" ? draft.phases : draft.agents;
          const j = sel.i + (key.ch === "J" ? 1 : -1);
          if (j < 0 || j >= list.length) return true;
          [list[sel.i], list[j]] = [list[j], list[sel.i]];
          touch();
          modal.index = modal.items.findIndex((it) => it.id === `${sel.kind === "phase" ? "p" : "a"}:${j}`);
          return true;
        }
        default:
          return false;
      }
    },
  };

  const touch = () => {
    const keep = modal.items[modal.index]?.id;
    modal.items = buildItems();
    modal.title = `Edit team · ${draft.name} •`;
    const idx = keep ? modal.items.findIndex((it) => it.id === keep) : -1;
    modal.index = idx >= 0 ? idx : Math.min(modal.index, modal.items.length - 1);
  };

  const pick = (item: ListItem): void => {
    const sel = item.data as { kind: "phase" | "agent"; i: number } | undefined;
    if (item.id === "name") {
      ctx.push(form(ctx, {
        title: "Team name",
        fields: [{ kind: "text", key: "name", label: "Name", buf: new TextBuffer(draft.name), required: true }],
        submitLabel: "OK",
        width: 60,
        onSubmit: (v) => {
          draft.name = String(v.name).trim();
          touch();
        },
      }));
      return;
    }
    if (item.id === "mode") {
      draft.mode = draft.mode === "workflow" ? "conversational" : "workflow";
      touch();
      return;
    }
    if (sel?.kind === "phase") openPhaseForm(sel.i);
    else if (sel?.kind === "agent") openAgentForm(sel.i);
  };

  const openPhaseForm = (i: number | null): void => {
    const p = i === null ? { name: "", prompt: "", review: false } : draft.phases[i]!;
    ctx.push(form(ctx, {
      title: i === null ? "Add phase" : `Phase ${i + 1} · ${p.name}`,
      fields: [
        { kind: "text", key: "name", label: "Name", buf: new TextBuffer(p.name), required: true },
        { kind: "textarea", key: "prompt", label: "Prompt", buf: new TextBuffer(p.prompt, true), rows: 10, placeholder: "what the team does in this phase. ctrl+j for a new line." },
        { kind: "toggle", key: "review", label: "Review gate", value: p.review, hint: "pause for your approval before the next phase" },
      ],
      submitLabel: i === null ? "Add" : "OK",
      width: 90,
      onSubmit: (v) => {
        const next: EditPhase = { name: String(v.name).trim(), prompt: String(v.prompt), review: v.review === true };
        if (i === null) draft.phases.push(next);
        else draft.phases[i] = next;
        touch();
      },
    }));
  };

  const openAgentForm = (i: number | null): void => {
    const a: EditAgent = i === null ? { id: "", name: "", type: "claude-code", model: "", instruction: "", role: null } : draft.agents[i]!;
    ctx.push(form(ctx, {
      title: i === null ? "Add agent" : `Agent · ${a.name}`,
      subtitle: i === null ? undefined : "Tools, capabilities and identity set in the web editor are kept as they are.",
      fields: [
        { kind: "text", key: "name", label: "Name", buf: new TextBuffer(a.name), required: true },
        { kind: "text", key: "type", label: "Type", buf: new TextBuffer(a.type), required: true, hint: "claude-code · codex · opencode · grok · custom agent id" },
        { kind: "text", key: "model", label: "Model", buf: new TextBuffer(a.model), placeholder: "blank = provider default" },
        { kind: "text", key: "role", label: "Role", buf: new TextBuffer(a.role ?? ""), placeholder: "optional, e.g. reviewer" },
        { kind: "textarea", key: "instruction", label: "Instruction", buf: new TextBuffer(a.instruction, true), rows: 8, placeholder: "standing instruction for this agent. ctrl+j for a new line." },
      ],
      submitLabel: i === null ? "Add" : "OK",
      width: 90,
      onSubmit: (v) => {
        const role = String(v.role ?? "").trim();
        const next: EditAgent = { id: a.id, name: String(v.name).trim(), type: String(v.type).trim(), model: String(v.model ?? "").trim(), instruction: String(v.instruction ?? ""), role: role || null };
        if (i === null) draft.agents.push(next);
        else draft.agents[i] = next;
        touch();
      },
    }));
  };

  const save = async (): Promise<void> => {
    if (!draft.name.trim()) throw new Error("the team needs a name");
    await ctx.transport.request("teams", "update", {
      id: team.id,
      name: draft.name.trim(),
      mode: draft.mode,
      phases: draft.phases.map((p) => ({ name: p.name, prompt: p.prompt, review: p.review })),
      agents: draft.agents.map((a) => ({ ...(a.id ? { id: a.id } : {}), name: a.name, type: a.type, model: a.model, instruction: a.instruction, ...(a.role ? { role: a.role } : {}) })),
    });
    await onSaved?.();
    ctx.pop();
    ctx.toast(`saved team: ${draft.name.trim()}`, "ok");
  };

  ctx.push(modal);
}

function openTeamDetail(ctx: Ctx, t: Team): void {
  const lines: string[] = [];
  lines.push(`${t.name}`);
  lines.push(`id ${t.id} · mode ${t.mode}${t.slackEnabled ? ` · slack ${t.slashCommand || "on"}` : ""}`);
  lines.push("");
  lines.push("AGENTS");
  for (const a of t.agents) {
    lines.push(`⬢ ${a.name}  ${a.type}${a.model ? ` · ${a.model}` : ""}${a.role ? ` · ${a.role}` : ""}`);
    if (a.instruction) lines.push(`   ${a.instruction.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  if (t.agents.length === 0) lines.push("(none)");
  lines.push("");
  lines.push("PHASES");
  t.phases.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name}${p.review ? "  ✎ review gate" : ""}`);
    if (p.prompt) lines.push(`   ${p.prompt.replace(/\s+/g, " ").slice(0, 600)}`);
  });
  if (t.phases.length === 0) lines.push("(no phases)");
  ctx.push({ kind: "text", title: `Team · ${t.name}`, body: lines.join("\n"), scroll: 0, width: 100, height: 30, hint: "↑↓ scroll · esc back" });
}

function openReviewForm(ctx: Ctx, t: TaskItem, verdict: "approve" | "reject"): void {
  const buf = new TextBuffer("", true);
  ctx.push(form(ctx, {
    title: verdict === "approve" ? `Approve review · ${shortId(t.id)}` : `Reject review · ${shortId(t.id)}`,
    subtitle: verdict === "approve" ? "Advances to the next phase. An optional note goes to the team." : "Regresses the phase. Tell the team what to fix.",
    fields: [{ kind: "textarea", key: "message", label: verdict === "approve" ? "Note (optional)" : "Reason", buf, rows: 5, required: verdict === "reject" }],
    submitLabel: verdict === "approve" ? "Approve" : "Reject",
    onSubmit: async (v) => {
      await ctx.transport.request("reviews", verdict, { taskId: t.id, message: String(v.message) || undefined });
      return verdict === "approve" ? `review approved: ${t.title}` : `review rejected: ${t.title}`;
    },
  }));
}

function openEscalationForm(ctx: Ctx, t: TaskItem): void {
  const escs = ctx.store.escalationsFor(t.id);
  const e = escs[0];
  if (!e) return;
  const buf = new TextBuffer("", true);
  ctx.push(form(ctx, {
    title: `Respond · ${e.agentName ?? "agent"} asks`,
    subtitle: toPlainText(e.question),
    fields: [{ kind: "textarea", key: "message", label: "Your answer", buf, rows: 6, required: true }],
    submitLabel: "Send answer",
    width: 90,
    onSubmit: async (v) => {
      await ctx.transport.request("escalations", "respond", { id: e.id, message: String(v.message) });
      return `answered ${e.agentName ?? "agent"}`;
    },
  }));
}

function openEscalationList(ctx: Ctx): void {
  const items: ListItem[] = ctx.store.openEscalations().map((e) => {
    const t = ctx.store.task(e.taskId);
    return { id: e.id, label: t?.title ?? e.taskId, right: e.agentName ?? "", detail: toOneLine(e.question), glyph: "▲", color: C.danger, data: e };
  });
  ctx.push({
    kind: "list",
    title: `Open escalations · ${items.length}`,
    items,
    index: 0,
    filter: new TextBuffer(""),
    filterable: items.length > 6,
    filterFocused: items.length > 6,
    width: 100,
    height: 22,
    error: null,
    busy: false,
    emptyText: "nothing blocked",
    onPick: (item) => {
      const e = item.data as { taskId: string };
      ctx.pop();
      ctx.ui.filter = "active";
      ctx.selectTask(e.taskId);
      const t = ctx.store.task(e.taskId);
      if (t) openEscalationForm(ctx, t);
    },
  });
}

const ICONS = ["rocket", "bug", "wrench", "flame", "star", "zap", "shield", "database", "globe", "terminal", "code", "book-open", "flask-conical", "lightbulb", "package", "truck", "heart", "bell", "cpu", "cloud", "compass", "anchor", "target", "gem"];
const COLORS: Array<[string, string]> = [["teal", "#2dd4bf"], ["sky", "#38bdf8"], ["violet", "#a78bfa"], ["pink", "#f472b6"], ["amber", "#fbbf24"], ["orange", "#fb923c"], ["red", "#f87171"], ["green", "#4ade80"], ["slate", "#94a3b8"]];

function openIconForm(ctx: Ctx, t: TaskItem): void {
  const iconOptions = [{ value: "", label: "none (clear)" }, ...ICONS.map((i) => ({ value: i, label: i }))];
  const colorOptions = COLORS.map(([n, hex]) => ({ value: hex, label: `${n} ${hex}` }));
  ctx.push(form(ctx, {
    title: `Icon · ${shortId(t.id)}`,
    subtitle: "Lucide icon id + tint, shown in the web and native task lists.",
    fields: [
      { kind: "select", key: "icon", label: "Icon", options: iconOptions, index: Math.max(0, iconOptions.findIndex((o) => o.value === (t.icon ?? ""))) },
      { kind: "select", key: "color", label: "Colour", options: colorOptions, index: Math.max(0, colorOptions.findIndex((o) => o.value === (t.icon_color ?? ""))) },
    ],
    submitLabel: "Set icon",
    width: 60,
    onSubmit: async (v) => {
      await req(ctx, t.id, "set-icon", { icon: String(v.icon) || null, iconColor: String(v.color) });
      return v.icon ? `icon set: ${String(v.icon)}` : "icon cleared";
    },
  }));
}

/** Artifact viewer: inline bodies (text / markdown / html→text) in a scrollable modal; files show metadata. */
export async function openArtifact(ctx: Ctx, a: Artifact): Promise<void> {
  const title = `${a.name} · v${a.version} · ${a.kind}`;
  const meta = [
    `id ${a.id}`,
    `storage ${a.storage}${a.mime ? ` · ${a.mime}` : ""}${a.bytes != null ? ` · ${humanBytes(a.bytes)}` : ""}`,
    `created ${a.createdAt}${a.publishedAt ? ` · public ${a.publicUrl ?? ""}` : ""}`,
  ];
  if (a.storage === "file") {
    const body = [...meta, "", a.description ? a.description : "(no caption)", "", `Binary file. Open it in the web UI (w on the task) or fetch ${ctx.httpBase()}/api/artifacts/${a.id}/file`].join("\n");
    ctx.push({ kind: "text", title, body, scroll: 0, width: 100, height: 20, hint: "esc close" });
    return;
  }
  const modal: import("./state").TextModal = { kind: "text", title, body: [...meta, "", "loading…"].join("\n"), scroll: 0, width: 110, height: 40, hint: "↑↓ jk scroll · pgup pgdn · g/G top/bottom · esc close" };
  ctx.push(modal);
  try {
    const r = await ctx.transport.request<Record<string, unknown>>("artifacts", "read", { id: a.id });
    const raw = typeof r.body === "string" ? r.body : "";
    const format = typeof r.format === "string" ? r.format : a.format;
    const body = toPlainText(raw, format === "html" ? "html" : format === "markdown" ? "markdown" : undefined);
    modal.body = [...meta, a.description ? `caption ${a.description}` : "", "".padEnd(60, "─"), body || "(empty)"].filter((l, i) => i !== 3 || l).join("\n");
    modal.onKey = (k) => {
      if (k.type === "char" && k.ch === "g") { modal.scroll = 0; return true; }
      if (k.type === "char" && k.ch === "G") { modal.scroll = 1_000_000; return true; }
      return false;
    };
  } catch (err) {
    modal.body = [...meta, "", `✗ ${err instanceof Error ? err.message : String(err)}`].join("\n");
  }
}

/** Server switcher: local daemon + saved Connect remotes; add / delete in place. */
export function openServers(ctx: Ctx): void {
  const current = ctx.currentServer();
  const build = (): ListItem[] =>
    allServers().map((s) => ({
      id: s.id,
      label: s.name,
      hint: s.kind === "local" ? `this machine · ${s.baseURL}` : `remote · ${s.baseURL}`,
      right: s.id === current.id ? "● connected" : "",
      glyph: s.kind === "local" ? "⌂" : "⇅",
      color: s.id === current.id ? C.ok : C.accent,
      data: s,
    }));
  const modal: ListModal = {
    kind: "list",
    title: "Servers",
    items: build(),
    index: Math.max(0, allServers().findIndex((s) => s.id === current.id)),
    filter: new TextBuffer(""),
    filterable: false,
    width: 80,
    height: 16,
    error: null,
    busy: false,
    hint: "enter connect · a add remote · d delete remote · esc",
    onPick: async (item) => {
      const s = item.data as ServerConfig;
      if (s.id === current.id) {
        ctx.pop();
        return;
      }
      await ctx.switchServer(s);
    },
    onKey: (key, item) => {
      if (key.type !== "char") return false;
      if (key.ch === "a") {
        openAddServer(ctx, () => {
          modal.items = build();
        });
        return true;
      }
      if (key.ch === "d") {
        const s = item?.data as ServerConfig | undefined;
        if (!s || s.kind !== "remote") return true;
        ctx.push({
          kind: "confirm",
          title: "Delete server",
          body: `Forget "${s.name}" (${s.baseURL}) and its key?`,
          confirmLabel: "Delete",
          danger: true,
          busy: false,
          error: null,
          onConfirm: () => {
            const file = loadServers();
            saveServers({ servers: file.servers.filter((x) => x.id !== s.id), activeId: file.activeId === s.id ? null : file.activeId });
            modal.items = build();
            modal.index = Math.min(modal.index, Math.max(modal.items.length - 1, 0));
            return `removed ${s.name}`;
          },
        });
        return true;
      }
      return false;
    },
  };
  ctx.push(modal);
}

function openAddServer(ctx: Ctx, onSaved: () => void): void {
  ctx.push(form(ctx, {
    title: "Add remote server",
    subtitle: "A Skipper Connect integrator. The key is stored in your data dir (dashboard-servers.json, 0600).",
    fields: [
      { kind: "text", key: "name", label: "Name", buf: new TextBuffer(""), required: true },
      { kind: "text", key: "url", label: "URL", buf: new TextBuffer(""), placeholder: "https://connect.example.com", required: true },
      { kind: "text", key: "key", label: "Integrator key", buf: new TextBuffer(""), required: true },
      { kind: "toggle", key: "connect", label: "Connect now", value: true },
    ],
    submitLabel: "Save",
    width: 72,
    onSubmit: async (v) => {
      const baseURL = String(v.url).trim().replace(/\/+$/, "");
      if (!/^(https?|wss?):\/\//i.test(baseURL)) throw new Error("url must start with https:// (or http:// for a dev worker)");
      const server: ServerConfig = { id: crypto.randomUUID(), name: String(v.name).trim(), kind: "remote", baseURL, integratorKey: String(v.key).trim() };
      const file = loadServers();
      saveServers({ servers: [...file.servers, server], activeId: file.activeId });
      onSaved();
      if (v.connect) await ctx.switchServer(server);
      return v.connect ? undefined : `saved ${server.name}`;
    },
  }));
}

export function openPalette(ctx: Ctx): void {
  const items: ListItem[] = availableActions(ctx)
    .filter((a) => a.id !== "palette")
    .map((a) => ({ id: a.id, label: a.label, right: a.key, hint: a.group, data: a }));
  ctx.push({
    kind: "list",
    title: "Commands",
    items,
    index: 0,
    filter: new TextBuffer(""),
    filterable: true,
    filterFocused: true,
    width: 70,
    height: Math.min(items.length + 6, 28),
    error: null,
    busy: false,
    hint: "type to filter · enter run · esc",
    onPick: async (item) => {
      ctx.pop();
      await (item.data as Action).run(ctx);
    },
  });
}

export function openHelp(ctx: Ctx): void {
  const body = `NAVIGATION
tab / shift+tab   cycle focus: tasks › detail › feed (single column: switch view)
↑ ↓  j k          move / scroll        pgup pgdn   page
1-6               filter: active, drafts, starred, done, all, recurring
/                 filter tasks by text          esc clears
[ ]               detail tabs: timeline, activity, notes, artifacts, details
o                 hide/show the live feed column
enter             from the rail: jump to the task detail

TASK
i   send input (draft: appends to description · review: your verdict · done: revives)
n   new task        ctrl+n  new recurring task      e  edit (any status)
a   approve (start) u  back to draft               p  pause / resume
s   star            A  autopilot on/off            m  memory on/off
c   icon + colour   +  add note                    w  open in web UI
S   settle (done)   x  cancel (failed)             v  revive    D  delete

REVIEW + ESCALATION
y   approve review → next phase     N  reject review → regress
E   answer this task's escalation   ctrl+e  all open escalations

TEAMS + RECURRING
T   browse teams (details, export, delete, new task with team)
I   import team from pasted JSON or a file (ctrl+o in the form)
R   run the selected recurring task now (Recurring filter)

APP
@   switch server (local / Connect remotes; add or delete)
:   command palette (also ctrl+k)     ?  this help
ctrl+r  resync from the daemon        q  quit

EDITING (any text field)
ctrl+a/e home/end · ctrl+w delete word · ctrl+u/k kill line · ctrl+j newline
alt+←/→ word jump · paste multi-line freely (bracketed paste)
ctrl+s submits a form · tab moves between fields · ←/→/space cycle a select`;
  ctx.push({ kind: "text", title: "Skipper bridge · keys", body, scroll: 0, width: 92, height: 40, hint: "↑↓ scroll · esc close" });
}

// ── helpers ───────────────────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = Bun.spawn([cmd as string, ...(args as string[])], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    child.unref();
  } catch {
    /* no opener */
  }
}

export { formValues, visibleListItems };
