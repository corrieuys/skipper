/**
 * Generate `src/html/public/lucide-icons.json` from the `lucide-static` package.
 *
 * The JSON is a single source used two ways:
 *   - server-side inline render (`src/html/atoms/lucide.ts:lucideSvg`) reads it
 *     via `assetTextSync("public/lucide-icons.json")` to draw a chosen icon.
 *   - the icon picker (browser) fetches `/public/lucide-icons.json` once to build
 *     the searchable grid.
 *
 * It lands under `src/html/public/`, so `gen-assets.ts` embeds it into the
 * compiled binary automatically (no CDN, no node_modules at runtime).
 *
 * Run: `bun run gen:icons` (after bumping the lucide-static devDependency).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const ICONS_DIR = join(REPO, "node_modules", "lucide-static", "icons");
const TAGS_PATH = join(REPO, "node_modules", "lucide-static", "tags.json");
const OUT_PATH = join(REPO, "src", "html", "public", "lucide-icons.json");

// Shown first, before the user types a search. Common, recognisable glyphs for
// teams / tasks / recurring runs. Any id absent from the set is simply skipped.
const POPULAR = [
  "rocket", "star", "flag", "target", "zap", "flame", "sparkles", "wand",
  "folder", "folder-git-2", "briefcase", "package", "box", "layers", "boxes",
  "calendar", "calendar-clock", "clock", "timer", "alarm-clock", "repeat", "refresh-cw",
  "check-check", "list-checks", "clipboard-list", "kanban", "workflow", "git-branch",
  "code", "terminal", "bug", "wrench", "hammer", "settings", "cpu", "database",
  "server", "cloud", "globe", "network", "shield", "lock", "key",
  "bot", "users", "user", "message-square", "bell", "mail", "megaphone",
  "book", "book-open", "file-text", "pen-tool", "palette", "image", "camera",
  "chart-line", "chart-bar", "chart-pie", "trending-up", "activity", "gauge",
  "heart", "bookmark", "pin", "map", "compass", "anchor", "ship", "plane",
  "music", "video", "mic", "headphones", "gamepad-2", "puzzle", "gift", "coffee",
  "leaf", "sun", "moon", "cloud-lightning", "droplet", "mountain", "trees",
];

function innerSvg(raw: string): string {
  // Strip the license comment, then take everything between the outer <svg …> and
  // </svg>. Lucide bodies are <path>/<circle>/<line> elements with stroke geometry.
  const open = raw.indexOf(">", raw.indexOf("<svg"));
  const close = raw.lastIndexOf("</svg>");
  if (open === -1 || close === -1) return "";
  return raw
    .slice(open + 1, close)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const tags = JSON.parse(readFileSync(TAGS_PATH, "utf8")) as Record<string, string[]>;

const icons: Record<string, string> = {};
const keywords: Record<string, string[]> = {};

for (const file of readdirSync(ICONS_DIR)) {
  if (!file.endsWith(".svg")) continue;
  const id = file.slice(0, -4);
  const inner = innerSvg(readFileSync(join(ICONS_DIR, file), "utf8"));
  if (!inner) continue;
  icons[id] = inner;
  const kw = tags[id];
  if (Array.isArray(kw) && kw.length > 0) keywords[id] = kw;
}

const popular = POPULAR.filter((id) => id in icons);

const out = {
  version: JSON.parse(readFileSync(join(REPO, "node_modules", "lucide-static", "package.json"), "utf8")).version,
  count: Object.keys(icons).length,
  popular,
  icons,
  keywords,
};

writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`lucide-icons.json: ${out.count} icons, ${popular.length} popular, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB -> ${OUT_PATH}`);
