import { DaemonStatus, escapeHtml } from "./components";
import { navDropdownHtml } from "./navDropdownHtml";
import { daemonControlFragment } from "./daemonControlFragment";
import { themeBootScript, themePickerFragment, appearanceBackgroundCss } from "./styles/themes";
import { STYLESHEET_PATH } from "./styles/stylesheet";
import { getAppearanceConfig } from "../config/store";
import { getDb } from "../db/connection";


export function layout(
  title: string,
  content: string,
  currentPath: string = "/",
  daemonStatus?: DaemonStatus,
  wsTopics?: string[],
): string {
  const isDashboardPage = currentPath === "/";
  const mainClassName = isDashboardPage
    ? "container container-dashboard"
    : "container";

  const appearance = getAppearanceConfig(getDb());
  const appearanceCss = appearanceBackgroundCss(appearance.active);

  const daemonControl = daemonStatus
    ? daemonControlFragment(daemonStatus, true)
    : `<div id="daemon-global-control"
      class="daemon-card daemon-killswitch daemon-killswitch-nav"
      hx-get="/fragments/daemon/control"
      hx-trigger="load"
      hx-swap="outerHTML">
    <span class="muted">Loading daemon control...</span>
  </div>`;

  // Close dropdown when clicking outside
  const closeDropdownScript = `<script>
    (function() {
      if (window.__navDropdownInit) return;
      window.__navDropdownInit = true;
      document.addEventListener('click', function(e) {
        const dropdown = document.querySelector('.nav-dropdown');
        if (dropdown && !dropdown.contains(e.target)) {
          dropdown.classList.remove('open');
          const toggle = dropdown.querySelector('.nav-dropdown-toggle');
          if (toggle) toggle.setAttribute('aria-expanded', 'false');
        }
      });
    })();
  </script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Skipper</title>
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <script>${themeBootScript()}</script>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-ws@2.0.4/ws.js"></script>
  <script src="/ws-subscribe.js"></script>
  <script src="https://unpkg.com/marked@15.0.7/marked.min.js"></script>
  <script>
    if ("scrollRestoration" in history) {
      history.scrollRestoration = "manual";
    }
    document.addEventListener("htmx:afterSwap", (event) => {
      if (event.detail && event.detail.target === document.body) {
        requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
      }
    });
  </script>
  <link rel="stylesheet" href="${STYLESHEET_PATH}">
  ${appearanceCss ? `<style>${appearanceCss}</style>` : ""}
</head>
<body hx-ext="ws" ws-connect="/ws/ui"${wsTopics && wsTopics.length > 0 ? ` data-ws-topics="${wsTopics.join(",")}"` : ""}>
  <nav class="navbar">
    <div class="navbar-left">
      ${navDropdownHtml(currentPath)}
      <a href="/" class="brand">Skipper</a>
    </div>
    <div class="navbar-daemon-slot">
      ${themePickerFragment()}
      ${daemonControl}
    </div>
  </nav>
  <div class="htmx-indicator loading-bar"></div>
  <main class="${mainClassName}">${content}</main>
  ${closeDropdownScript}
</body>
</html>`;
}
