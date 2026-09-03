import type { Database } from "bun:sqlite";
import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { isExperimental } from "../../config/feature-flags";
import { formatBytes } from "../../orchestrator/artifact-files";

/**
 * Shared artifact-list renderer for the v2 UI: one row per artifact name with
 * the main link opening the LATEST version, plus an expandable sub-list of
 * every version (each opening that exact version). Used by the fragment route
 * and the WS live-push so the two never drift.
 *
 * The list is headed by the "Add artifact" upload form (file input, optional
 * description); `skipper.js` posts it as multipart to
 * POST /api/tasks/:id/artifacts/upload and the `artifact:created` push
 * re-renders this list. File artifacts (storage 'file') render as a typed row
 * with size, and images carry a lazy thumbnail served from
 * /api/artifacts/:id/file.
 */

export interface ArtifactListVariant {
  routePrefix: string;
  openFn: string;
  target: string;
  listId: (taskId: string) => string;
}

/** The command-center rail variant, shared by the fragment route, the WS push and the upload route. */
export const PRIMARY_ARTIFACT_LIST_VARIANT: ArtifactListVariant = {
  routePrefix: "/fragments/tasks",
  openFn: "skOpenArtifactPanel",
  target: "#sk-artifact-detail",
  listId: (id) => `mc-artifacts-${id}`,
};

interface VersionRow {
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  created_at: string;
  deleted_at: string | null;
  published_at: string | null;
  storage: string;
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
}

function openLink(variant: ArtifactListVariant, taskId: string, name: string, version?: number): string {
  const versionQuery = version === undefined ? "" : `?version=${version}`;
  return `onclick="${variant.openFn}(); return false;" hx-get="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(name)}${versionQuery}" hx-target="${variant.target}" hx-swap="innerHTML"`;
}

export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime && mime.startsWith("image/");
}

/** Small glyph for a file artifact row, by mime. */
export function fileArtifactIcon(mime: string | null): string {
  if (isImageMime(mime)) return "&#128444;";
  if (mime === "application/pdf") return "&#128462;";
  if (mime?.startsWith("text/") || mime === "application/json") return "&#128196;";
  if (mime?.startsWith("audio/")) return "&#127925;";
  if (mime?.startsWith("video/")) return "&#127909;";
  return "&#128206;";
}

export function artifactUploadForm(taskId: string): string {
  const eid = escapeHtml(taskId);
  return `<form class="tc-art-upload" data-sk-artifact-upload="${eid}" action="/api/tasks/${eid}/artifacts/upload" method="post" enctype="multipart/form-data">
    <label class="tc-art-upload__pick">
      <input type="file" name="file" multiple class="tc-art-upload__file">
      <span class="tc-art-upload__pick-label">Choose files</span>
      <span class="tc-art-upload__picked" data-sk-upload-picked></span>
    </label>
    <input type="text" name="description" class="tc-art-upload__desc" placeholder="Optional description or caption" maxlength="500">
    <button type="submit" class="tc-art-upload__btn" title="Attach pictures or files; they reach the agent as artifacts">Add artifact</button>
    <span class="tc-art-upload__status" data-sk-upload-status hidden></span>
  </form>`;
}

