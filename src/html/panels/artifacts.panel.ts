import { artifactRowFragment, type ArtifactRowData } from "../fragments/artifact-row.fragment";

export const FRAGMENT_ID = "sk-artifacts";

export function artifactsPanel(taskId: string, artifacts: ArtifactRowData[]): string {
  if (artifacts.length === 0) {
    return `<div id="${FRAGMENT_ID}" class="sk-panel">
      <div class="sk-panel__header">
        <span class="sk-panel__title">Artifacts</span>
        <span class="sk-panel__count">0</span>
      </div>
      <div class="sk-panel__empty">No artifacts yet</div>
    </div>`;
  }

  const rows = artifacts.map((a) => artifactRowFragment(a)).join("");
  return `<div id="${FRAGMENT_ID}" class="sk-panel">
    <div class="sk-panel__header">
      <span class="sk-panel__title">Artifacts</span>
      <span class="sk-panel__count">${artifacts.length}</span>
    </div>
    <div class="sk-panel__body--flush">
      <table class="sk-table"><thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
  </div>`;
}
