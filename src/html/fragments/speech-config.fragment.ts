import { escapeHtml } from "../atoms/escape-html";
import { formatBytes } from "../../orchestrator/artifact-files";
import { findSpeechModel, SPEAKER_MODEL, SPEECH_MODELS, type SpeechModel } from "../../speech/catalogue";
import type { SpeechEngineStatus } from "../../speech/engine-manager";

/**
 * Config page rows for the transcription provider and the local speech model
 * (experimental), inside the Real-time transcription panel. Every control posts
 * to /api/realtime/config on change (ids start with `rt-cfg-`, so the route
 * answers in place). The status block is its own fragment so the page can poll
 * it while a download or a server start runs (`GET /api/config/speech/status`).
 */

export interface SpeechPanelData {
  provider: "local" | "openai";
  openaiModel: string;
  speakerLabels: boolean;
  status: SpeechEngineStatus;
}

const ENGINE_NAMES = { whisper: "whisper.cpp", nemo: "NeMo-Speech.cpp" } as const;

function dot(color: string): string {
  return `<span style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;margin-right:5px;"></span>`;
}

const OK = "var(--sk-accent-tertiary)";
const IDLE = "var(--sk-text-subtle)";
const BUSY = "var(--sk-accent, #69c)";
const BAD = "var(--sk-danger, #c66)";

export function speechStatusFragment(status: SpeechEngineStatus): string {
  const model = findSpeechModel(status.modelId);
  const lines: string[] = [];
  const engineName = ENGINE_NAMES[status.engine];

  if (status.binaryInstalled) {
    lines.push(`${dot(OK)}${engineName} installed <span class="sk-muted">(${escapeHtml(status.binaryPath ?? "")})</span>`);
  } else if (status.binaryInstallable) {
    lines.push(`${dot(IDLE)}${engineName} not downloaded`);
  } else {
    lines.push(`${dot(BAD)}${escapeHtml(status.binaryHint ?? `${engineName} not installed`)}`);
  }
  if (model) {
    lines.push(status.modelInstalled
      ? `${dot(OK)}${escapeHtml(model.label)} downloaded`
      : `${dot(IDLE)}${escapeHtml(model.label)} not downloaded (${formatBytes(model.bytes)})`);
  }
  if (status.speakersWanted) {
    lines.push(status.speakerModelInstalled
      ? `${dot(OK)}${escapeHtml(SPEAKER_MODEL.label)} downloaded`
      : `${dot(IDLE)}${escapeHtml(SPEAKER_MODEL.label)} not downloaded (${formatBytes(SPEAKER_MODEL.bytes)})`);
  }
  if (status.running) {
    const running = findSpeechModel(status.runningModelId);
    lines.push(`${dot(OK)}Running ${escapeHtml(running?.label ?? status.runningModelId ?? "")} at ${escapeHtml(status.endpoint ?? "")}`);
  } else if (status.starting) {
    lines.push(`${dot(BUSY)}Starting (loading the model)...`);
  } else {
    lines.push(`${dot(IDLE)}Stopped (starts when a recording or dictation starts)`);
  }
  if (status.download) {
    const d = status.download;
    const pct = d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : null;
    const size = d.total ? `${formatBytes(d.received)} / ${formatBytes(d.total)}` : formatBytes(d.received);
    lines.push(`${dot(BUSY)}Downloading ${escapeHtml(d.what)}: ${size}${pct !== null ? ` (${pct}%)` : ""}`);
  }
  if (status.lastError) lines.push(`${dot(BAD)}${escapeHtml(status.lastError)}`);

  const busy = !!status.download || status.starting;
  const missing = (!status.binaryInstalled && status.binaryInstallable)
    || !status.modelInstalled
    || (status.speakersWanted && !status.speakerModelInstalled);
  const button = missing && !busy
    ? `<div style="margin-top:var(--sk-space-1);"><button type="button" class="sk-btn sk-btn--sm sk-btn--primary" hx-post="/api/config/speech/download" hx-target="#speech-status" hx-swap="outerHTML" hx-disabled-elt="this">Download</button></div>`
    : "";

  // Poll while a download or start runs so the status line moves on its own.
  const poll = busy ? ` hx-get="/api/config/speech/status" hx-trigger="every 2s" hx-swap="outerHTML"` : "";
  return `<div id="speech-status" class="sk-text-xs" style="display:flex;flex-direction:column;gap:var(--sk-space-1);"${poll}>
    ${lines.map((l) => `<div>${l}</div>`).join("")}
    ${button}
    ${downloadedList(status)}
  </div>`;
}

/** Models Skipper downloaded, each with a Delete button (in-use models are refused server-side). */
function downloadedList(status: SpeechEngineStatus): string {
  if (status.managedModels.length === 0) return "";
  const total = status.managedModels.reduce((sum, m) => sum + m.bytes, 0);
  const rows = status.managedModels.map((m) => `
      <div style="display:flex;align-items:center;gap:var(--sk-space-2);">
        <span style="flex:1;min-width:0;">${escapeHtml(m.label)} <span class="sk-muted">${formatBytes(m.bytes)}</span></span>
        <button type="button" class="sk-btn sk-btn--sm" hx-post="/api/config/speech/delete" hx-vals='${escapeHtml(JSON.stringify({ model: m.id }))}'
          hx-target="#speech-status" hx-swap="outerHTML" hx-disabled-elt="this"
          hx-confirm="${escapeHtml(`Delete ${m.label} (${formatBytes(m.bytes)})? You can download it again later.`)}">Delete</button>
      </div>`).join("");
  return `<div style="margin-top:var(--sk-space-2);display:flex;flex-direction:column;gap:var(--sk-space-1);">
      <div class="sk-muted">Downloaded models (${formatBytes(total)})</div>${rows}
    </div>`;
}

