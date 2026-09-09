import { escapeHtml } from "../atoms/escape-html";
import { formatBytes } from "../../orchestrator/artifact-files";
import { LOCAL_EMBEDDING_MODELS } from "../../task-memory/catalogue";
import type { LocalServerStatus } from "../../task-memory/local-server";
import type { TaskMemoryConfig } from "../../task-memory/settings";

/**
 * Config page panel for task memory (experimental): which embeddings endpoint
 * to use, and for the managed local server its download / run controls. The
 * status block is its own fragment so the page can poll it while a download
 * runs (`GET /api/config/task-memory/status`).
 */

export interface TaskMemoryPanelData {
  config: TaskMemoryConfig;
  local: LocalServerStatus;
  /** Why no embedder resolves right now, or null when ready. */
  unavailable: string | null;
  lastEmbedError: string | null;
}

function dot(color: string): string {
  return `<span style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;margin-right:5px;"></span>`;
}

export function taskMemoryStatusFragment(data: TaskMemoryPanelData): string {
  const { local, config } = data;
  const lines: string[] = [];
  const isLocal = config.endpoint === "local";

  if (isLocal) {
    if (!local.platformSupported) {
      lines.push(`${dot("var(--sk-danger, #c66)")}No prebuilt llama.cpp binary for this platform. Use a custom endpoint.`);
    } else {
      lines.push(local.binaryInstalled
        ? `${dot("var(--sk-accent-tertiary)")}Server binary installed (llama.cpp ${escapeHtml(local.binaryTag ?? "")})`
        : `${dot("var(--sk-text-subtle)")}Server binary not downloaded`);
      lines.push(local.modelInstalled
        ? `${dot("var(--sk-accent-tertiary)")}Model ${escapeHtml(local.modelId)} downloaded`
        : `${dot("var(--sk-text-subtle)")}Model ${escapeHtml(local.modelId)} not downloaded`);
      lines.push(local.running
        ? `${dot("var(--sk-accent-tertiary)")}Server running at ${escapeHtml(local.endpoint ?? "")}`
        : local.starting
          ? `${dot("var(--sk-accent, #69c)")}Server starting (loading the model)...`
          : `${dot("var(--sk-text-subtle)")}Server stopped (starts on first use)`);
    }
    if (local.download) {
      const pct = local.download.total ? Math.min(100, Math.round((local.download.received / local.download.total) * 100)) : null;
      const size = local.download.total ? `${formatBytes(local.download.received)} / ${formatBytes(local.download.total)}` : formatBytes(local.download.received);
      lines.push(`${dot("var(--sk-accent, #69c)")}Downloading ${escapeHtml(local.download.what)}: ${size}${pct !== null ? ` (${pct}%)` : ""}`);
    }
    if (local.lastError) lines.push(`${dot("var(--sk-danger, #c66)")}${escapeHtml(local.lastError)}`);
  } else {
    lines.push(data.unavailable
      ? `${dot("var(--sk-text-subtle)")}${escapeHtml(data.unavailable)}`
      : `${dot("var(--sk-accent-tertiary)")}Custom endpoint configured: ${escapeHtml(config.customBaseUrl)} (${escapeHtml(config.customModel)})`);
  }
  if (data.lastEmbedError) lines.push(`${dot("var(--sk-danger, #c66)")}Last embedding error: ${escapeHtml(data.lastEmbedError)}`);

  const busy = !!local.download || local.starting;
  const canDownload = isLocal && local.platformSupported && !busy && !(local.binaryInstalled && local.modelInstalled);
  // Buttons disable themselves for the request's duration so a click always shows.
  const btn = (path: string, label: string, primary = false) =>
    `<button type="button" class="sk-btn sk-btn--sm${primary ? " sk-btn--primary" : ""}" hx-post="${path}" hx-target="#task-memory-status" hx-swap="outerHTML" hx-disabled-elt="this">${label}</button>`;
  const buttons: string[] = [];
  if (isLocal && local.platformSupported) {
    if (canDownload) buttons.push(btn("/api/config/task-memory/download", "Download", true));
    if (local.binaryInstalled && local.modelInstalled && !busy) {
      buttons.push(local.running ? btn("/api/config/task-memory/stop", "Stop") : btn("/api/config/task-memory/start", "Start"));
    }
  }

  // Poll while a download or start runs so the status line moves on its own.
  const poll = busy ? ` hx-get="/api/config/task-memory/status" hx-trigger="every 2s" hx-swap="outerHTML"` : "";
  return `<div id="task-memory-status" class="sk-text-xs" style="display:flex;flex-direction:column;gap:var(--sk-space-1);"${poll}>
    ${lines.map((l) => `<div>${l}</div>`).join("")}
    ${buttons.length > 0 ? `<div style="display:flex;gap:var(--sk-space-2);margin-top:var(--sk-space-1);">${buttons.join("")}</div>` : ""}
  </div>`;
}

