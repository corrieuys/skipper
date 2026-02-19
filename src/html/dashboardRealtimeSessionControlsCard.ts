import type { RealtimeConfig } from "../realtime/config";
import { escapeHtml } from "./components";


export function dashboardRealtimeSessionControlsCard(
    task: { id: string; status: string; } | null,
    realtimeConfig?: RealtimeConfig
): string {
    if (!task) return "";
    if (task.status !== "running" && task.status !== "approved") return "";

    const sessionControl = task.status === "approved"
        ? `<div class="cmd-rt-start-row">
        <button
          type="button"
          class="btn-sm"
          hx-post="/api/realtime-tasks/${escapeHtml(task.id)}/start?stay=dashboard"
          hx-swap="none"
          hx-on::after-request="if(event.detail.successful){ htmx.ajax('GET','/', {target:'body', swap:'outerHTML'}); }"
        >Start Session</button>
        <span class="muted" style="font-size:0.75rem;">Start to enable live input and recording.</span>
      </div>`
        : "";

    const composer = task.status === "running"
        ? `<form hx-post="/api/realtime-tasks/${escapeHtml(task.id)}/input"
        hx-swap="none"
        hx-on::after-request="if(event.detail.successful) this.reset()"
        class="cmd-rt-compose">
      <input type="text" name="text" placeholder="Send message to session..." required autocomplete="off" />
      <button type="submit" class="btn-sm cmd-rt-send-btn">Send</button>
    </form>
    <div class="cmd-rt-recorder">
      <button id="btn-start-recording" onclick="startRealtimeAudio('${escapeHtml(task.id)}', ${realtimeConfig?.cadence_seconds ?? 30}, ${realtimeConfig?.overlap_seconds ?? 5})" class="btn-sm cmd-rt-record-btn">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
        Record
      </button>
      <button id="btn-stop-recording" onclick="stopRealtimeAudio()" class="btn-sm btn-danger cmd-rt-stop-btn" style="display:none;">Stop</button>
      <span id="audio-status" class="muted cmd-rt-status"></span>
    </div>
    <div id="audio-visualizer-wrap" class="cmd-rt-visualizer-wrap" style="display:none;">
      <canvas id="audio-visualizer" width="800" height="48" class="cmd-rt-visualizer"></canvas>
    </div>
    <script src="/realtime-audio.js"></script>`
        : "";

    return `<div class="cmd-panel cmd-layout-rt-controls">
    <div class="cmd-panel-header">
      <span class="cmd-panel-title">Session Controls</span>
      <span class="cmd-panel-count">${task.status}</span>
    </div>
    <div class="cmd-panel-body cmd-rt-controls-body">
      ${sessionControl}
      ${composer}
    </div>
  </div>`;
}
