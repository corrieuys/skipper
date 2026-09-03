import { join } from "node:path";
import { rmSync } from "node:fs";
import { getDataDir } from "../paths";
import { IMAGE_EXTENSIONS } from "./image-meta";

/**
 * On-disk layout for file artifacts: `<data dir>/artifacts/<taskId>/<artifactId>.<ext>`.
 * Bytes are written once and never modified; the artifact id is the cache key.
 * Kept apart from ArtifactManager so TaskScheduler.deleteTask can sweep a
 * task's folder without pulling the manager in.
 */
export function getArtifactsRoot(): string {
  return join(getDataDir(), "artifacts");
}

export function taskArtifactDir(root: string, taskId: string): string {
  return join(root, taskId);
}

/** Remove every file artifact stored for a task (best effort, idempotent). */
export function removeTaskArtifactFiles(taskId: string, root: string = getArtifactsRoot()): void {
  try {
    rmSync(taskArtifactDir(root, taskId), { recursive: true, force: true });
  } catch {
    // best effort: a missing or unreadable folder is not a delete failure
  }
}

/**
 * Original filename, reduced to something safe as a path segment and as the
 * artifact `name` (versioning key). Keeps letters, digits, dot, dash,
 * underscore; collapses everything else to `_`; strips leading dots.
 */
export function sanitizeArtifactFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "file";
}

const MIME_EXTENSIONS: Record<string, string> = {
  ...IMAGE_EXTENSIONS,
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
};

const EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  log: "text/plain",
  html: "text/html",
};

/** Mime guessed from a filename's extension for common types, else null (caller falls back to octet-stream). */
export function mimeFromExtension(name: string): string | null {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? (EXTENSION_MIMES[m[1]!.toLowerCase()] ?? null) : null;
}

/** Extension for the stored file: the (sanitised) filename's, else one derived from the mime, else `bin`. */
export function fileExtensionFor(name: string, mime: string | null): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (m) return m[1]!.toLowerCase();
  return (mime && MIME_EXTENSIONS[mime]) || "bin";
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
