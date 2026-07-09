import { type DaemonStatus, daemonBadgeClass } from "./components";


export function daemonControlFragment(
    status: DaemonStatus,
    compact: boolean = true
): string {
    const daemonBadge = daemonBadgeClass(status.state);
    const classes = compact
        ? "daemon-card daemon-killswitch daemon-killswitch-nav"
        : "daemon-card daemon-killswitch";

    return `<div id="daemon-global-control" class="${classes}">
    <span class="badge badge-${daemonBadge}">${status.state}</span>
    ${status.state === "running" ? `<button hx-post="/fragments/daemon/pause" hx-target="#daemon-global-control" hx-swap="outerHTML" class="btn-danger daemon-kill-btn" title="Pause" aria-label="Pause Daemon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>` : ""}
    ${status.state === "paused" ? `<button hx-post="/fragments/daemon/resume" hx-target="#daemon-global-control" hx-swap="outerHTML" class="daemon-kill-btn" title="Resume" aria-label="Resume Daemon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></button>` : ""}
    ${status.state === "pausing" ? `<span class="muted daemon-pausing"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></span>` : ""}
  </div>`;
}
