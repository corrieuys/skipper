// escapeHtml import kept for the commented-out daemon strip; re-enable when restoring.
// import { escapeHtml } from "../atoms/escape-html";
import { escalationCountFragment } from "../fragments/escalation-count.fragment";
import { themePickerFragment } from "../styles/themes";
import { isExperimental } from "../../config/feature-flags";

export interface NavbarData {
  currentPath: string;
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
  showChatToggle?: boolean;
  zenModeEnabled?: boolean;
}

export function navbar(data: NavbarData): string {
  const uptimeMin = Math.floor(data.daemonUptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h${uptimeMin % 60}m` : `${uptimeMin}m`;

  const navItems = [
    { href: "/", label: "Dashboard", match: "/" },
    { href: "/tasks", label: "Tasks", match: "/tasks" },
    { href: "/escalations", label: "Escalations", match: "/escalations" },
    { href: "/config", label: "Config", match: "/config" },
    ...(isExperimental() ? [{ href: "/global-store", label: "Store", match: "/global-store" }] : []),
    { href: "/templates", label: "Templates", match: "/templates" },
    { href: "/analytics/tokens", label: "Analytics", match: "/analytics" },
    { href: "/logs", label: "Logs", match: "/logs" },
    { href: "/help", label: "Help", match: "/help" },
  ];

  const links = navItems.map((item) => {
    const active = data.currentPath === item.match || data.currentPath.startsWith(item.match + "/");
    return `<a href="${item.href}" class="sk-dropdown__item${active ? " sk-text" : ""}">${item.label}</a>`;
  }).join("");

  // Daemon status + pause/resume controls are temporarily hidden from the top bar.
  // Kept here as comments so the wiring is easy to restore.
  // const daemonText = `<span class="sk-muted sk-text-xs">Daemon: ${escapeHtml(data.daemonState)} ${uptimeStr}</span>`;
  // const daemonButton = data.daemonState !== "paused"
  //   ? `<button class="sk-btn sk-btn--sm" hx-post="/api/daemon/pause" hx-swap="none">Pause</button>`
  //   : `<button class="sk-btn sk-btn--sm sk-btn--primary" hx-post="/api/daemon/resume" hx-swap="none">Resume</button>`;
  void uptimeStr; // suppress unused warning while daemon strip is hidden

  return `<nav class="sk-navbar">
    <div class="sk-navbar__left">
      <button class="sk-navbar__hamburger" data-sk-sidebar-toggle aria-label="Open task list" title="Tasks">&#x2630;</button>
      <a href="/" class="sk-navbar__brand" style="display:flex;align-items:center;"><img src="/icon2.png" alt="Skipper" style="height:24px;vertical-align:middle;margin-right:0.5rem;"><h2 style="display:inline;margin:0;text-transform:lowercase">Skipper</h2></a>
    </div>
    <div class="sk-navbar__right">
      ${escalationCountFragment(data.escalationCount)}
      <a href="/games/asteroids" class="sk-navbar__game-btn" title="Asteroids">🎲</a>
      <span class="sk-navbar__monkey-toggle mc-mobile-hide" id="monkey-toggle" title="Toggle Greg"
        onclick="const on=this.dataset.enabled!=='false';this.dataset.enabled=on?'false':'true';this.style.opacity=on?'0.5':'1';window.dispatchEvent(new CustomEvent('monkey-toggle',{detail:{enabled:!on}}));localStorage.setItem('monkey-enabled',!on)">🐒</span>
      ${data.zenModeEnabled !== undefined ? `<span class="sk-navbar__monkey-toggle mc-mobile-hide" id="zen-mode-toggle" title="Zen Mode"
        style="opacity:${data.zenModeEnabled ? "1" : "0.5"}"
        hx-post="/api/settings/zen-mode" hx-vals='${JSON.stringify({ enabled: data.zenModeEnabled ? "false" : "true" })}'
        hx-swap="none" hx-on::after-request="window.location.reload()">🪷</span>` : ""}
      ${themePickerFragment()}
      ${data.showChatToggle ? `<button class="mc-chat-toggle" data-sk-chat-toggle title="Toggle Chat Panel">Chat</button>` : ""}
      <div class="sk-dropdown" data-sk-dropdown>
        <button class="sk-btn sk-btn--sm" aria-label="Navigation">Menu</button>
        <div class="sk-dropdown__menu">${links}</div>
      </div>
    </div>
  </nav>`;
}
