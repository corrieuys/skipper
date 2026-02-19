import { metricFragment } from "../fragments/metric.fragment";

export const FRAGMENT_ID = "sk-metrics";

export interface MetricsData {
  running: number;
  queued: number;
  activeAgents: number;
  completed: number;
  failed: number;
}

export function metricsBarPanel(data: MetricsData): string {
  return `<div id="${FRAGMENT_ID}" class="sk-metrics">
    ${metricFragment(data.running, "Running", "primary")}
    ${metricFragment(data.queued, "Queued", "muted")}
    ${metricFragment(data.activeAgents, "Agents", "secondary")}
    ${metricFragment(data.completed, "Done", "tertiary")}
    ${metricFragment(data.failed, "Failed", data.failed > 0 ? "danger" : "muted")}
  </div>`;
}
