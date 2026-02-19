// realtime.js — SSE consumer for realtime task detail page
(function() {
  var timelineEl = document.getElementById('timeline-entries');
  var feedEl = document.getElementById('rt-live-feed');
  var statusEl = document.getElementById('rt-session-status');
  var taskId = (feedEl && feedEl.dataset ? feedEl.dataset.taskId : null) ||
    (timelineEl && timelineEl.dataset ? timelineEl.dataset.taskId : null);
  if (!taskId) return;

  var eventSource = null;

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function appendEntry(container, type, text, artifactName) {
    if (!container) return;
    var div = document.createElement('div');
    div.className = 'rt-entry rt-entry-' + type;
    var time = new Date().toLocaleTimeString();
    div.innerHTML = '<span class="rt-time" style="color:#888;margin-right:6px;">' + escapeHtml(time) + '</span>' +
      '<span class="rt-type" style="font-weight:bold;margin-right:4px;">[' + escapeHtml(type) + ']</span> ' +
      escapeHtml(text);
    if (artifactName) {
      div.innerHTML += ' <a href="#" hx-get="/fragments/tasks/' + encodeURIComponent(taskId) + '/artifacts/' + encodeURIComponent(artifactName) + '" hx-target="#artifact-detail" hx-swap="innerHTML">view</a>';
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    // Re-process HTMX attributes on newly added elements
    if (window.htmx) {
      window.htmx.process(div);
    }
  }

  function refreshTimeline() {
    if (!timelineEl) return;
    fetch('/api/realtime-tasks/' + encodeURIComponent(taskId) + '/timeline', {
      headers: { 'HX-Request': 'true' }
    })
      .then(function(r) { return r.text(); })
      .then(function(html) {
        timelineEl.innerHTML = html;
      })
      .catch(function() {});
  }

  function connect() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/tasks/' + encodeURIComponent(taskId) + '/realtime/stream');

    eventSource.addEventListener('transcript.window_ready', function(e) {
      var data = JSON.parse(e.data);
      appendEntry(feedEl, 'transcript',
        'Transcript v' + data.version + ' (' + (data.window_start_at || '') + ' \u2192 ' + (data.window_end_at || '') + ')',
        data.artifact_name);
      refreshTimeline();
    });

    eventSource.addEventListener('summary.window_ready', function(e) {
      var data = JSON.parse(e.data);
      appendEntry(feedEl, 'summary', 'Summary v' + data.version, data.artifact_name);
      refreshTimeline();
    });

    eventSource.addEventListener('trigger.fired', function(e) {
      var data = JSON.parse(e.data);
      appendEntry(feedEl, 'trigger',
        'Trigger fired \u2014 confidence: ' + data.confidence + ', decision: ' + data.decision);
      refreshTimeline();
    });

    eventSource.addEventListener('timeline.updated', function() {
      refreshTimeline();
    });

    eventSource.addEventListener('session.state', function(e) {
      var data = JSON.parse(e.data);
      if (statusEl) {
        statusEl.textContent = data.state;
        statusEl.className = 'rt-status rt-status-' + data.state;
      }
    });

    eventSource.onerror = function() {
      if (eventSource.readyState === EventSource.CLOSED) {
        setTimeout(connect, 3000);
      }
    };
  }

  connect();

  // Text input submission — prefer WebSocket when available, fall through to
  // HTMX form POST otherwise. Never block the submit without sending.
  var textForm = document.getElementById('rt-text-input-form');
  if (textForm) {
    textForm.addEventListener('submit', function(e) {
      var input = textForm.querySelector('input[name="text"]');
      if (!input || !input.value.trim()) return;
      var text = input.value.trim();

      if (window._realtimeWs && window._realtimeWs.readyState === WebSocket.OPEN) {
        e.preventDefault();
        window._realtimeWs.send(JSON.stringify({ type: 'input.text', content: text }));
        appendEntry(feedEl, 'input', text);
        input.value = '';
      }
      // Otherwise let HTMX handle the form POST — the hx-on::after-request
      // handler on the form clears the input on success.
    });
  }
})();
