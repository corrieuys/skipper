import { type TaskData, escapeHtml } from "./components";


export function realtimeTaskPanels(task: TaskData): string {
    const taskId = escapeHtml(task.id);
    const isRunning = task.status === "running";

    // Session controls
    const sessionControls = isRunning
        ? `
    <div class="card">
      <div class="section-heading"><div><h2>Real-Time Session</h2></div></div>
      <div class="form-actions">
        <button hx-post="/api/tasks/${taskId}/realtime/session/start" hx-target="#rt-session-status" hx-swap="innerHTML" class="btn-sm">Start Session</button>
        <button hx-post="/api/tasks/${taskId}/realtime/session/stop" hx-target="#rt-session-status" hx-swap="innerHTML" class="btn-sm btn-danger">Stop Session</button>
      </div>
      <div id="rt-session-status" class="muted" style="margin-top:0.5rem">Check session state after starting.</div>
    </div>`
        : "";

    // Config summary
    const config = task.task_config;
    const configPanel = config && Object.keys(config).length > 0
        ? `
    <div class="card">
      <h3>Real-Time Config</h3>
      <table class="data-table">
        <tr><td>Window Duration</td><td>${config.window_seconds ?? 60}s</td></tr>
        <tr><td>Summary Cadence</td><td>${config.summary_cadence_seconds ?? 60}s</td></tr>
        <tr><td>Trigger Threshold</td><td>${config.trigger_min_confidence ?? 0.7}</td></tr>
        <tr><td>Max Pending Windows</td><td>${config.max_pending_windows ?? 3}</td></tr>
        ${config.transcription_command ? `<tr><td>Transcription</td><td>${escapeHtml(String(config.transcription_command))}</td></tr>` : ""}
      </table>
    </div>`
        : "";

    // Artifacts panel
    const artifactPanel = `
    <div class="card">
      <div class="section-heading"><div><h2>Artifacts</h2><p class="muted">Transcripts, summaries, and other versioned outputs.</p></div></div>
      <div hx-get="/fragments/tasks/${taskId}/artifacts" hx-trigger="load" hx-target="#artifact-list" hx-swap="innerHTML">
        <div id="artifact-list" class="muted">Loading artifacts...</div>
      </div>
      <div id="artifact-detail"></div>
    </div>`;

    // SSE stream panel for live updates
    const livePanel = isRunning
        ? `
    <div class="card">
      <div class="section-heading"><div><h2>Live Feed</h2><p class="muted">Real-time transcript and trigger events via SSE.</p></div></div>
      <div id="rt-live-feed" data-task-id="${taskId}" class="muted" style="max-height:300px;overflow-y:auto;font-family:monospace;font-size:0.85rem">
        Connecting to live feed...
      </div>
      <form id="rt-text-input-form" style="display:flex;gap:8px;margin-top:8px;">
        <input name="text" type="text" placeholder="Send text input..." style="flex:1;" />
        <button type="submit">Send</button>
      </form>
    </div>
    <div class="card">
      <div class="section-heading"><div><h2>Audio Input</h2><p class="muted">Capture microphone audio and stream via WebSocket.</p></div></div>
      <div id="rt-audio-controls" data-task-id="${taskId}">
        <button id="rt-audio-start" class="btn-sm">Start Recording</button>
        <button id="rt-audio-stop" class="btn-sm btn-danger" disabled>Stop Recording</button>
        <span id="rt-audio-status" class="muted" style="margin-left:8px;">Not connected</span>
      </div>
    </div>
    <script src="/realtime.js"></script>
    <script src="/realtime-audio.js"></script>`
        : "";

    return `${sessionControls}${configPanel}${artifactPanel}${livePanel}`;
}
