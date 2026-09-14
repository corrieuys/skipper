// Sources for `w` (web view) nodes on a glyph screen. The model writes what it
// wants to show; this module turns that into a URL the overlay can load and
// refuses anything outside the task's reach:
//
//   artifact:<name>       latest version of a task artifact — an image or other
//                         file artifact via /api/artifacts/:id/file, an inline
//                         html/markdown artifact via /api/artifacts/:id/view
//   /abs/path or ~/path   a file the agents produced, served by
//                         /glyph-local/<taskId>/<abs path> ONLY when it lies
//                         inside the task's working directory or its artifact
//                         store (relative assets next to an html file resolve
//                         through the same route, so a prototype page works)
//   https://...           passed through (the site must allow framing)
//
// Image sources carry `?glyph=image` so the browser renders an <img> instead
// of an <iframe>.

import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { ProtocolError, isContainer, type UNode } from "./protocol";
import { getArtifactsRoot, taskArtifactDir } from "../orchestrator/artifact-files";

export interface ResolvedSource {
  url: string;
  kind: "image" | "page" | "external";
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]);

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.has(extname(p).toLowerCase());
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

/** URL for a local file under the task's allowed roots. */
export function glyphLocalUrl(taskId: string, absPath: string): string {
  const encoded = absPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/glyph-local/${encodeURIComponent(taskId)}/${encoded}${isImagePath(absPath) ? "?glyph=image" : ""}`;
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** The directories a task may show files from: its working directory and its artifact store. */
export function allowedRoots(db: Database, taskId: string): string[] {
  const roots: string[] = [];
  const row = db.prepare("SELECT working_directory FROM tasks WHERE id = ?").get(taskId) as { working_directory: string | null } | null;
  if (!row) return roots;
  for (const dir of [row.working_directory ?? "", taskArtifactDir(getArtifactsRoot(), taskId)]) {
    if (!dir.trim()) continue;
    try {
      roots.push(realpathSync(resolve(expandHome(dir))));
    } catch {
      /* directory does not exist (yet): nothing to allow */
    }
  }
  return roots;
}

/**
 * Absolute, symlink-resolved path of an existing regular file the task may
 * serve, or null when it is missing or outside every allowed root.
 */
export function resolveAllowedFile(db: Database, taskId: string, rawPath: string): string | null {
  let real: string;
  try {
    real = realpathSync(resolve(expandHome(rawPath)));
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return allowedRoots(db, taskId).some((root) => within(root, real)) ? real : null;
}

interface ArtifactRow {
  id: string;
  name: string;
  storage: string;
  mime: string | null;
  format: string | null;
  kind: string;
}

function latestArtifactByName(db: Database, taskId: string, name: string): ArtifactRow | null {
  return db.prepare(
    `SELECT id, name, storage, mime, format, kind FROM task_artifacts
     WHERE task_id = ? AND name = ? AND deleted_at IS NULL
     ORDER BY version DESC LIMIT 1`,
  ).get(taskId, name) as ArtifactRow | null;
}

const ACCEPTED = "accepted forms: artifact:<name> (a task artifact), an absolute path or ~/path to a file inside the task's working directory, or an https:// url";

/** Resolve one `w` source text. Throws ProtocolError with a model-facing reason. */
export function resolveGlyphSource(db: Database, taskId: string, text: string): ResolvedSource {
  const s = text.trim();
  if (!s) throw new ProtocolError(`empty web view source; ${ACCEPTED}`, -1);

  if (s.startsWith("artifact:")) {
    const name = s.slice("artifact:".length).trim();
    const a = latestArtifactByName(db, taskId, name);
    if (!a) {
      const names = (db.prepare("SELECT DISTINCT name FROM task_artifacts WHERE task_id = ? AND deleted_at IS NULL ORDER BY name").all(taskId) as { name: string }[]).map((r) => r.name);
      throw new ProtocolError(`no artifact named '${name}' on this task${names.length ? ` (artifacts: ${names.join(", ")})` : " (it has no artifacts)"}`, -1);
    }
    if (a.storage === "file") {
      const image = !!a.mime && a.mime.startsWith("image/");
      return { url: `/api/artifacts/${encodeURIComponent(a.id)}/file${image ? "?glyph=image" : ""}`, kind: image ? "image" : "page" };
    }
    return { url: `/api/artifacts/${encodeURIComponent(a.id)}/view`, kind: "page" };
  }

  if (/^https?:\/\//i.test(s)) return { url: s, kind: "external" };

  if (s.startsWith("/") || s.startsWith("~/")) {
    const real = resolveAllowedFile(db, taskId, s);
    if (!real) {
      const roots = allowedRoots(db, taskId);
      throw new ProtocolError(
        `cannot show '${s}': the file must exist and lie inside ${roots.length ? roots.join(" or ") : "the task's working directory (this task has none)"}`,
        -1,
      );
    }
    return { url: glyphLocalUrl(taskId, real), kind: isImagePath(real) ? "image" : "page" };
  }

  throw new ProtocolError(`unsupported web view source '${s}'; ${ACCEPTED}`, -1);
}

/** Every `w` node's text in the tree, in order. */
export function webSources(root: UNode | null): string[] {
  const out: string[] = [];
  const walk = (n: UNode): void => {
    if (n.type === "w") out.push(n.text ?? "");
    if (isContainer(n.type)) for (const ch of n.children) walk(ch);
  };
  if (root) walk(root);
  return out;
}
