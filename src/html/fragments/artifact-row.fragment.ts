import { escapeHtml } from "../atoms/escape-html";

export interface ArtifactRowData {
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  created_at: string;
  taskId: string;
}

export function artifactRowFragment(a: ArtifactRowData): string {
  return `<tr>
    <td><a href="#" onclick="openTaskArtifactModal(); return false;"
           hx-get="/fragments/tasks/${escapeHtml(a.taskId)}/artifacts/${encodeURIComponent(a.name)}"
           hx-target="#task-artifact-modal-body"
           hx-swap="innerHTML">${escapeHtml(a.name)}</a></td>
    <td>${escapeHtml(a.kind)}</td>
    <td>v${a.version}</td>
    <td class="sk-muted sk-text-xs">${escapeHtml(a.description ?? "")}</td>
  </tr>`;
}
