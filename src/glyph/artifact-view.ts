// The page a glyph `w"artifact:<name>"` node loads for an INLINE artifact
// (`/api/artifacts/:id/view`). Mirrors the app's own artifact renderers
// (routes/pages.ts:renderArtifactDetail): markdown goes through marked on the
// client with the same options as `[data-artifact-md]` blocks, html is shown
// as-is. Runs inside a same-origin iframe in the overlay, so it copies the
// parent's `--sk-*` tokens onto itself and follows the selected theme; outside
// the overlay it falls back to a plain light/dark scheme.

import { escapeHtml } from "../html/atoms/escape-html";
import { looksLikeHtml } from "../html/atoms/sniff-html";

const MARKED_SRC = "https://unpkg.com/marked@15.0.7/marked.min.js";

const TOKENS = [
  "--sk-text", "--sk-text-muted", "--sk-border", "--sk-accent-primary",
  "--sk-surface-2", "--sk-font-body", "--sk-font-heading", "--sk-font-mono",
];

/** Copies the overlay's theme tokens into the frame; harmless when there is no parent. */
const THEME_SYNC = `<script>(function(){try{if(window.parent===window)return;var cs=getComputedStyle(window.parent.document.documentElement);${JSON.stringify(TOKENS)}.forEach(function(k){var v=cs.getPropertyValue(k);if(v&&v.trim())document.documentElement.style.setProperty(k,v.trim());});}catch(e){}})();</script>`;

const SHELL_CSS = `
:root{color-scheme:light dark;--sk-text:#141a21;--sk-text-muted:#5f6b78;--sk-border:rgba(20,26,33,0.12);--sk-accent-primary:#0e9c85;--sk-surface-2:rgba(20,26,33,0.05);--sk-font-body:"Inter","Segoe UI",system-ui,sans-serif;--sk-font-heading:"Space Grotesk","Segoe UI",system-ui,sans-serif;--sk-font-mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--sk-text:#e6ecf2;--sk-text-muted:#8c98a6;--sk-border:rgba(230,236,242,0.12);--sk-accent-primary:#5fe3c4;--sk-surface-2:rgba(230,236,242,0.06)}}
html,body{margin:0;background:transparent}
body{padding:16px 20px;color:var(--sk-text);font:15px/1.6 var(--sk-font-body);overflow-wrap:anywhere}
.art h1,.art h2,.art h3,.art h4{font-family:var(--sk-font-heading);margin:1rem 0 .5rem;color:var(--sk-text)}
.art h1{font-size:1.4rem;border-bottom:1px solid var(--sk-border);padding-bottom:.3rem}
.art h2{font-size:1.15rem;border-bottom:1px solid var(--sk-border);padding-bottom:.25rem}
.art h3{font-size:1rem}
.art>:first-child{margin-top:0}
.art p{margin:.5rem 0}
.art ul,.art ol{margin:.5rem 0;padding-left:1.5rem}
.art li{margin:.15rem 0}
.art a{color:var(--sk-accent-primary)}
.art blockquote{margin:.75rem 0;padding:.25rem .75rem;border-left:2px solid var(--sk-border);color:var(--sk-text-muted)}
.art code{font-family:var(--sk-font-mono);font-size:.9em;background:var(--sk-surface-2);padding:.1em .35em;border-radius:4px}
.art pre{background:var(--sk-surface-2);border:1px solid var(--sk-border);border-radius:6px;padding:.75rem 1rem;overflow:auto}
.art pre code{background:none;padding:0}
.art table{border-collapse:collapse;margin:.75rem 0;font-size:.95em}
.art th,.art td{border:1px solid var(--sk-border);padding:.35rem .6rem;text-align:left;vertical-align:top}
.art th{color:var(--sk-text-muted);font-weight:600}
.art hr{border:0;border-top:1px solid var(--sk-border);margin:1rem 0}
.art img{max-width:100%}
.art-src{white-space:pre-wrap;font-family:var(--sk-font-mono);font-size:.85rem;line-height:1.5}
`;

function shell(title: string, body: string, extraHead = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${SHELL_CSS}</style>${THEME_SYNC}${extraHead}</head><body>${body}</body></html>`;
}

function isFullDocument(html: string): boolean {
  return /^\s*(<!doctype|<html)/i.test(html);
}

/** The document served for an inline artifact's web view. */
export function artifactViewDocument(name: string, body: string, format: string | null): string {
  const isHtml = format ? format === "html" : looksLikeHtml(body);
  if (isHtml) {
    // A full page (prototype app, report with its own styles) is the agent's;
    // serve it untouched. A fragment gets the shell so it is readable + themed.
    if (isFullDocument(body)) return body;
    return shell(name, `<div class="art">${body}</div>`);
  }
  // Markdown: the escaped source is the fallback view (and what marked reads
  // back via textContent), swapped for rendered html once marked loads.
  const escaped = escapeHtml(body);
  const script = `<script>(function(){var src=document.getElementById("src");var out=document.getElementById("out");if(!src||!out||typeof marked==="undefined")return;try{marked.setOptions({breaks:true,gfm:true});out.innerHTML=marked.parse(src.textContent||"");out.hidden=false;src.hidden=true;}catch(e){}})();</script>`;
  return shell(
    name,
    `<pre id="src" class="art-src">${escaped}</pre><div id="out" class="art" hidden></div><script src="${MARKED_SRC}"></script>${script}`,
  );
}
