import type { Snapshot, ConnStatus } from "../model/types";

/** Focusable / scrollable panes. `output` (the live agent feed) is the star. */
export type PaneId = "output" | "agents" | "tasks";

export const PANES: readonly PaneId[] = ["output", "agents", "tasks"] as const;

/** Per-pane view state owned by the controller, not the store. */
export interface UIState {
  focused: PaneId;
  /** Scroll offset per pane. For `output` this is scrollback from the tail. */
  scroll: Record<PaneId, number>;
  /** Header label of the active transport, e.g. "local". */
  transportLabel: string;
  /** Monotonic animation tick, advanced by the controller's anim timer. */
  frame: number;
}

/** Everything the renderer needs for one frame. */
export interface RenderModel {
  data: Snapshot;
  conn: ConnStatus;
  ui: UIState;
}

/**
 * A drawing backend. `AnsiRenderer` is the built-in hand-rolled implementation;
 * a future ink/blessed backend implements the same interface and the controller
 * swaps it with no other change.
 */
export interface Renderer {
  mount(): void;
  render(model: RenderModel): void;
  size(): { cols: number; rows: number };
  unmount(): void;
  onResize(cb: () => void): void;
}
