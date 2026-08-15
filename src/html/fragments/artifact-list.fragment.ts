import type { Database } from "bun:sqlite";
import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { isExperimental } from "../../config/feature-flags";

/**
 * Shared artifact-list renderer for the v2 UI: one row per artifact name with
 * the main link opening the LATEST version, plus an expandable sub-list of
 * every version (each opening that exact version). Used by the fragment route
 * and the WS live-push so the two never drift.
 */

export interface ArtifactListVariant {
  routePrefix: string;
  openFn: string;
  target: string;
  listId: (taskId: string) => string;
}

interface VersionRow {
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  created_at: string;
  deleted_at: string | null;
  published_at: string | null;
}

function openLink(variant: ArtifactListVariant, taskId: string, name: string, version?: number): string {
  const versionQuery = version === undefined ? "" : `?version=${version}`;
  return `onclick="${variant.openFn}(); return false;" hx-get="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(name)}${versionQuery}" hx-target="${variant.target}" hx-swap="innerHTML"`;
}

export function artifactListFragment(db: Database, taskId: string, variant: ArtifactListVariant): string {
  const rows = db.prepare(
    `SELECT id, name, version, kind, description, created_at, deleted_at, published_at
     FROM task_artifacts
     WHERE task_id = ?
     ORDER BY name, version DESC`,
  ).all(taskId) as VersionRow[];

  if (rows.length === 0) {
    return `<p class="muted" style="padding: var(--sk-space-2);">No artifacts yet.</p>`;
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

    const actionAttrs = (action: "delete" | "restore") =>
      `hx-post="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(latest.name)}/${action}" hx-target="${listTarget}" hx-swap="innerHTML"`;
    const rowAction = isDeleted
      ? `<button type="button" class="tc-art__action" title="Restore this artifact" ${actionAttrs("restore")}>Restore</button>`
      : `<button type="button" class="tc-art__action" title="Delete this artifact (removes it from agent context)" ${actionAttrs("delete")}>Delete</button>`;

    const versionRows = versions.map((v) => {
      const current = v.version === latest.version;
      const publishedMark = showPublished && v.published_at ? ` <span title="Published">&#128279;</span>` : "";
      return `<a href="#" class="tc-art__ver${current ? " tc-art__ver--latest" : ""}" ${openLink(variant, taskId, v.name, v.version)}>
        <span class="tc-art__ver-n">v${v.version}${publishedMark}</span>
        <span class="tc-art__ver-time">${formatTimestamp(v.created_at)}</span>
        ${current ? `<span class="tc-art__ver-tag">latest</span>` : ""}
      </a>`;
    }).join("");

    return `<div class="tc-art${isDeleted ? " tc-art--deleted" : ""}">
      <div class="tc-art__main">
        <a href="#" class="tc-art__name" ${openLink(variant, taskId, latest.name)}>${escapeHtml(latest.name)}</a>
        ${isDeleted ? `<span class="tc-art__badge tc-art__badge--deleted" title="Deleted, excluded from agent context">deleted</span>` : ""}
        ${showPublished && hasPublished ? `<span class="tc-art__badge" title="Has a published version">published</span>` : ""}
        ${rowAction}
      </div>
      <div class="tc-art__meta">${escapeHtml(latest.kind)} &middot; v${latest.version} &middot; ${formatTimestamp(latest.created_at)}</div>
      ${versions.length > 1 ? `<details class="tc-art__versions">
        <summary>${versions.length} versions</summary>
        <div class="tc-art__verlist">${versionRows}</div>
      </details>` : ""}
    </div>`;
  }).join("");

  return `<div class="tc-artlist">${items}</div>`;
}
