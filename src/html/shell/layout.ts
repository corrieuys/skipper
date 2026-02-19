import { escapeHtml } from "../atoms/escape-html";
import { appearanceBackgroundCss } from "../styles/index";
import { themeBootScript } from "../styles/themes";
import { STYLESHEET_PATH } from "../styles/stylesheet";
import { getAppearanceConfig } from "../../config/store";

/**
 * New layout shell for v2 pages.
 * Uses sk- design tokens alongside backward-compatible old styles.
 */
export function v2layout(
  title: string,
  content: string,
  currentPath: string = "/",
  wsTopics: string[] = [],
): string {
  const topicsAttr = wsTopics.length > 0 ? ` data-ws-topics="${wsTopics.join(",")}"` : "";
  const appearance = getAppearanceConfig();
  const appearanceCss = appearanceBackgroundCss(appearance.active);

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
  <script src="https://unpkg.com/marked@15.0.7/marked.min.js"></script>
  <script src="/skipper.js"></script>
  <script src="/ws-subscribe.js"></script>
  <script src="/monkey.js" defer></script>
  <link rel="stylesheet" href="${STYLESHEET_PATH}">
  ${appearanceCss ? `<style>${appearanceCss}</style>` : ""}
</head>
<body hx-ext="ws" ws-connect="/ws/ui"${topicsAttr}>
  ${content}
</body>
</html>`;
}