export function taskMemoryPanel(data: TaskMemoryPanelData): string {
  const { config } = data;
  const modelOpts = LOCAL_EMBEDDING_MODELS
    .map((m) => `<option value="${escapeHtml(m.id)}"${m.id === config.localModelId ? " selected" : ""}>${escapeHtml(m.label)}</option>`)
    .join("");
  const isLocal = config.endpoint === "local";
  return `
      <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Task Memory</span>
        </div>
        <div class="sk-panel__body">
          <p class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-3);">
            Tasks with memory on keep a searchable record of operator input, audio summaries, agent messages, and notes.
            Agents query it with the <code>query_task_memory</code> tool. Entries are embedded with the model below;
            <strong>Local</strong> means Skipper downloads and runs a small llama.cpp embedding server itself.
            Turn memory on per task (the Memory pill on a task, or the checkbox when creating one).
          </p>
          <form hx-post="/api/config/task-memory" hx-swap="none"
            hx-on::after-request="if(event.detail.successful&&event.target===this){window.location.reload();}">
            <div style="display:flex;flex-direction:column;gap:var(--sk-space-3);">
              <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="tm-endpoint">Embeddings</label>
                <select id="tm-endpoint" name="endpoint" class="sk-input sk-input--sm" style="flex:1;"
                  onchange="document.getElementById('tm-local').style.display=this.value==='local'?'':'none';document.getElementById('tm-custom').style.display=this.value==='custom'?'':'none';">
                  <option value="local"${isLocal ? " selected" : ""}>Local (managed by Skipper)</option>
                  <option value="custom"${!isLocal ? " selected" : ""}>Custom OpenAI-compatible endpoint</option>
                </select>
              </div>
              <div id="tm-local" style="display:${isLocal ? "flex" : "none"};align-items:center;gap:var(--sk-space-3);">
                <label class="sk-muted sk-text-xs" style="width:130px;" for="tm-local-model">Model</label>
                <select id="tm-local-model" name="local_model" class="sk-input sk-input--sm" style="flex:1;">${modelOpts}</select>
              </div>
              <div id="tm-custom" style="display:${isLocal ? "none" : "flex"};flex-direction:column;gap:var(--sk-space-3);">
                <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                  <label class="sk-muted sk-text-xs" style="width:130px;" for="tm-base-url">Base URL</label>
                  <input type="text" id="tm-base-url" name="custom_base_url" value="${escapeHtml(config.customBaseUrl)}"
                    placeholder="https://api.openai.com/v1 or http://localhost:11434/v1" class="sk-input sk-input--sm" style="flex:1;">
                </div>
                <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                  <label class="sk-muted sk-text-xs" style="width:130px;" for="tm-api-key">API key</label>
                  <input type="password" id="tm-api-key" name="custom_api_key" autocomplete="off"
                    placeholder="${config.customApiKey ? "(saved, enter to replace)" : "sk-... or ${OPENAI_API_KEY}"}" class="sk-input sk-input--sm" style="flex:1;">
                </div>
                <div style="display:flex;align-items:center;gap:var(--sk-space-3);">
                  <label class="sk-muted sk-text-xs" style="width:130px;" for="tm-custom-model">Model id</label>
                  <input type="text" id="tm-custom-model" name="custom_model" value="${escapeHtml(config.customModel)}"
                    placeholder="text-embedding-3-small" class="sk-input sk-input--sm" style="flex:1;">
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:var(--sk-space-3);">
                <span class="sk-muted sk-text-xs" style="width:130px;">Status</span>
                <div style="flex:1;">${taskMemoryStatusFragment(data)}</div>
              </div>
              <div>
                <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Save</button>
              </div>
            </div>
          </form>
        </div>
      </div>`;
}