export function artifactListFragment(db: Database, taskId: string, variant: ArtifactListVariant): string {
  const rows = db.prepare(
    `SELECT id, name, version, kind, description, created_at, deleted_at, published_at,
            storage, mime, bytes, width, height
     FROM task_artifacts
     WHERE task_id = ?
     ORDER BY name, version DESC`,
  ).all(taskId) as VersionRow[];

  const form = artifactUploadForm(taskId);

  if (rows.length === 0) {
    return `${form}<p class="muted" style="padding: var(--sk-space-2);">No artifacts yet.</p>`;
  }

  // Group versions per name; order groups by their latest version's created_at.
  const groups = new Map<string, VersionRow[]>();
  for (const r of rows) {
    const list = groups.get(r.name) ?? [];
    list.push(r);
    groups.set(r.name, list);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => (b[0]?.created_at ?? "").localeCompare(a[0]?.created_at ?? ""))
    .slice(0, 50);

  const showPublished = isExperimental();
  const listTarget = `#${escapeHtml(variant.listId(taskId))}`;

  const items = ordered.map((versions) => {
    const latest = versions[0]!;
    const isDeleted = !!latest.deleted_at;
    const hasPublished = versions.some((v) => v.published_at != null);
    const isFile = latest.storage === "file";
    const isImage = isFile && isImageMime(latest.mime);

    const actionAttrs = (action: "delete" | "restore") =>
      `hx-post="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(latest.name)}/${action}" hx-target="${listTarget}" hx-swap="innerHTML"`;
    const rowAction = isDeleted
      ? `<button type="button" class="tc-art__action" title="Restore this artifact" ${actionAttrs("restore")}>Restore</button>`
      : `<button type="button" class="tc-art__action" title="Delete this artifact (removes it from agent context)" ${actionAttrs("delete")}>Delete</button>`;

    const versionRows = versions.map((v) => {
      const current = v.version === latest.version;
      const publishedMark = showPublished && v.published_at ? ` <span title="Published">&#128279;</span>` : "";
      const sizeMark = v.storage === "file" ? ` <span class="tc-art__ver-time">${escapeHtml(formatBytes(v.bytes))}</span>` : "";
      return `<a href="#" class="tc-art__ver${current ? " tc-art__ver--latest" : ""}" ${openLink(variant, taskId, v.name, v.version)}>
        <span class="tc-art__ver-n">v${v.version}${publishedMark}</span>${sizeMark}
        <span class="tc-art__ver-time">${formatTimestamp(v.created_at)}</span>
        ${current ? `<span class="tc-art__ver-tag">latest</span>` : ""}
      </a>`;
    }).join("");

    const icon = isFile ? `<span class="tc-art__icon" aria-hidden="true">${fileArtifactIcon(latest.mime)}</span>` : "";
    const meta = isFile
      ? `${escapeHtml(latest.mime ?? "file")}${latest.bytes != null ? ` &middot; ${escapeHtml(formatBytes(latest.bytes))}` : ""}${isImage && latest.width && latest.height ? ` &middot; ${latest.width}&times;${latest.height}` : ""} &middot; v${latest.version} &middot; ${formatTimestamp(latest.created_at)}`
      : `${escapeHtml(latest.kind)} &middot; v${latest.version} &middot; ${formatTimestamp(latest.created_at)}`;
    const thumb = isImage
      ? `<a href="#" class="tc-art__thumb" ${openLink(variant, taskId, latest.name)}><img loading="lazy" src="/api/artifacts/${escapeHtml(latest.id)}/file" alt="${escapeHtml(latest.name)}"></a>`
      : "";
    const caption = isFile && latest.description ? `<div class="tc-art__caption">${escapeHtml(latest.description)}</div>` : "";

    return `<div class="tc-art${isDeleted ? " tc-art--deleted" : ""}${isFile ? " tc-art--file" : ""}" data-artifact-id="${escapeHtml(latest.id)}">
      <div class="tc-art__main">
        ${icon}<a href="#" class="tc-art__name" ${openLink(variant, taskId, latest.name)}>${escapeHtml(latest.name)}</a>
        ${isDeleted ? `<span class="tc-art__badge tc-art__badge--deleted" title="Deleted, excluded from agent context">deleted</span>` : ""}
        ${showPublished && hasPublished ? `<span class="tc-art__badge" title="Has a published version">published</span>` : ""}
        ${rowAction}
      </div>
      <div class="tc-art__meta">${meta}</div>
      ${thumb}${caption}
      ${versions.length > 1 ? `<details class="tc-art__versions">
        <summary>${versions.length} versions</summary>
        <div class="tc-art__verlist">${versionRows}</div>
      </details>` : ""}
    </div>`;
  }).join("");

  return `${form}<div class="tc-artlist">${items}</div>`;
}
