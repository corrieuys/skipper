import type {
  Snapshot,
  TaskRow,
  AgentRow,
  ActivityRow,
  PhaseInfo,
  Metrics,
  TransportEvent,
  ConnStatus,
} from "./types";
import { EMPTY_METRICS } from "./types";

/**
 * Holds the current world state and folds transport events into it. Pure
 * domain data only — no terminal/UI concerns (scroll, focus) live here; those
 * belong to the controller/renderer. The renderer reads {@link RenderModel}.
 *
 * Every task/agent/message event REPLACES its collection wholesale (the daemon
 * sends the full active set each push), so completed/exited entities drop out
 * naturally with no per-id delete tracking. Ordering is preserved as received
 * (the daemon orders by recency).
 */
export class Store {
  private tasks: TaskRow[] = [];
  private agents: AgentRow[] = [];
  private activity: ActivityRow[] = [];
  private phase: PhaseInfo | null = null;
  private metrics: Metrics = { ...EMPTY_METRICS };
  private status: ConnStatus = "connecting";

  /** Returns true when the event changed anything the view cares about. */
  apply(event: TransportEvent): boolean {
    switch (event.kind) {
      case "snapshot":
        this.tasks = event.snapshot.tasks;
        this.agents = event.snapshot.agents;
        this.activity = event.snapshot.activity;
        this.phase = event.snapshot.phase;
        this.metrics = event.snapshot.metrics;
        return true;
      case "tasks":
        this.tasks = event.tasks;
        return true;
      case "agents":
        this.agents = event.agents;
        return true;
      case "activity":
        this.activity = event.activity;
        return true;
      case "phase":
        this.phase = event.phase;
        return true;
      case "metrics":
        this.metrics = event.metrics;
        return true;
      case "status":
        if (this.status === event.status) return false;
        this.status = event.status;
        return true;
    }
  }

  snapshot(): Snapshot {
    return {
      tasks: this.tasks,
      agents: this.agents,
      activity: this.activity,
      phase: this.phase,
      metrics: this.metrics,
    };
  }

  connStatus(): ConnStatus {
    return this.status;
  }
}
