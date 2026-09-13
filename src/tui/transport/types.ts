import type { TransportEvent } from "../model/types";

/**
 * A live, two-way connection to a Skipper daemon. The store, renderer and
 * controller depend ONLY on this interface. `LocalTransport` speaks to this
 * machine's daemon; a Connect-backed transport for a remote instance would
 * implement the same surface (the wire protocol is already shared).
 */
export interface Transport {
  /** Short human label for the header, e.g. "local" or "acme ⇅". */
  readonly label: string;

  /** What this target can do; the UI degrades gracefully on a remote. */
  capabilities(): TransportCapabilities;

  /** Begin streaming. Emits status, capabilities, a snapshot, then live events. */
  start(onEvent: (e: TransportEvent) => void): Promise<void>;

  /** Tear down sockets/timers. Idempotent. */
  close(): Promise<void>;

  /** Force a fresh full snapshot (operator pressed "r"). */
  resync(): void;

  /**
   * One Connect resource request: `{ resource, action, params }` → data.
   * Rejects with the daemon's error message when `ok` is false.
   */
  request<T = unknown>(resource: string, action: string, params?: Record<string, unknown>): Promise<T>;

  /** Tail a task's live agent output (backfill frame, then live batches). */
  subscribeOutputs(taskId: string): void;
  unsubscribeOutputs(taskId: string): void;

  /**
   * Edit title / description / assignee / cwd on a task in ANY status (the web
   * UI's `POST /api/tasks/:id/update`). Drafts can also go through
   * `tasks/update`; this is the path for active and settled tasks.
   */
  updateTask(taskId: string, fields: TaskEditFields): Promise<void>;

  /** Import teams from a JSON document (array or `{ teams: [...] }`). */
  importTeams(json: string): Promise<ImportResult>;
  /** Export one team (or all) as pretty JSON, the same shape import accepts. */
  exportTeams(teamId?: string): Promise<string>;
}

export interface ImportResult {
  imported: number;
  updated: number;
  errors: Array<{ team: string; error: string }>;
}

export interface TaskEditFields {
  title?: string;
  description?: string;
  teamId?: string;
  workingDirectory?: string;
}

export interface TransportCapabilities {
  /** Talking to a Skipper Connect integrator rather than the loopback daemon. */
  remote: boolean;
  /** The global live feed + roster lane (`/ws/ui`) is available. */
  globalFeed: boolean;
  /** Team import/export keep skipper_prompt/hooks/config (loopback HTTP route). */
  fullTeamImport: boolean;
  /** Title/description edits on active + settled tasks (loopback HTTP route). */
  editAnyStatus: boolean;
}
