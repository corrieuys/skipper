/**
 * WebSocket subscription manager for skipper UI.
 * Handles topic-based subscriptions, heartbeat monitoring, and auto-reconnect.
 */
(function () {
  var reconnectDelay = 1000;
  var maxReconnectDelay = 30000;
  var heartbeatTimeout = 60000;
  var lastPingAt = Date.now();
  var heartbeatTimer = null;
  var ws = null;
  var currentTopics = [];

  function getTopics() {
    var body = document.body;
    if (!body) return [];
    var attr = body.getAttribute("data-ws-topics");
    return attr ? attr.split(",").map(function (t) { return t.trim(); }).filter(Boolean) : [];
  }

  function subscribe(topics) {
    if (ws && ws.readyState === WebSocket.OPEN && topics.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", topics: topics }));
    }
  }

  function showReconnectBanner(show) {
    var banner = document.getElementById("ws-reconnect-banner");
    if (show && !banner) {
      banner = document.createElement("div");
      banner.id = "ws-reconnect-banner";
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:var(--error,#ff6b6b);color:#fff;text-align:center;padding:6px;font-size:13px;font-family:sans-serif;";
      banner.textContent = "Connection lost. Reconnecting...";
      document.body.appendChild(banner);
    } else if (!show && banner) {
      banner.remove();
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
    // Use the htmx-ext-ws WebSocket path, but we add our own handler for subscriptions
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var topics = getTopics();
    var url = proto + "//" + location.host + "/ws/ui";
    if (topics.length > 0) {
      url += "?topics=" + encodeURIComponent(topics.join(","));
    }

    // Don't create our own WS — htmx-ext-ws creates it.
    // Instead, intercept the htmx ws connection to add message handling.
    // We use a MutationObserver approach: watch for htmx WS open events.

    // Store topics for re-subscription on reconnect
    currentTopics = topics;
  }

  // Listen for htmx WebSocket events to handle subscriptions and reconnect
  document.addEventListener("htmx:wsOpen", function (evt) {
    if (!evt.detail) return;
    ws = evt.detail.socketWrapper || null;
    reconnectDelay = 1000;
    showReconnectBanner(false);
    startHeartbeatMonitor();

    // Subscribe to page topics
    var topics = getTopics();
    if (topics.length > 0 && ws) {
      try {
        ws.send(JSON.stringify({ type: "subscribe", topics: topics }));
      } catch (e) { /* ignore */ }
    }
  });

  document.addEventListener("htmx:wsClose", function () {
    showReconnectBanner(true);
    ws = null;
    // htmx-ext-ws handles reconnect automatically, but we track state
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

  // On htmx navigation, re-subscribe with new page topics
  document.addEventListener("htmx:pushedIntoHistory", function () {
    var newTopics = getTopics();
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