/**
 * The status fragment plus the model select swapped out-of-band, so the
 * "downloaded" markers in the select follow a download or a delete without a
 * page reload. Route responses use this; the page embeds the parts directly.
 */
export function speechStatusResponse(status: SpeechEngineStatus): string {
  return speechStatusFragment(status) + modelSelect(status, true);
}

function modelOption(m: SpeechModel, selected: boolean, installed: boolean): string {
  const parts = [m.label, formatBytes(m.bytes), m.languages];
  if (m.streaming) parts.push("streams");
  if (m.speakers) parts.push("can label speakers");
  if (installed) parts.push("downloaded");
  return `<option value="${escapeHtml(m.id)}"${selected ? " selected" : ""}>${escapeHtml(parts.join(" · "))}</option>`;
}

// After a model or speaker change, re-read the status block (download state,
// engine restart) without reloading the page.
const REFRESH_STATUS = `hx-on::after-request="htmx.ajax('GET','/api/config/speech/status',{target:'#speech-status',swap:'outerHTML'})"`;

function modelSelect(status: SpeechEngineStatus, oob = false): string {
  const installed = new Set(status.installedIds);
  const group = (engine: SpeechModel["engine"], title: string) =>
    `<optgroup label="${escapeHtml(title)}">${SPEECH_MODELS.filter((m) => m.engine === engine)
      .map((m) => modelOption(m, m.id === status.modelId, installed.has(m.id))).join("")}</optgroup>`;
  return `<select id="rt-cfg-local-model" name="local_model" class="sk-select sk-select--sm" style="flex:1;min-width:0;"${oob ? ` hx-swap-oob="true"` : ""}
                hx-post="/api/realtime/config" hx-trigger="change" hx-swap="none" hx-include="this" ${REFRESH_STATUS}>
                ${group("whisper", "Whisper (whisper.cpp)")}
                ${group("nemo", "NVIDIA (NeMo-Speech.cpp)")}
              </select>`;
}

export function speechConfigRows(data: SpeechPanelData): string {
  const isLocal = data.provider === "local";
  const refreshStatus = REFRESH_STATUS;
  const label = (forId: string, text: string) =>
    `<label class="sk-muted sk-text-xs" style="width:150px;flex-shrink:0;" for="${forId}">${text}</label>`;

  return `
          <div class="sk-flex sk-items-center sk-gap-3" style="margin-top:var(--sk-space-3);">
            ${label("rt-cfg-provider", "Transcription:")}
            <select id="rt-cfg-provider" name="transcription_provider" class="sk-select sk-select--sm" style="width:auto;"
              hx-post="/api/realtime/config" hx-trigger="change" hx-swap="none" hx-include="this"
              onchange="document.getElementById('rt-cfg-local-rows').style.display=this.value==='local'?'flex':'none';document.getElementById('rt-cfg-openai-row').style.display=this.value==='openai'?'flex':'none';">
              <option value="local"${isLocal ? " selected" : ""}>Local model (on this machine)</option>
              <option value="openai"${isLocal ? "" : " selected"}>OpenAI API (needs OPENAI_API_KEY)</option>
            </select>
          </div>
          <div id="rt-cfg-openai-row" class="sk-flex sk-items-center sk-gap-3" style="margin-top:var(--sk-space-3);display:${isLocal ? "none" : "flex"};">
            ${label("rt-cfg-openai-model", "OpenAI model:")}
            <input type="text" id="rt-cfg-openai-model" name="openai_transcription_model" value="${escapeHtml(data.openaiModel)}"
              placeholder="gpt-4o-transcribe" class="sk-input sk-input--sm" style="width:240px;"
              hx-post="/api/realtime/config" hx-trigger="change" hx-swap="none" hx-include="this">
          </div>
          <div id="rt-cfg-local-rows" style="margin-top:var(--sk-space-3);display:${isLocal ? "flex" : "none"};flex-direction:column;gap:var(--sk-space-3);">
            <div class="sk-flex sk-items-center sk-gap-3">
              ${label("rt-cfg-local-model", "Local model:")}
              ${modelSelect(data.status)}
            </div>
            <div class="sk-flex sk-items-center sk-gap-3">
              ${label("rt-cfg-speakers", "Speaker labels:")}
              <select id="rt-cfg-speakers" name="speaker_labels" class="sk-select sk-select--sm" style="width:auto;"
                hx-post="/api/realtime/config" hx-trigger="change" hx-swap="none" hx-include="this" ${refreshStatus}>
                <option value="false"${data.speakerLabels ? "" : " selected"}>Off</option>
                <option value="true"${data.speakerLabels ? " selected" : ""}>On ("Speaker 1: ...")</option>
              </select>
            </div>
            <p class="sk-muted sk-text-xs" style="margin:0;">
              Only models marked "can label speakers" use this (up to 4 speakers). A model marked "streams" runs a whole
              recording through one live session, so text and speaker numbers carry across audio chunks. Other models
              transcribe each chunk alone. Dictation never labels speakers.
            </p>
            <div class="sk-flex sk-gap-3" style="align-items:flex-start;">
              <span class="sk-muted sk-text-xs" style="width:150px;flex-shrink:0;">Status:</span>
              <div style="flex:1;min-width:0;">${speechStatusFragment(data.status)}</div>
            </div>
          </div>`;
}
