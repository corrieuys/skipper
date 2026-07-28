/**
 * WebSocket subscription manager for skipper UI.
 * Handles topic-based subscriptions, heartbeat monitoring, and auto-reconnect.
 */
(function () {
  var maxReconnectDelay = 30000;
  var heartbeatTimeout = 60000;
  var lastPingAt = Date.now();
  var heartbeatTimer = null;
  var ws = null;
  var currentTopics = [];
  var hasConnected = false;

  // ── Reconnect supervision ────────────────────────────────────────────────
  // The socket itself is owned by htmx-ext-ws, which retries on its own — but
  // only for close codes 1006/1011/1012/1013. A CLEAN close (what a graceful
  // `skipper stop`/restart produces) schedules nothing, so the banner used to
  // sit there forever. We therefore:
  //   1. replace htmx's default `full-jitter` easing (random, up to 64s) with a
  //      deterministic backoff, so the countdown we show is the real one, and
  //   2. schedule the retry ourselves whenever htmx declined to.
  var retryAt = 0;          // epoch ms of the next attempt; 0 = none pending
  var ownAttempt = 0;       // backoff step for retries WE schedule
  var ownRetryTimer = null;
  var countdownTimer = null;
  var lastWrapper = null;   // htmx socket wrapper; .reconnect() re-inits it

  function backoffDelay(attempt) {
    return Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), maxReconnectDelay);
  }

  if (window.htmx && window.htmx.config) {
    window.htmx.config.wsReconnectDelay = function (retryCount) {
      var delay = backoffDelay(retryCount);
      // Called synchronously from htmx's onclose, immediately before it arms its
      // timer and before it fires htmx:wsClose — so the handler below can read
      // this to tell "htmx has a retry pending" from "htmx gave up".
      retryAt = Date.now() + delay;
      return delay;
    };
  }

  function clearRetryTimers() {
    if (ownRetryTimer) { clearTimeout(ownRetryTimer); ownRetryTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function scheduleOwnRetry() {
    if (ownRetryTimer) clearTimeout(ownRetryTimer);
    var delay = backoffDelay(ownAttempt);
    ownAttempt++;
    retryAt = Date.now() + delay;
    ownRetryTimer = setTimeout(function () { reconnectNow(true); }, delay);
  }

  function reconnectNow(fromTimer) {
    if (ownRetryTimer) { clearTimeout(ownRetryTimer); ownRetryTimer = null; }
    retryAt = 0;
    updateBannerText();
    if (lastWrapper && typeof lastWrapper.reconnect === "function") {
      // Note: if htmx also has a retry armed it will still fire later and re-init
      // the socket, costing a brief blip. htmx exposes no way to cancel it.
      try { lastWrapper.reconnect(); return; } catch (e) { /* fall through */ }
    }
    // No wrapper to drive (htmx never got one open) — a reload is the only way
    // back. Only do that on an explicit click, never from the timer.
    if (!fromTimer) location.reload();
  }

  // On a RECONNECT (not the first connect), the daemon may have been restarted
  // (a plain `skipper restart` or a self-update). Compare the running server's
  // identity ("<version> <boot-id>") against the one this page was loaded with;
  // hard-reload onto the new process if it differs. The boot id changes on every
  // restart even when the version is unchanged, so a manual restart refreshes the
  // tab too — while a transient WS blip (same daemon, same id) does not.
  function checkVersionAndMaybeReload() {
    var loaded = document.body ? document.body.getAttribute("data-sk-version") : null;
    if (!loaded) return;
    fetch("/api/version", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (serverId) {
        if (serverId && serverId.trim() !== loaded) location.reload();
      })
      .catch(function () { /* transient — try again on the next reconnect */ });
  }

  function getTopics() {
    var body = document.body;
    if (!body) return [];
    var attr = body.getAttribute("data-ws-topics");
    return attr ? attr.split(",").map(function (t) { return t.trim(); }).filter(Boolean) : [];
  }

  function taskTopicFromUrl() {
    try {
      var task = new URLSearchParams(location.search).get("task");
      return task ? "task:" + task : null;
    } catch (e) {
      return null;
    }
  }

  // Initial subscription: the body attribute (rendered at full-page load),
  // plus the URL's ?task=<id> if the attribute doesn't already carry it.
  function initialTopics() {
    var topics = getTopics();
    var urlTask = taskTopicFromUrl();
    if (urlTask && topics.indexOf(urlTask) === -1) topics.push(urlTask);
    return topics;
  }

  // Post-navigation subscription. The body attribute is rendered once at
  // full-page load, so any task:<id> entry in it reflects the page-load
  // selection only. HTMX sidebar clicks swap #mc-main and push /?task=<id>
  // without touching the attribute — so after navigation the current task
  // topic must come from the URL. Without this the client stays subscribed
  // to the page-load task forever (its state changes keep ripping out
  // #mc-main) and never hears about the task actually on screen (its
  // completion refresh gets topic-filtered, leaving the view stuck — e.g.
  // recurring-run tasks, which never exist at page load).
  function navigationTopics() {
    var topics = getTopics().filter(function (t) { return t.indexOf("task:") !== 0; });
    var urlTask = taskTopicFromUrl();
    if (urlTask) topics.push(urlTask);
    return topics;
  }

  function subscribe(topics) {
    if (ws && ws.readyState === WebSocket.OPEN && topics.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", topics: topics }));
    }
  }

  function updateBannerText() {
    var label = document.getElementById("ws-reconnect-label");
    if (!label) return;
    var remaining = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
    label.textContent = remaining > 0
      ? "Connection lost. Retrying in " + remaining + "s"
      : "Connection lost. Reconnecting...";
  }

  function showReconnectBanner(show) {
    var banner = document.getElementById("ws-reconnect-banner");
    if (show && !banner) {
      banner = document.createElement("div");
      banner.id = "ws-reconnect-banner";
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:var(--error,#ff6b6b);color:#fff;text-align:center;padding:6px;font-size:13px;font-family:sans-serif;display:flex;align-items:center;justify-content:center;gap:10px;";

      var label = document.createElement("span");
      label.id = "ws-reconnect-label";
      banner.appendChild(label);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.id = "ws-reconnect-now";
      btn.textContent = "Reconnect now";
      btn.style.cssText = "background:rgba(0,0,0,0.25);color:#fff;border:1px solid rgba(255,255,255,0.5);border-radius:4px;padding:2px 8px;font-size:12px;font-family:inherit;cursor:pointer;";
      btn.addEventListener("click", function () { reconnectNow(false); });
      banner.appendChild(btn);

      document.body.appendChild(banner);
      updateBannerText();
      if (!countdownTimer) countdownTimer = setInterval(updateBannerText, 1000);
    } else if (!show && banner) {
      banner.remove();
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    }
  }

  function startHeartbeatMonitor() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    lastPingAt = Date.now();
    heartbeatTimer = setInterval(function () {
      if (Date.now() - lastPingAt > heartbeatTimeout) {
        // No ping received — connection is stale
        if (ws) {
          try { ws.close(); } catch (e) { /* ignore */ }
        }
      }
    }, 15000);
  }

  function connect() {
    // Don't create our own WS — htmx-ext-ws creates it.
    // Instead, intercept the htmx ws connection to add message handling.
    // Store topics for the wsOpen subscribe + re-subscription on reconnect.
    currentTopics = initialTopics();
  }

  // Listen for htmx WebSocket events to handle subscriptions and reconnect
  document.addEventListener("htmx:wsOpen", function (evt) {
    if (!evt.detail) return;
    ws = evt.detail.socketWrapper || null;
    if (ws) lastWrapper = ws;
    clearRetryTimers();
    retryAt = 0;
    ownAttempt = 0;
    showReconnectBanner(false);
    startHeartbeatMonitor();

    // First open just marks the baseline; a later open means we reconnected
    // (possibly onto a newly-updated binary) — check whether to reload.
    if (hasConnected) checkVersionAndMaybeReload();
    hasConnected = true;

    // Subscribe to page topics. On a reconnect after HTMX navigation the URL
    // may have moved past the body attribute, so pick whichever set applies:
    // same URL as page load → initialTopics; navigated → navigationTopics.
    var topics = currentTopics.length > 0 ? currentTopics : initialTopics();
    if (topics.length > 0 && ws) {
      try {
        ws.send(JSON.stringify({ type: "subscribe", topics: topics }));
      } catch (e) { /* ignore */ }
      currentTopics = topics;
    }
  });

  document.addEventListener("htmx:wsClose", function (evt) {
    ws = null;
    if (evt && evt.detail && evt.detail.socketWrapper) lastWrapper = evt.detail.socketWrapper;
    // A future retryAt means our easing function ran a moment ago, i.e. htmx has
    // armed its own timer. Otherwise it declined to retry (clean close) and the
    // reconnect is ours to drive.
    if (retryAt <= Date.now()) scheduleOwnRetry();
    showReconnectBanner(true);
    updateBannerText();
  });

  // Fired on every socket init, including htmx's own retries — the attempt is
  // in flight now, so drop the countdown.
  document.addEventListener("htmx:wsConnecting", function () {
    retryAt = 0;
    updateBannerText();
  });

  // Handle incoming messages for heartbeat
  document.addEventListener("htmx:wsBeforeMessage", function (evt) {
    try {
      var data = JSON.parse(evt.detail.message);
      if (data && data.type === "ping") {
        lastPingAt = Date.now();
        evt.preventDefault(); // Don't let htmx process ping messages
        return;
      }
    } catch (e) {
      // Not JSON — it's an HTML fragment, let htmx handle it
    }
  });

  // On htmx navigation, re-subscribe with the topics for the new URL (the
  // pushed URL's ?task=<id> replaces any page-load task topic).
  document.addEventListener("htmx:pushedIntoHistory", function () {
    var newTopics = navigationTopics();
    if (ws && newTopics.length > 0) {
      if (currentTopics.length > 0) {
        try { ws.send(JSON.stringify({ type: "unsubscribe", topics: currentTopics })); } catch (e) { /* ignore */ }
      }
      try { ws.send(JSON.stringify({ type: "subscribe", topics: newTopics })); } catch (e) { /* ignore */ }
      currentTopics = newTopics;
    }
  });

  // Initialize after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
