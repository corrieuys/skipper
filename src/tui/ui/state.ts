import { TextBuffer } from "../input/text-editor";
import type { KeyEvent } from "../input/keyboard";
import type { RecurringSeries, Team } from "../model/types";

/** Which column has keyboard focus. */
export type Pane = "rail" | "main" | "feed";

/**
 * Rail boards. `latest` mirrors the web sidebar's Latest tab: Needs you, Active,
 * Recurring (expandable series with their last runs) and Recent. Finished tasks
 * live under `all`; recurring series live inside `latest` (and `starred`).
 */
export type Filter = "latest" | "drafts" | "starred" | "all";

export const FILTERS: { id: Filter; label: string; key: string }[] = [
  { id: "latest", label: "Latest", key: "1" },
  { id: "all", label: "All", key: "2" },
  { id: "starred", label: "Starred", key: "3" },
  { id: "drafts", label: "Drafts", key: "4" },
];

/** How many of a series' newest runs an expanded series row lists. */
export const SERIES_RUNS_SHOWN = 5;
/** How many finished tasks the Latest board's Recent section lists. */
export const RECENT_SHOWN = 5;

export type DetailTab = "conversation" | "output" | "notes" | "artifacts" | "info";

export const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "conversation", label: "Timeline" },
  { id: "output", label: "Activity" },
  { id: "notes", label: "Notes" },
  { id: "artifacts", label: "Artifacts" },
  { id: "info", label: "Details" },
];

export type ToastLevel = "info" | "ok" | "warn" | "error";

export interface Toast {
  id: number;
  text: string;
  level: ToastLevel;
  until: number;
}

// ── modals ─────────────────────────────────────────────────────────────────

export type Field =
  | { kind: "text"; key: string; label: string; buf: TextBuffer; placeholder?: string; required?: boolean; hint?: string }
  | { kind: "textarea"; key: string; label: string; buf: TextBuffer; rows: number; placeholder?: string; required?: boolean; hint?: string }
  | { kind: "select"; key: string; label: string; options: { value: string; label: string; hint?: string }[]; index: number; hint?: string }
  | { kind: "toggle"; key: string; label: string; value: boolean; hint?: string }
  | { kind: "static"; key: string; label: string; text: string };

export type FormValues = Record<string, string | boolean>;

export interface FormModal {
  kind: "form";
  title: string;
  subtitle?: string;
  fields: Field[];
  active: number;
  submitLabel: string;
  /** Resolve to a toast text (or void). Throw to show an inline error. */
  onSubmit: (values: FormValues) => Promise<string | void> | string | void;
  error: string | null;
  busy: boolean;
  width: number;
  /** Extra keys handled while the form is open (e.g. ctrl+o to open a file). */
  onKey?: (key: KeyEvent, modal: FormModal) => boolean;
  footerHint?: string;
}

export interface ConfirmModal {
  kind: "confirm";
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => Promise<string | void> | string | void;
  busy: boolean;
  error: string | null;
}

export interface ListItem {
  id: string;
  label: string;
  hint?: string;
  /** Right-aligned short text (key chord, count, status). */
  right?: string;
  /** Secondary line below the label (wrapped to the modal width). */
  detail?: string;
  /** Colour for the leading glyph. */
  color?: number;
  glyph?: string;
  disabled?: boolean;
  data?: unknown;
}

export interface ListModal {
  kind: "list";
  title: string;
  items: ListItem[];
  index: number;
  filter: TextBuffer;
  filterable: boolean;
  /** Filter line has the caret (typing filters); false = keys act on the list. */
  filterFocused?: boolean;
  onPick: (item: ListItem) => Promise<string | void> | string | void;
  /** Extra per-item keys, e.g. `d` delete, `e` export. Return true when handled. */
  onKey?: (key: KeyEvent, item: ListItem | null, modal: ListModal) => boolean | Promise<boolean>;
  hint?: string;
  width: number;
  height: number;
  error: string | null;
  busy: boolean;
  emptyText?: string;
  /** Names the list so the controller can find it when a daemon event makes it stale. */
  tag?: string;
  /** Re-read the list's items from the daemon (called on a matching event while open). */
  reload?: () => Promise<void>;
}

export interface TextModal {
  kind: "text";
  title: string;
  body: string;
  scroll: number;
  width: number;
  height: number;
  hint?: string;
  onKey?: (key: KeyEvent, modal: TextModal) => boolean | Promise<boolean>;
}

export type Modal = FormModal | ConfirmModal | ListModal | TextModal;

// ── ui state ───────────────────────────────────────────────────────────────

export interface UIState {
  frame: number;
  focus: Pane;
  /** Visible view when the layout is single-column. */
  singleView: Pane;
  filter: Filter;
  search: TextBuffer;
  searchActive: boolean;
  selectedTaskId: string | null;
  selectedSeriesId: string | null;
  /** Which of the two the rail cursor is on: a task row or a recurring series row. */
  railKind: "task" | "series";
  /** Series whose latest runs are listed under them in the rail. */
  expandedSeries: Set<string>;
  railScroll: number;
  detailTab: DetailTab;
  /** Scrollback from the newest line for bottom-anchored bodies. */
  detailScroll: number;
  /** Selected row in the Artifacts tab (newest first). */
  artifactIndex: number;
  feedScroll: number;
  composer: TextBuffer;
  composerActive: boolean;
  modals: Modal[];
  toasts: Toast[];
  transportLabel: string;
  /** Loaded after the first snapshot for the Latest board, then kept current by `recurring:changed`. */
  recurring: RecurringSeries[];
  recurringLoadedAt: number | null;
  /** Loaded on demand for task forms + the teams browser. */
  teams: Team[];
  teamsLoadedAt: number | null;
  /** Live-feed column hidden by the operator (`o`). */
  feedHidden: boolean;
  startedAt: number;
}

export function initialUIState(transportLabel: string): UIState {
  return {
    frame: 0,
    focus: "rail",
    singleView: "rail",
    filter: "latest",
    search: new TextBuffer(""),
    searchActive: false,
    selectedTaskId: null,
    selectedSeriesId: null,
    railKind: "task",
    expandedSeries: new Set(),
    railScroll: 0,
    detailTab: "conversation",
    detailScroll: 0,
    artifactIndex: 0,
    feedScroll: 0,
    composer: new TextBuffer("", true),
    composerActive: false,
    modals: [],
    toasts: [],
    transportLabel,
    recurring: [],
    recurringLoadedAt: null,
    teams: [],
    teamsLoadedAt: null,
    feedHidden: false,
    startedAt: Date.now(),
  };
}

export function topModal(ui: UIState): Modal | null {
  return ui.modals[ui.modals.length - 1] ?? null;
}

/** Collect form values: text fields → string, select → value, toggle → boolean. */
export function formValues(m: FormModal): FormValues {
  const out: FormValues = {};
  for (const f of m.fields) {
    switch (f.kind) {
      case "text":
      case "textarea":
        out[f.key] = f.buf.value;
        break;
      case "select":
        out[f.key] = f.options[f.index]?.value ?? "";
        break;
      case "toggle":
        out[f.key] = f.value;
        break;
      case "static":
        break;
    }
  }
  return out;
}

/** Items of a list modal after its filter text is applied. */
export function visibleListItems(m: ListModal): ListItem[] {
  const q = m.filter.value.trim().toLowerCase();
  if (!q) return m.items;
  const terms = q.split(/\s+/);
  return m.items.filter((it) => {
    const hay = `${it.label} ${it.hint ?? ""} ${it.detail ?? ""} ${it.right ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
