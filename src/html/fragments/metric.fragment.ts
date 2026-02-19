/** Single metric (value + label) */

type MetricVariant = "primary" | "secondary" | "tertiary" | "danger" | "muted";

export function metricFragment(value: number, label: string, variant: MetricVariant = "muted"): string {
  return `<div class="sk-metric">
    <span class="sk-metric__value sk-metric__value--${variant}">${value}</span>
    <span class="sk-metric__label">${label}</span>
  </div>`;
}
