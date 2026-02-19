/** Status badge fragment */

const STATUS_CLASS_MAP: Record<string, string> = {
  running: "sk-badge--running",
  completed: "sk-badge--completed",
  failed: "sk-badge--failed",
  approved: "sk-badge--approved",
  draft: "sk-badge--draft",
  pending: "sk-badge--pending",
  idle: "sk-badge--draft",
  busy: "sk-badge--running",
  error: "sk-badge--danger",
  stopped: "sk-badge--draft",
  waiting_delegation: "sk-badge--waiting",
  open: "sk-badge--danger",
  resolved: "sk-badge--completed",
};

export function badgeFragment(status: string): string {
  const cls = STATUS_CLASS_MAP[status] ?? "sk-badge--draft";
  return `<span class="sk-badge ${cls}">${status}</span>`;
}
