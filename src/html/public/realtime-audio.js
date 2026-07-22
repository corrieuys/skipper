// realtime-audio.js — Browser audio capture via MediaRecorder + WebSocket + Visualizer
(function() {
  if (window.__realtimeAudioController) {
    // Fragment swaps can re-load this script. Reuse the existing controller.
    window.startRealtimeAudio = window.__realtimeAudioController.startRecording;
    window.stopRealtimeAudio = window.__realtimeAudioController.stopRecording;
    window.__realtimeAudioController.syncUi();
    return;
  }

  var ws = null;
  var mediaRecorder = null;
  var audioContext = null;
  var analyser = null;
  var sourceNode = null;
  var animFrameId = null;
  var isRecording = false;
  var stream = null;
  var audioChunks = [];
  var flushIntervalId = null;
  var recordingTaskId = null;

  // Overlap state: retain the last N 1-second chunks from each flush so the
  // next blob includes overlapping audio, preventing words from being cut at
  // chunk boundaries.
  var headerChunk = null;   // first MediaRecorder chunk (contains EBML/WebM header)
  var overlapChunks = [];   // tail chunks retained from the previous flush
  var overlapCount = 5;     // number of 1-second chunks to overlap (from config)
  var flushCount = 0;       // how many flushes have occurred this session

  // Expose globals for inline onclick handlers
  window.startRealtimeAudio = startRecording;
  window.stopRealtimeAudio = stopRecording;

  function getEl(id) { return document.getElementById(id); }

  function updateStatus(text) {
    var el = getEl('audio-status');
    if (el) el.textContent = text;
  }

  function syncUi() {
    var startBtn = getEl('btn-start-recording');
    var stopBtn = getEl('btn-stop-recording');
    var vizWrap = getEl('audio-visualizer-wrap');

    if (!startBtn && !stopBtn && !vizWrap) return;

    if (isRecording) {
      if (startBtn) startBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = '';
      if (vizWrap) vizWrap.style.display = '';
      updateStatus('Recording...');
      if (analyser) drawVisualizer();
      return;
    }

    if (startBtn) startBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    if (vizWrap) vizWrap.style.display = 'none';
  }

  function connectWs(taskId) {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + '/ws/tasks/' + encodeURIComponent(taskId) + '/realtime';
    console.log('[realtime-audio] Connecting to WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);
    window._realtimeWs = ws;

    ws.onopen = function() {
      console.log('[realtime-audio] WebSocket connected:', wsUrl);
      updateStatus('Connected');
    };
    ws.onclose = function() { ws = null; window._realtimeWs = null; };
    ws.onerror = function() { updateStatus('Connection error'); };
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'error') updateStatus('Error: ' + msg.message);
      } catch (err) {}
    };
  }

  /**
   * Build a complete WebM blob from accumulated chunks and send it over the WebSocket.
   *
   * The first chunk from MediaRecorder contains the EBML header + Segment + Tracks
   * metadata. Subsequent chunks are Cluster data with monotonically increasing
   * timestamps. We save the header chunk and prepend it to every flush so that
   * each blob is a valid standalone WebM file.
   *
   * For overlap: we retain the last `overlapCount` chunks from each flush and
   * prepend them (after the header) to the next flush. This means the server
   * receives ~5 seconds of audio that was already in the previous blob, ensuring
   * words at boundaries are not cut off.
   */
  function flushAudioChunks() {
    if (audioChunks.length === 0 || !ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }

    flushCount++;
    var allChunks = audioChunks.splice(0); // take all, reset accumulator

    var blobParts;
    var hasOverlap = false;

    if (flushCount === 1) {
      // First flush only: allChunks[0] is the header — blob is already valid.
      // No overlap to prepend.
      blobParts = allChunks;
    } else {
      // Every subsequent flush: allChunks is Cluster-only data (the header was
      // spliced out on the first flush), so we MUST prepend the saved headerChunk
      // to make a valid standalone WebM. overlapChunks (Cluster data from the tail
      // of the previous period) go between the header and the new chunks; on the
      // final post-stop flush overlapChunks is empty and we just send header+tail.
      // Do NOT gate the header on overlapChunks.length — a headerless blob makes
      // whisper's ffmpeg fail with "EBML header parsing failed".
      blobParts = (headerChunk ? [headerChunk] : []).concat(overlapChunks, allChunks);
      hasOverlap = overlapChunks.length > 0;
    }

    // Save tail of the NEW chunks (not including old overlap) for next flush
    if (overlapCount > 0 && allChunks.length > overlapCount) {
      overlapChunks = allChunks.slice(-overlapCount);
    } else if (overlapCount > 0) {
      overlapChunks = allChunks.slice(); // fewer chunks than overlap — keep all
    } else {
      overlapChunks = [];
    }

    var blob = new Blob(blobParts, { type: 'audio/webm;codecs=opus' });
    var chunkTimestamp = new Date().toISOString();
    var sentOverlap = hasOverlap ? overlapCount : 0;

    console.log('[realtime-audio] Flushing audio — chunks:', allChunks.length,
      '(+' + (blobParts.length - allChunks.length) + ' overlap/header)',
      'blob size:', blob.size, 'bytes, overlap:', sentOverlap + 's',
      'timestamp:', chunkTimestamp);

    return new Promise(function(resolve) {
      var reader = new FileReader();
      reader.onloadend = function() {
        var base64 = reader.result.split(',')[1];
        console.log('[realtime-audio] → WS input.audio_chunk — base64 length:', base64.length);
        ws.send(JSON.stringify({
          type: 'input.audio_chunk',
          data: base64,
          format: 'webm',
          timestamp: chunkTimestamp,
          overlap_seconds: sentOverlap
        }));
        resolve();
      };
      reader.readAsDataURL(blob);
    });
  }

  function ensureWhisper() {
    updateStatus('Starting whisper...');
    return fetch('/api/whisper/start', { method: 'POST' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);
        console.log('[realtime-audio] Whisper ready:', data.endpoint || 'ok');
      });
  }

  function stopWhisper() {
    return fetch('/api/whisper/stop', { method: 'POST' }).catch(function() {});
  }

  function startRecording(taskId, cadenceSeconds, overlapSeconds) {
    if (isRecording) return;
    recordingTaskId = taskId;

    // Start whisper first, then begin recording
    ensureWhisper().then(function() {
      if (recordingTaskId !== taskId) return; // user cancelled during startup
      beginCapture(taskId, cadenceSeconds, overlapSeconds);
    }).catch(function(err) {
      updateStatus('Whisper failed: ' + err.message);
      recordingTaskId = null;
    });
  }

  function beginCapture(taskId, cadenceSeconds, overlapSeconds) {
    connectWs(taskId);

    // Cap flush interval at 60 s; respect the server's cadence if provided
    var flushMs = Math.min((cadenceSeconds || 30), 60) * 1000;

    // Configure overlap (number of 1-second chunks to retain between flushes)
    overlapCount = Math.max(0, Math.floor(overlapSeconds || 5));

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(s) {
      stream = s;

      // Set up audio context + analyser for visualizer
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNode.connect(analyser);

      // Set up MediaRecorder with 1 s timeslice for low-latency accumulation.
      // Chunks are NOT sent individually — they are accumulated and flushed as a
      // single complete Blob so that every server-side segment is a valid WebM file.
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      audioChunks = [];
      headerChunk = null;
      overlapChunks = [];
      flushCount = 0;

      mediaRecorder.ondataavailable = function(e) {
        if (e.data.size > 0) {
          // Save the very first chunk — it contains the EBML/WebM header needed
          // to make subsequent flushes into valid standalone WebM files.
          if (!headerChunk) {
            headerChunk = e.data;
          }
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.start(1000); // 1 s timeslice for smooth accumulation
      isRecording = true;

      // Flush accumulated chunks to the server at the cadence interval
      flushIntervalId = setInterval(flushAudioChunks, flushMs);

      // Show visualizer, hide start button
      syncUi();
      drawVisualizer();
    }).catch(function(err) {
      updateStatus('Mic access denied: ' + err.message);
      recordingTaskId = null;
      stopWhisper();
    });
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    if (flushIntervalId) {
      clearInterval(flushIntervalId);
      flushIntervalId = null;
    }

    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    // Update UI immediately so user sees feedback
    syncUi();
    updateStatus('Flushing final chunk...');

    var canvas = getEl('audio-visualizer');
    if (canvas) {
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Clear overlap state before the final flush so we don't prepend duplicated
    // tail audio, but keep the original header until the recorder has emitted
    // its last chunk. That final chunk is usually cluster-only WebM data.
    overlapChunks = [];

    function cleanupAfterStop() {
      if (stream) {
        stream.getTracks().forEach(function(t) { t.stop(); });
        stream = null;
      }
      if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
      }
      if (audioContext) {
        audioContext.close();
        audioContext = null;
        analyser = null;
      }
      audioChunks = [];
      overlapChunks = [];
      headerChunk = null;
      flushCount = 0;
      recordingTaskId = null;
      // Whisper is stopped server-side after transcription completes (session.stop).
      // Do NOT stop it here — the server still needs it to transcribe the final chunk.
      updateStatus('Stopped');
      syncUi();
    }

    function sendStoppedAndCleanup() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'recording.stopped' }));
      }
      cleanupAfterStop();
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      // .stop() triggers one final ondataavailable with the remaining audio,
      // then fires onstop. Flush the complete accumulated blob from onstop.
      mediaRecorder.onstop = function() {
        console.log('[realtime-audio] MediaRecorder stopped — flushing final chunk');
        flushAudioChunks().then(function() {
          mediaRecorder = null;
          sendStoppedAndCleanup();
        });
      };
      mediaRecorder.stop();
    } else {
      flushAudioChunks().then(function() {
        mediaRecorder = null;
        sendStoppedAndCleanup();
      });
    }
  }

  function parseColor(raw) {
    var el = document.createElement('div');
    el.style.color = raw;
    document.body.appendChild(el);
    var computed = getComputedStyle(el).color;
    document.body.removeChild(el);
    var m = computed.match(/[\d.]+/g);
    return m ? { r: +m[0], g: +m[1], b: +m[2] } : { r: 255, g: 137, b: 171 };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function readThemeColors() {
    var style = getComputedStyle(document.documentElement);
    var primary = parseColor(style.getPropertyValue('--sk-accent-primary').trim() || '#ff89ab');
    var secondary = parseColor(style.getPropertyValue('--sk-accent-secondary').trim() || '#00fbfb');
    var surface0 = parseColor(style.getPropertyValue('--sk-surface-0').trim() || '#0e0e0e');
    return {
      primary: rgbToHsl(primary.r, primary.g, primary.b),
      secondary: secondary,
      surface0: surface0
    };
  }

  function drawVisualizer() {
    if (!analyser) return;

    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    var bufferLength = analyser.frequencyBinCount;
    var dataArray = new Uint8Array(bufferLength);

    var theme = readThemeColors();
    var accentHue = theme.primary.h;
    var bg = theme.surface0;
    var sec = theme.secondary;

    function draw() {
      animFrameId = requestAnimationFrame(draw);
      var canvas = getEl('audio-visualizer');
      if (!canvas) return;
      var ctx = canvas.getContext('2d');
      var W = canvas.width;
      var H = canvas.height;
      analyser.getByteFrequencyData(dataArray);

      // Clear with slight fade for trail effect — use theme surface
      ctx.fillStyle = 'rgba(' + bg.r + ',' + bg.g + ',' + bg.b + ', 0.25)';
      ctx.fillRect(0, 0, W, H);

      // Calculate average for glow intensity
      var sum = 0;
      for (var k = 0; k < bufferLength; k++) sum += dataArray[k];
      var avg = sum / bufferLength;
      var glowIntensity = Math.min(avg / 128, 1);

      // Background glow pulse — use theme primary
      if (glowIntensity > 0.05) {
        var grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
        grad.addColorStop(0, 'hsla(' + accentHue + ', 80%, 60%, ' + (glowIntensity * 0.12) + ')');
        grad.addColorStop(1, 'hsla(' + accentHue + ', 80%, 60%, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      // --- Mirrored bar visualization ---
      var barCount = Math.min(bufferLength, 80);
      var gap = 2;
      var barWidth = (W - (barCount - 1) * gap) / barCount;
      var centerY = H / 2;

      for (var i = 0; i < barCount; i++) {
        var value = dataArray[i] / 255;
        var barHeight = value * (H / 2 - 4);

        var hue = accentHue + (i / barCount) * 200;
        var lightness = 50 + value * 20;
        var alpha = 0.6 + value * 0.4;

        var x = i * (barWidth + gap);

        // Top half (upward from center)
        var gradient = ctx.createLinearGradient(x, centerY, x, centerY - barHeight);
        gradient.addColorStop(0, 'hsla(' + hue + ', 80%, ' + lightness + '%, ' + alpha + ')');
        gradient.addColorStop(1, 'hsla(' + hue + ', 90%, ' + (lightness + 15) + '%, ' + (alpha * 0.3) + ')');
        ctx.fillStyle = gradient;

        var r = Math.min(barWidth / 2, 3);
        roundRect(ctx, x, centerY - barHeight, barWidth, barHeight, r);

        // Bottom half (mirrored, dimmer)
        var gradient2 = ctx.createLinearGradient(x, centerY, x, centerY + barHeight);
        gradient2.addColorStop(0, 'hsla(' + hue + ', 80%, ' + lightness + '%, ' + (alpha * 0.5) + ')');
        gradient2.addColorStop(1, 'hsla(' + hue + ', 90%, ' + lightness + '%, ' + (alpha * 0.05) + ')');
        ctx.fillStyle = gradient2;
        roundRect(ctx, x, centerY, barWidth, barHeight * 0.6, r);
      }

      // Center line — use theme secondary
      ctx.strokeStyle = 'rgba(' + sec.r + ',' + sec.g + ',' + sec.b + ', ' + (0.12 + glowIntensity * 0.2) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(W, centerY);
      ctx.stroke();

    }

    draw();
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (h < 1) return;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  // Clean up recording only on real page navigation, not ws/oob dashboard refreshes.
  document.addEventListener('htmx:beforeSwap', function(e) {
    if (e.detail && e.detail.target === document.body && e.detail.xhr && isRecording) {
      stopRecording();
    }
  });

  // Keep controls synced after any fragment swaps.
  document.addEventListener('htmx:afterSwap', syncUi);
  document.addEventListener('htmx:oobAfterSwap', syncUi);

  window.__realtimeAudioController = {
    startRecording: startRecording,
    stopRecording: stopRecording,
    syncUi: syncUi,
    getState: function() {
      return {
        isRecording: isRecording,
        taskId: recordingTaskId,
      };
    },
  };

  window.startRealtimeAudio = startRecording;
  window.stopRealtimeAudio = stopRecording;
  syncUi();
})();
