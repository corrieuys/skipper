// Dictation widget for task-description textareas (experimental).
//
// Server-side pages render a mic button via src/html/fragments/dictate-button.fragment.ts:
//   <button data-dictate data-dictate-target="<css selector of textarea>">
// This script binds one delegated click handler, so buttons inside HTMX-swapped
// fragments work without re-init.
//
// Flow ("raw now, rewrite later"):
//   click → lock the textarea, start whisper warming (unless provider is openai)
//         → record a single webm/opus blob (no streaming — one clip)
//   click again (or 3 min cap) → "Transcribing..." → POST /api/dictation/transcribe
//         → append raw transcript → "Cleaning up..." → POST /api/dictation/cleanup
//         → swap in the cleaned text, unlock the textarea.
// The textarea stays locked (readonly, not disabled — disabled fields are
// dropped from form submits) from record start until cleanup finishes, so the
// text can't be edited mid-pipeline. Status is a line under the textarea,
// never next to the button, so the button doesn't move as text changes.
(function () {
  'use strict';

  var MAX_RECORD_MS = 3 * 60 * 1000;
  var active = null; // one recording at a time

  // Minimal widget styles, self-contained so pages only render markup.
  var style = document.createElement('style');
  style.textContent = [
    '.sk-dictate-wrap{display:inline-flex;align-items:center;vertical-align:middle;}',
    '.sk-dictate-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:88px;}',
    '.sk-dictate-btn--rec{color:#e05555;border-color:#e05555;}',
    '.sk-dictate-btn--rec svg{animation:sk-dictate-pulse 1.2s ease-in-out infinite;}',
    '.sk-dictate-status{display:block;margin-top:4px;min-height:1.1em;font-size:0.72rem;color:var(--sk-text-muted,var(--muted,#888));}',
    '.sk-dictate-status--error{color:#e05555;}',
    '.sk-dictate-target--locked{opacity:0.55;cursor:not-allowed;}',
    '@keyframes sk-dictate-pulse{0%,100%{opacity:1;}50%{opacity:0.35;}}',
  ].join('\n');
  document.head.appendChild(style);

  // Status line lives directly under the textarea (created on demand) so the
  // button row never resizes. Falls back to a line after the button when the
  // target selector matched nothing.
  function ensureStatus(btn, target) {
    var anchor = target || btn.closest('.sk-dictate-wrap') || btn;
    var next = anchor.nextElementSibling;
    if (next && next.classList && next.classList.contains('sk-dictate-status')) return next;
    var el = document.createElement('div');
    el.className = 'sk-dictate-status';
    el.setAttribute('role', 'status');
    anchor.insertAdjacentElement('afterend', el);
    return el;
  }
  function setStatus(btn, target, msg, isError) {
    var el = ensureStatus(btn, target);
    el.textContent = msg || '';
    el.classList.toggle('sk-dictate-status--error', !!isError);
  }
  function labelEl(btn) {
    return btn.querySelector('[data-dictate-label]');
  }
  function setLabel(btn, text) {
    var el = labelEl(btn);
    if (el) el.textContent = text;
  }
  function lockTarget(target) {
    target.readOnly = true;
    target.classList.add('sk-dictate-target--locked');
  }
  function unlockTarget(target) {
    target.readOnly = false;
    target.classList.remove('sk-dictate-target--locked');
  }
  function fmtElapsed(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function apiJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { ok: res.ok, json: json };
      });
    });
  }

  // Start whisper in the background so the model warms up while the user talks.
  // Resolves { started: bool } — started=true means we own a stop call later.
  // OpenAI-transcription setups never need (or may not even have) local whisper.
  function warmWhisper() {
    return fetch('/api/realtime/config')
      .then(function (res) { return res.json(); })
      .then(function (cfg) {
        if (cfg && cfg.transcription_provider === 'openai') {
          return { started: false };
        }
        return fetch('/api/whisper/start', { method: 'POST' })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.error) throw new Error(data.error);
            return { started: true };
          });
      });
  }
  function stopWhisper() {
    fetch('/api/whisper/stop', { method: 'POST' }).catch(function () {});
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('could not read recording')); };
      reader.readAsDataURL(blob);
    });
  }

  function resetButton(btn) {
    btn.disabled = false;
    btn.classList.remove('sk-dictate-btn--rec');
    setLabel(btn, 'Dictate');
  }

  // Every exit path funnels here: button back to idle, textarea unlocked.
  function finishFlow(btn, target, msg, isError) {
    resetButton(btn);
    unlockTarget(target);
    setStatus(btn, target, msg || '', isError);
  }

  function startRecording(btn) {
    var targetSel = btn.getAttribute('data-dictate-target');
    var target = targetSel ? document.querySelector(targetSel) : null;
    if (!target) {
      setStatus(btn, null, 'No target field found.', true);
      return;
    }

    // Whisper warms concurrently with recording; awaited before transcribe.
    // Errors are captured (not thrown) so the recording UI never breaks —
    // a failed warmup surfaces when the transcript is requested.
    var whisper = warmWhisper().catch(function (err) {
      return { started: false, error: err && err.message ? err.message : String(err) };
    });

    // Visible while the browser's permission prompt is up.
    setStatus(btn, target, 'Waiting for microphone...');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      var chunks = [];
      var startedAt = Date.now();

      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(chunks, { type: 'audio/webm;codecs=opus' });
        finishRecording(btn, target, blob, whisper);
      };

      var timer = setInterval(function () {
        var elapsed = Date.now() - startedAt;
        setLabel(btn, 'Stop ' + fmtElapsed(elapsed));
        if (elapsed >= MAX_RECORD_MS) stopActive();
      }, 500);

      active = { btn: btn, target: target, recorder: recorder, timer: timer };
      recorder.start();
      lockTarget(target);
      btn.classList.add('sk-dictate-btn--rec');
      setLabel(btn, 'Stop 0:00');
      setStatus(btn, target, 'Recording... click Stop to finish.');
    }).catch(function (err) {
      whisper.then(function (w) { if (w.started) stopWhisper(); });
      finishFlow(btn, target, 'Mic access denied: ' + (err && err.message ? err.message : err), true);
    });
  }

  function stopActive() {
    if (!active) return;
    clearInterval(active.timer);
    var rec = active.recorder;
    var btn = active.btn;
    var target = active.target;
    active = null;
    btn.disabled = true;
    btn.classList.remove('sk-dictate-btn--rec');
    setLabel(btn, 'Dictate');
    setStatus(btn, target, 'Transcribing...');
    try {
      rec.stop();
    } catch (e) {
      finishFlow(btn, target, 'Recording failed.', true);
    }
  }

  function finishRecording(btn, target, blob, whisper) {
    if (!blob || blob.size === 0) {
      finishFlow(btn, target, 'Heard nothing.', true);
      whisper.then(function (w) { if (w.started) stopWhisper(); });
      return;
    }

    whisper.then(function (w) {
      if (w.error) {
        finishFlow(btn, target, 'Whisper failed: ' + w.error, true);
        return;
      }
      blobToBase64(blob).then(function (base64) {
        return apiJson('/api/dictation/transcribe', { audio: base64, format: 'webm' });
      }).then(function (res) {
        if (w.started) stopWhisper();
        if (!res.ok) {
          finishFlow(btn, target, res.json.error || 'Transcription failed.', true);
          return;
        }
        var raw = (res.json.text || '').trim();
        if (!raw) {
          finishFlow(btn, target, 'Heard nothing.', true);
          return;
        }
        insertAndCleanup(btn, target, raw);
      }).catch(function (err) {
        if (w.started) stopWhisper();
        finishFlow(btn, target, 'Transcription failed: ' + (err && err.message ? err.message : err), true);
      });
    });
  }

  function insertAndCleanup(btn, target, raw) {
    // Raw transcript lands immediately; the textarea stays locked until the
    // LLM rewrite replaces it (or fails, in which case the raw text stays).
    var base = target.value;
    target.value = base.trim() ? base.replace(/\s+$/, '') + '\n\n' + raw : raw;
    target.dispatchEvent(new Event('input', { bubbles: true }));

    setStatus(btn, target, 'Cleaning up...');
    apiJson('/api/dictation/cleanup', { text: raw }).then(function (res) {
      if (res.ok && res.json.cleaned && res.json.text && target.value.indexOf(raw) !== -1) {
        target.value = target.value.replace(raw, res.json.text);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        finishFlow(btn, target, '');
      } else {
        // Cleanup unavailable — the raw transcript stays, which is still useful.
        finishFlow(btn, target, 'Kept raw transcript (cleanup unavailable).');
      }
    }).catch(function () {
      finishFlow(btn, target, 'Kept raw transcript (cleanup unavailable).');
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-dictate]') : null;
    if (!btn) return;
    e.preventDefault();

    if (active && active.btn === btn) { stopActive(); return; }
    if (active) return; // another field is recording
    if (btn.disabled) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus(btn, null, 'Recording not supported in this browser.', true);
      return;
    }
    startRecording(btn);
  });
})();
