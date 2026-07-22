/**
 * Skipper UI — unified client-side module.
 * Handles modals, terminal auto-scroll, chat input, preferences, and event delegation.
 * No build step required.
 */
(function (window, document) {
  "use strict";

  var Skipper = {};

  // ── Activity Detail Formatter ──
  function formatActivityDetail(parsed) {
    // "result" event — show the result string prominently
    if (parsed.type === "result" && typeof parsed.result === "string") {
      var lines = [parsed.result, ""];
      if (parsed.stop_reason) lines.push("Stop reason: " + parsed.stop_reason);
      if (parsed.duration_ms) lines.push("Duration: " + (parsed.duration_ms / 1000).toFixed(1) + "s");
      if (parsed.num_turns) lines.push("Turns: " + parsed.num_turns);
      return lines.join("\n");
    }

    // assistant message — extract text and tool_use blocks
    if (parsed.type === "assistant" && parsed.message && Array.isArray(parsed.message.content)) {
      var sections = [];
      parsed.message.content.forEach(function (block) {
        if (!block) return;
        if (block.type === "text" && block.text) {
          sections.push(block.text);
        } else if (block.type === "thinking" && block.thinking) {
          sections.push("<thinking>\n" + block.thinking + "\n</thinking>");
        } else if (block.type === "tool_use") {
          var toolLine = "Tool: " + (block.name || "unknown");
          if (block.input && typeof block.input === "object") {
            var keys = Object.keys(block.input);
            if (keys.length <= 6) {
              keys.forEach(function (k) {
                var val = block.input[k];
                var display = typeof val === "string" ? val : JSON.stringify(val);
                if (display && display.length > 300) display = display.slice(0, 300) + "…";
                toolLine += "\n  " + k + ": " + display;
              });
            } else {
              toolLine += "\n" + JSON.stringify(block.input, null, 2);
            }
          }
          sections.push(toolLine);
        }
      });
      if (sections.length > 0) return sections.join("\n\n");
    }

    // user message — tool_result responses
    if (parsed.type === "user" && parsed.message && Array.isArray(parsed.message.content)) {
      var results = [];
      parsed.message.content.forEach(function (block) {
        if (!block) return;
        if (block.type === "tool_result") {
          var inner = block.content;
          var text = "";
          if (typeof inner === "string") {
            text = inner;
          } else if (Array.isArray(inner)) {
            text = inner.map(function (c) { return c && c.text ? c.text : ""; }).join("\n");
          }
          // Try to pretty-print if the text is JSON
          if (text.trim().charAt(0) === "{" || text.trim().charAt(0) === "[") {
            try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* keep raw */ }
          }
          results.push(text);
        }
      });
      if (results.length > 0) return results.join("\n\n---\n\n");
    }

    // Fallback: pretty-print the full JSON
    return JSON.stringify(parsed, null, 2);
  }

  // ── Modal System ──
  Skipper.modal = {
    open: function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.add("sk-modal--open");
      document.body.style.overflow = "hidden";
    },
    close: function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.remove("sk-modal--open");
      document.body.style.overflow = "";
    },
  };

  // ── Agent instance modal ──
  // Singleton modal at body level (survives fragment re-renders / WS pushes).
  // Loads the running instances of one agent type, each with output + steer input.
  Skipper.agentModal = {
    ensure: function () {
      var m = document.getElementById("mc-agent-modal");
      if (m) return m;
      m = document.createElement("div");
      m.id = "mc-agent-modal";
      m.className = "sk-modal";
      m.setAttribute("data-sk-modal-backdrop", "");
      m.innerHTML =
        '<div class="sk-modal__content mc-agent-modal__content">' +
        '<div class="sk-modal__header">' +
        '<span id="mc-agent-modal-title">Agent</span>' +
        '<button class="sk-btn sk-btn--sm" data-sk-modal-close="mc-agent-modal">Close</button>' +
        "</div>" +
        '<div class="sk-modal__body" id="mc-agent-modal-body"><span class="sk-muted">Loading...</span></div>' +
        "</div>";
      document.body.appendChild(m);
      return m;
    },
    _poll: null,
    open: function (templateId, agentName, taskId) {
      if (!templateId) return;
      this.ensure();
      var title = document.getElementById("mc-agent-modal-title");
      if (title) title.textContent = agentName || "Agent";
      var body = document.getElementById("mc-agent-modal-body");
      if (body) body.innerHTML = '<span class="sk-muted">Loading...</span>';
      var url = "/fragments/dashboard/agent-instances?template_agent_id=" + encodeURIComponent(templateId);
      if (taskId) url += "&task=" + encodeURIComponent(taskId);
      if (window.htmx) {
        window.htmx.ajax("GET", url, { target: "#mc-agent-modal-body", swap: "innerHTML" });
      } else {
        fetch(url).then(function (r) { return r.text(); }).then(function (h) {
          if (body) body.innerHTML = h;
        });
      }
      Skipper.modal.open("mc-agent-modal");
      this._watch(url);
    },
    // While open, poll the instance endpoint and reconcile: drop cards for
    // instances that have finished, and close once none remain. Cards that are
    // still active are left in place so an in-progress steer textarea isn't
    // clobbered (we never re-swap the whole body).
    _watch: function (url) {
      var self = this;
      if (self._poll) clearInterval(self._poll);
      self._poll = setInterval(function () {
        var m = document.getElementById("mc-agent-modal");
        if (!m || !m.classList.contains("sk-modal--open")) {
          clearInterval(self._poll);
          self._poll = null;
          return;
        }
        fetch(url).then(function (r) { return r.text(); }).then(function (h) {
          var mm = document.getElementById("mc-agent-modal");
          if (!mm || !mm.classList.contains("sk-modal--open")) return;
          if (h.indexOf("data-mc-agent-empty") !== -1) {
            Skipper.modal.close("mc-agent-modal");
            if (self._poll) { clearInterval(self._poll); self._poll = null; }
            return;
          }
          // Set of instances still active per the fresh response.
          var tmp = document.createElement("div");
          tmp.innerHTML = h;
          var active = {};
          tmp.querySelectorAll(".mc-steer-card[data-runtime-id]").forEach(function (c) {
            active[c.getAttribute("data-runtime-id")] = true;
          });
          // Remove cards whose instance has finished (not in the fresh set).
          var body = document.getElementById("mc-agent-modal-body");
          if (!body) return;
          body.querySelectorAll(".mc-steer-card[data-runtime-id]").forEach(function (c) {
            if (!active[c.getAttribute("data-runtime-id")]) c.remove();
          });
        }).catch(function () {});
      }, 3000);
    },
  };

  // ── Terminal Auto-Scroll ──
  Skipper.terminal = {
    observers: {},
    observeAppend: function (containerId) {
      var el = document.getElementById(containerId);
      if (!el) return;
      if (Skipper.terminal.observers[containerId]) return; // already observing

      var observer = new MutationObserver(function () {
        var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        if (atBottom) el.scrollTop = el.scrollHeight;
      });
      observer.observe(el, { childList: true, subtree: true });
      Skipper.terminal.observers[containerId] = observer;
    },
    setFilter: function (containerId, filter) {
      var el = document.getElementById(containerId);
      if (el) el.setAttribute("data-filter", filter || "all");
    },
  };

  // ── Chat ──
  Skipper.chat = {
    handleKeydown: function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        var form = event.target.closest("form");
        if (form) htmx.trigger(form, "submit");
      }
    },
    scrollToBottom: function (containerId) {
      var el = document.getElementById(containerId);
      if (el) el.scrollTop = el.scrollHeight;
    },
    toggle: function () {
      var workspace = document.getElementById("mc-workspace");
      var panel = document.getElementById("mc-chat-panel");
      if (!workspace || !panel) return;
      var isOpen = workspace.classList.toggle("mc-workspace--chat-open");
      // Update toggle button active state
      document.querySelectorAll("[data-sk-chat-toggle]").forEach(function (btn) {
        if (btn.classList.contains("mc-chat-toggle")) {
          btn.classList.toggle("mc-chat-toggle--active", isOpen);
        }
      });
      // Restore saved height
      if (isOpen) {
        var savedHeight = Skipper.prefs.get("chatPanelHeight", "");
        if (savedHeight) panel.style.height = savedHeight;
      }
      // Persist state
      Skipper.prefs.set("chatPanelOpen", isOpen ? "1" : "0");
    },
    // ── Slash-command autocomplete ──
    _skillCatalog: null,
    _skillCatalogFetch: null,
    _loadSkillCatalog: function () {
      if (Skipper.chat._skillCatalog) return Promise.resolve(Skipper.chat._skillCatalog);
      if (Skipper.chat._skillCatalogFetch) return Skipper.chat._skillCatalogFetch;
      Skipper.chat._skillCatalogFetch = fetch("/api/skills/catalog", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : { skills: [] }; })
        .then(function (data) {
          Skipper.chat._skillCatalog = Array.isArray(data.skills) ? data.skills : [];
          return Skipper.chat._skillCatalog;
        })
        .catch(function () { return []; });
      return Skipper.chat._skillCatalogFetch;
    },
    initSlashAutocomplete: function (textarea) {
      if (!textarea || textarea.dataset.slashInit === "1") return;
      textarea.dataset.slashInit = "1";

      var menu = document.createElement("div");
      menu.className = "sk-slash-menu";
      menu.style.display = "none";
      menu.setAttribute("role", "listbox");
      // Anchor menu inside the form so it follows the textarea in the layout.
      var anchor = textarea.parentElement || document.body;
      anchor.style.position = anchor.style.position || "relative";
      anchor.appendChild(menu);

      var state = {
        open: false,
        items: [],
        active: 0,
        tokenStart: -1, // index of "/" in the textarea value
        tokenEnd: -1,   // exclusive end of token (caret position when typing)
      };

      function close() {
        if (!state.open) return;
        state.open = false;
        menu.style.display = "none";
        menu.innerHTML = "";
      }

      function render() {
        menu.innerHTML = "";
        if (state.items.length === 0) {
          var empty = document.createElement("div");
          empty.className = "sk-slash-menu__empty";
          empty.textContent = "No matching skills";
          menu.appendChild(empty);
          return;
        }
        state.items.forEach(function (item, i) {
          var el = document.createElement("div");
          el.className = "sk-slash-menu__item" + (i === state.active ? " is-active" : "");
          el.setAttribute("role", "option");
          var name = document.createElement("div");
          name.className = "sk-slash-menu__name";
          name.textContent = "/" + item.name;
          var desc = document.createElement("div");
          desc.className = "sk-slash-menu__desc";
          desc.textContent = item.description || "";
          el.appendChild(name);
          el.appendChild(desc);
          el.addEventListener("mousedown", function (ev) {
            // mousedown so we beat the textarea blur
            ev.preventDefault();
            choose(i);
          });
          menu.appendChild(el);
        });
      }

      function choose(index) {
        var item = state.items[index];
        if (!item) return;
        var before = textarea.value.substring(0, state.tokenStart);
        var after = textarea.value.substring(state.tokenEnd);
        var insertion = "/" + item.name + " ";
        textarea.value = before + insertion + after;
        var caret = before.length + insertion.length;
        textarea.setSelectionRange(caret, caret);
        textarea.focus();
        close();
      }

      function findToken() {
        var caret = textarea.selectionStart;
        var val = textarea.value.substring(0, caret);
        // Find start of current whitespace-delimited token.
        var match = /(^|\s)(\/[^\s]*)$/.exec(val);
        if (!match) return null;
        var tokenStart = match.index + match[1].length;
        return { tokenStart: tokenStart, tokenEnd: caret, query: match[2].slice(1) };
      }

      function update() {
        var t = findToken();
        if (!t) { close(); return; }
        Skipper.chat._loadSkillCatalog().then(function (catalog) {
          var q = t.query.toLowerCase();
          var filtered = catalog.filter(function (s) {
            return s.name.toLowerCase().indexOf(q) !== -1;
          }).slice(0, 8);
          state.items = filtered;
          state.active = 0;
          state.tokenStart = t.tokenStart;
          state.tokenEnd = t.tokenEnd;
          state.open = true;
          menu.style.display = "block";
          render();
        });
      }

      textarea.addEventListener("input", update);
      textarea.addEventListener("click", update);
      textarea.addEventListener("keyup", function (ev) {
        // arrow keys move caret without firing 'input' — re-check token position
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End") {
          update();
        }
      });

      textarea.addEventListener("keydown", function (ev) {
        if (!state.open || state.items.length === 0) return;
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          state.active = (state.active + 1) % state.items.length;
          render();
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          state.active = (state.active - 1 + state.items.length) % state.items.length;
          render();
        } else if (ev.key === "Enter" || ev.key === "Tab") {
          ev.preventDefault();
          ev.stopPropagation();
          choose(state.active);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          close();
        }
      }, true); // capture so we beat the Enter-to-submit handler on the textarea

      textarea.addEventListener("blur", function () {
        // small delay so a click on a menu item can fire first
        setTimeout(close, 120);
      });
    },

    _resizing: false,
    _startResize: function (e) {
      e.preventDefault();
      var panel = document.getElementById("mc-chat-panel");
      if (!panel) return;
      Skipper.chat._resizing = true;
      var handle = panel.querySelector("[data-sk-chat-resize]");
      if (handle) handle.classList.add("mc-chat-panel__resize-handle--active");
      var startY = e.clientY;
      var startH = panel.offsetHeight;

      function onMove(ev) {
        if (!Skipper.chat._resizing) return;
        var delta = startY - ev.clientY;
        var newH = Math.min(Math.max(startH + delta, 120), window.innerHeight * 0.8);
        panel.style.height = newH + "px";
      }
      function onUp() {
        Skipper.chat._resizing = false;
        if (handle) handle.classList.remove("mc-chat-panel__resize-handle--active");
        Skipper.prefs.set("chatPanelHeight", panel.style.height);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
  };

  // ── Preferences (localStorage) ──
  Skipper.prefs = {
    get: function (key, fallback) {
      try {
        return localStorage.getItem("sk." + key) || fallback;
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem("sk." + key, value);
      } catch (e) {
        /* ignore */
      }
    },
  };

  // ── Tabs ──
  // ── Panel dock ──────────────────────────────────────────────────────────
  // The running-task view is a "dock" of toggleable, resizable, reorderable
  // columns (Timeline, Details, Escalations[input], Notes, Artifacts). 1-3 show
  // side by side (manual toggles blocked at 3). All 5 panels stay mounted in the
  // DOM (so their hx-get / WS-OOB targets stay stable); toggling flips display +
  // re-inserts the resize dividers between visible columns. State (open set,
  // order, widths) persists globally in Skipper.prefs.dockState.
  Skipper.dock = {
    PANELS: ["timeline", "details", "input", "notes", "artifacts"],
    MAX: 3,
    _state: null,           // { open: [names, in display order], widths: {name: ratio} }
    _containerEl: null,     // the #mc-outputs element we last initialized against
    _inputCount: undefined,

    _container: function () { return document.getElementById("mc-outputs"); },

    _loadState: function () {
      var valid = function (n) { return Skipper.dock.PANELS.indexOf(n) >= 0; };
      var saved = Skipper.prefs.get("dockState", "");
      if (saved) {
        try {
          var s = JSON.parse(saved);
          if (s && Array.isArray(s.open) && s.open.filter(valid).length) {
            return { open: s.open.filter(valid), widths: s.widths || {} };
          }
        } catch (_) {}
      }
      var c = Skipper.dock._container();
      var def = c && c.getAttribute("data-dock-default");
      var open = def ? def.split(",").filter(valid) : ["timeline", "notes"];
      return { open: open.length ? open : ["timeline"], widths: {} };
    },

    _saveState: function () {
      if (Skipper.dock._state) Skipper.prefs.set("dockState", JSON.stringify(Skipper.dock._state));
    },

    // Reconcile the DOM to _state: show/hide + order the columns and (re)insert
    // numbered dividers between the visible ones.
    render: function () {
      var c = Skipper.dock._container();
      if (!c || !Skipper.dock._state) return;
      var st = Skipper.dock._state;

      var existing = {};
      c.querySelectorAll(".mc-outputs__col[data-dock-panel]").forEach(function (col) {
        existing[col.getAttribute("data-dock-panel")] = col;
      });
      st.open = st.open.filter(function (n) { return existing[n]; });
      if (!st.open.length) {
        var fb = ["timeline", "notes"].filter(function (n) { return existing[n]; });
        st.open = fb.length ? fb.slice(0, 1) : Object.keys(existing).slice(0, 1);
      }
      if (st.open.length > Skipper.dock.MAX) st.open = st.open.slice(0, Skipper.dock.MAX);

      c.querySelectorAll(".mc-outputs__divider").forEach(function (d) { d.remove(); });

      Object.keys(existing).forEach(function (n) {
        var col = existing[n];
        var isOpen = st.open.indexOf(n) >= 0;
        col.style.display = isOpen ? "flex" : "none";
        var r = st.widths[n];
        col.style.flex = (isOpen && r) ? (Number(r).toFixed(4) + " 1 0") : "1 1 0";
      });
      // Open columns first (in order) with dividers between; then hidden ones.
      st.open.forEach(function (n, i) {
        c.appendChild(existing[n]);
        if (i < st.open.length - 1) {
          var div = document.createElement("div");
          div.className = "mc-outputs__divider";
          div.setAttribute("data-sk-outputs-resize", String(i));
          c.appendChild(div);
        }
      });
      Object.keys(existing).forEach(function (n) {
        if (st.open.indexOf(n) < 0) c.appendChild(existing[n]);
      });

      document.querySelectorAll(".mc-tab[data-mc-tab]").forEach(function (b) {
        var n = b.getAttribute("data-mc-tab");
        b.classList.toggle("mc-tab--active", st.open.indexOf(n) >= 0);
      });
      Skipper.dock._saveState();
    },

    toggle: function (name) {
      if (!Skipper.dock._state) Skipper.dock.init();
      var st = Skipper.dock._state; if (!st) return;
      var idx = st.open.indexOf(name);
      if (idx >= 0) {
        if (st.open.length <= 1) return;      // keep at least one open
        st.open.splice(idx, 1);
        st.widths = {};                        // closing resets the rest to even
      } else {
        if (st.open.length >= Skipper.dock.MAX) { Skipper.dock._flashFull(name); return; }
        st.open.push(name);
      }
      Skipper.dock.render();
      Skipper.dock._lazyLoad(name);
    },

    // Ensure a panel is visible. opts.force evicts the oldest non-`name` panel
    // when full (used to guarantee escalations surface past the manual cap).
    open: function (name, opts) {
      if (!Skipper.dock._state) Skipper.dock.init();
      var st = Skipper.dock._state; if (!st) return;
      if (st.open.indexOf(name) >= 0) { Skipper.dock._lazyLoad(name); return; }
      if (st.open.length >= Skipper.dock.MAX) {
        if (!(opts && opts.force)) return;
        var vi = -1;
        for (var i = 0; i < st.open.length; i++) { if (st.open[i] !== name) { vi = i; break; } }
        if (vi >= 0) st.open.splice(vi, 1);
      }
      st.open.push(name);
      Skipper.dock.render();
      Skipper.dock._lazyLoad(name);
    },

    close: function (name) {
      var st = Skipper.dock._state; if (!st) return;
      var idx = st.open.indexOf(name);
      if (idx >= 0 && st.open.length > 1) {
        st.open.splice(idx, 1);
        st.widths = {};                        // closing resets the rest to even
        Skipper.dock.render();
      }
    },

    // Reorder: move `name` to sit before `targetName` (or to the end).
    moveBefore: function (name, targetName) {
      var st = Skipper.dock._state; if (!st) return;
      var from = st.open.indexOf(name); if (from < 0) return;
      st.open.splice(from, 1);
      var to = targetName ? st.open.indexOf(targetName) : st.open.length;
      if (to < 0) to = st.open.length;
      st.open.splice(to, 0, name);
      Skipper.dock.render();
    },

    // Some panels defer their fetch until first shown (details). Fire the
    // one-time `dockopen` htmx trigger on the panel's deferred loadable.
    _lazyLoad: function (name) {
      var c = Skipper.dock._container(); if (!c) return;
      var col = c.querySelector('.mc-outputs__col[data-dock-panel="' + name + '"]');
      if (!col) return;
      var lazy = col.querySelector("[data-dock-lazy]:not([data-dock-loaded])");
      if (lazy && window.htmx) { lazy.setAttribute("data-dock-loaded", ""); window.htmx.trigger(lazy, "dockopen"); }
    },

    _flashFull: function (name) {
      var b = document.querySelector('.mc-tab[data-mc-tab="' + name + '"]');
      if (!b) return;
      b.classList.add("mc-tab--blocked");
      setTimeout(function () { b.classList.remove("mc-tab--blocked"); }, 450);
    },

    // Initialize once per #mc-outputs element (i.e. per task-view swap). No-op on
    // partial fragment swaps that leave the dock element in place.
    init: function () {
      var c = Skipper.dock._container();
      if (!c) { Skipper.dock._state = null; Skipper.dock._containerEl = null; return; }
      if (c === Skipper.dock._containerEl && Skipper.dock._state) return;
      Skipper.dock._containerEl = c;
      Skipper.dock._state = Skipper.dock._loadState();
      Skipper.dock.render();
      Skipper.dock._state.open.forEach(function (n) { Skipper.dock._lazyLoad(n); });
    },

    // Badge/attention on the Escalations toggle; auto-open it when a new item is
    // raised (forced past the cap since escalations take priority). Recomputed on
    // every swap; opts.reset (full task re-render) re-baselines without opening.
    refreshAttention: function (opts) {
      var col = document.querySelector('.mc-outputs__col[data-dock-panel="input"]');
      var btn = document.querySelector('.mc-tab[data-mc-tab="input"]');
      if (!col || !btn) { Skipper.dock._inputCount = undefined; return; }
      var reviews = col.querySelectorAll("[data-mc-pending]").length;
      var openEscalations = col.querySelectorAll('form[hx-post*="/resolve"]').length;
      var count = reviews + openEscalations;
      var badge = btn.querySelector("[data-mc-tab-badge]");
      if (badge) {
        if (count > 0) { badge.textContent = String(count); badge.removeAttribute("hidden"); }
        else { badge.textContent = ""; badge.setAttribute("hidden", ""); }
      }
      btn.classList.toggle("mc-tab--attention", count > 0);

      var prev = Skipper.dock._inputCount;
      Skipper.dock._inputCount = count;
      if (opts && opts.reset) return;
      if (typeof prev !== "number") return;
      if (prev === 0 && count > 0) Skipper.dock.open("input", { force: true });
    },
  };

  // ── Collapsible Sections ──
  Skipper.collapsible = {
    toggle: function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle("sk-collapsible--open");
    },
  };

  // ── Sidebar ──
  // Two viewport modes:
  //  - Desktop (>768px): a 40px rail, closed by default; hovering it slides
  //    the sidebar open as an overlay (pure CSS :hover). The arrow button
  //    PINS it open (--sidebar-pinned, persisted) so it stays out.
  //  - Mobile (≤768px): the sidebar is fixed off-canvas; toggle slides it in
  //    over the content via --sidebar-open. Backdrop click closes; clicking
  //    a task link also closes (handled in the click delegate below).
  Skipper.sidebar = {
    isMobile: function () {
      return typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 768px)").matches;
    },
    toggle: function () {
      var ws = document.getElementById("mc-workspace");
      if (!ws) return;
      if (Skipper.sidebar.isMobile()) {
        ws.classList.toggle("mc-workspace--sidebar-open");
        // Don't persist mobile drawer state — it should default closed on every load.
        return;
      }
      var pinned = ws.classList.toggle("mc-workspace--sidebar-pinned");
      Skipper.prefs.set("sidebarPinned", pinned ? "1" : "0");
    },
    closeMobile: function () {
      var ws = document.getElementById("mc-workspace");
      if (ws) ws.classList.remove("mc-workspace--sidebar-open");
    },
  };

  // ── Outputs Column Resize ──
  Skipper.outputs = {
    _resizing: false,
    _startResize: function (e, dividerIndex) {
      e.preventDefault();
      var container = document.getElementById("mc-outputs");
      if (!container) return;

      // Operate on the VISIBLE columns only — hidden (toggled-off) panels stay in
      // the DOM but must not participate in the resize index math. The divider's
      // index counts from the left among visible columns.
      var cols = Array.prototype.filter.call(
        container.querySelectorAll(".mc-outputs__col"),
        function (c) { return c.style.display !== "none"; }
      );
      if (cols.length < 2) return;
      var leftIdx = dividerIndex;
      var rightIdx = dividerIndex + 1;
      if (!cols[leftIdx] || !cols[rightIdx]) return;

      Skipper.outputs._resizing = true;
      var divider = container.querySelectorAll(".mc-outputs__divider")[dividerIndex];
      if (divider) divider.classList.add("mc-outputs__divider--active");

      var startX = e.clientX;
      var widths = cols.map(function (c) { return c.offsetWidth; });

      function onMove(ev) {
        if (!Skipper.outputs._resizing) return;
        var delta = ev.clientX - startX;
        var newLeft = widths[leftIdx] + delta;
        var newRight = widths[rightIdx] - delta;
        if (newLeft < 120 || newRight < 120) return;
        cols[leftIdx].style.flex = "0 0 " + newLeft + "px";
        cols[rightIdx].style.flex = "0 0 " + newRight + "px";
      }

      function onUp() {
        Skipper.outputs._resizing = false;
        if (divider) divider.classList.remove("mc-outputs__divider--active");
        var saved = cols.map(function (c) { return c.offsetWidth; });
        applyOutputsRatios(cols, saved);
        // Persist per-panel ratios into the dock state so widths survive toggles
        // and reorders (which change column position but not identity).
        if (Skipper.dock && Skipper.dock._state) {
          var total = 0;
          saved.forEach(function (w) { total += Number(w) || 0; });
          if (total > 0) {
            cols.forEach(function (c, i) {
              var n = c.getAttribute("data-dock-panel");
              if (n) Skipper.dock._state.widths[n] = saved[i] / total;
            });
            Skipper.dock._saveState();
          }
        }
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
  };

  // Apply column widths as flex-grow RATIOS (flex-basis:0) so the columns
  // scale with their container — needed because the sidebar can collapse from
  // 260px to 40px (or open as an overlay on mobile), which changes the
  // available width without firing a window resize. Pixel-frozen widths get
  // stuck and leave blank space; ratios reflow.
  function applyOutputsRatios(cols, widths) {
    if (!cols || cols.length === 0) return;
    var total = 0;
    for (var i = 0; i < widths.length; i++) total += Number(widths[i]) || 0;
    if (total <= 0) return;
    widths.forEach(function (w, i) {
      if (!cols[i]) return;
      var ratio = (Number(w) || 0) / total;
      // flex: <grow> <shrink> <basis>. grow proportional to original width,
      // basis 0 so the grow distribution determines the final size.
      cols[i].style.flex = ratio.toFixed(4) + " 1 0";
    });
  }

  function restoreOutputsCols() {
    var container = document.getElementById("mc-outputs");
    if (!container) return;
    var saved = Skipper.prefs.get("outputsCols", "");
    if (!saved) return;
    try {
      var widths = JSON.parse(saved);
      var cols = container.querySelectorAll(".mc-outputs__col");
      applyOutputsRatios(cols, widths);
    } catch (_) {}
  }

  // ── Tree Node Expansion ──
  // expanded Set survives htmx fragment swaps (it's in-memory on window scope).
  // restoreExpanded() runs in afterSwap to re-apply visual state + refetch the
  // line content for nodes the user had opened — the tree fragment's poll wipes
  // the inline terminal HTML on every refresh.
  Skipper.tree = {
    expanded: {},
    toggle: function (instanceId) {
      if (Skipper.tree.expanded[instanceId]) {
        delete Skipper.tree.expanded[instanceId];
        Skipper.tree._collapse(instanceId);
      } else {
        Skipper.tree.expanded[instanceId] = true;
        Skipper.tree._expand(instanceId);
      }
    },
    _expand: function (instanceId) {
      var node = document.querySelector(
        '[data-sk-tree-node="' + instanceId + '"]'
      );
      if (node) node.classList.add("sk-tree__node--expanded");
      var terminal = document.getElementById("tree-terminal-" + instanceId);
      if (!terminal) return;
      terminal.style.display = "block";
      var lines = document.getElementById("tree-terminal-lines-" + instanceId);
      if (!lines) return;
      var src = lines.getAttribute("data-sk-terminal-src");
      if (src && typeof htmx !== "undefined") {
        htmx.ajax("GET", src, { target: "#" + lines.id, swap: "innerHTML" });
      }
      Skipper.terminal.observeAppend("tree-terminal-lines-" + instanceId);
    },
    _collapse: function (instanceId) {
      var node = document.querySelector(
        '[data-sk-tree-node="' + instanceId + '"]'
      );
      if (node) node.classList.remove("sk-tree__node--expanded");
      var terminal = document.getElementById("tree-terminal-" + instanceId);
      if (terminal) terminal.style.display = "none";
    },
    restoreExpanded: function () {
      // After a tree swap, the terminal divs come back collapsed. Walk our
      // expanded set and re-open each (which also refetches the latest output).
      var ids = Object.keys(Skipper.tree.expanded);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var terminal = document.getElementById("tree-terminal-" + id);
        if (!terminal) continue; // node may have exited and disappeared
        if (terminal.style.display !== "block") Skipper.tree._expand(id);
      }
    },
  };

  document.addEventListener("htmx:configRequest", function (e) {
    // Suppress the WS-pushed #mc-main refresh when the user is viewing a
    // task other than the one whose state changed. The push lands as an
    // OOB swap of #mc-main-refresh containing a hidden <div hx-get="/workspace/task/<runningId>"
    // hx-trigger="load" hx-target="#mc-main">. If <runningId> doesn't match
    // the ?task= currently in the URL, abort the request so the user's view
    // (e.g. an open draft form) isn't ripped out.
    var path = e.detail && e.detail.path;
    if (typeof path === "string" && path.indexOf("/workspace/task/") === 0) {
      var trigger = e.target;
      var insideRefresh = trigger && trigger.closest && trigger.closest("#mc-main-refresh");
      if (insideRefresh) {
        var refreshId = path.slice("/workspace/task/".length).split(/[/?#]/)[0];
        var currentId = new URLSearchParams(window.location.search).get("task") || "";
        if (refreshId && currentId && refreshId !== currentId) {
          e.preventDefault();
        }
      }
    }
  });

  // ── Event Delegation ──
  document.addEventListener("click", function (e) {
    // Hooks editor: + Add Hook
    var hookAddBtn = e.target.closest("[data-sk-hooks-add]");
    if (hookAddBtn) {
      var editor = document.getElementById("sk-hooks-editor");
      if (editor) Skipper.hooks.addRow(editor);
      return;
    }

    // Hooks editor: Remove row
    var hookRemoveBtn = e.target.closest("[data-sk-hooks-remove]");
    if (hookRemoveBtn) {
      var row = hookRemoveBtn.closest("[data-sk-hook-row]");
      if (row) row.remove();
      return;
    }

    // Modal backdrop close
    var backdrop = e.target.closest("[data-sk-modal-backdrop]");
    if (backdrop && e.target === backdrop) {
      Skipper.modal.close(backdrop.id);
      return;
    }

    // Modal close button
    var closeBtn = e.target.closest("[data-sk-modal-close]");
    if (closeBtn) {
      Skipper.modal.close(closeBtn.getAttribute("data-sk-modal-close"));
      return;
    }

    // Modal open button
    var openBtn = e.target.closest("[data-sk-modal-open]");
    if (openBtn) {
      Skipper.modal.open(openBtn.getAttribute("data-sk-modal-open"));
      return;
    }

    // Agent tile → instance modal
    var agentTile = e.target.closest("[data-mc-agent-tile]");
    if (agentTile) {
      Skipper.agentModal.open(
        agentTile.getAttribute("data-template-id"),
        agentTile.getAttribute("data-agent-name"),
        agentTile.getAttribute("data-task-id"),
      );
      return;
    }

    // Activity row → detail modal
    var activityRow = e.target.closest("[data-sk-activity-row]");
    if (activityRow && !e.target.closest("a, button")) {
      var raw = activityRow.getAttribute("data-sk-activity-data") || "";
      var agent = activityRow.getAttribute("data-sk-activity-agent") || "";
      var pid = activityRow.getAttribute("data-sk-activity-pid") || "";
      var time = activityRow.getAttribute("data-sk-activity-time") || "";
      var kind = activityRow.getAttribute("data-sk-activity-kind") || "";
      var pretty = raw;
      var trimmed = raw.trim();
      if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
        var toParse = trimmed;
        // Handle newline-delimited JSON: parse the first object only
        if (trimmed.indexOf("\n") !== -1) {
          var firstLine = trimmed.split("\n").find(function(l) { return l.trim().charAt(0) === "{"; });
          if (firstLine) toParse = firstLine.trim();
        }
        try {
          var parsed = JSON.parse(toParse);
          pretty = formatActivityDetail(parsed);
        } catch (err) { /* leave raw */ }
      }
      var titleEl = document.getElementById("activity-detail-modal-title");
      if (titleEl) titleEl.textContent = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1)) : "Activity";
      var metaEl = document.getElementById("activity-detail-modal-meta");
      if (metaEl) {
        var parts = [];
        if (agent) parts.push(agent);
        if (pid) parts.push("PID " + pid);
        if (time) parts.push(time);
        metaEl.textContent = parts.join("  ·  ");
      }
      var bodyEl = document.getElementById("activity-detail-modal-body");
      if (bodyEl) bodyEl.textContent = pretty;
      Skipper.modal.open("activity-detail-modal");
      return;
    }

    // Collapsible toggle
    var collapsible = e.target.closest("[data-sk-collapse]");
    if (collapsible) {
      Skipper.collapsible.toggle(
        collapsible.getAttribute("data-sk-collapse")
      );
      return;
    }

    // Delegation prompt modal — checked BEFORE the tree-toggle so clicking
    // the pill doesn't also collapse/expand the row.
    var delegationOpen = e.target.closest("[data-sk-delegation-open]");
    if (delegationOpen) {
      var delegationId = delegationOpen.getAttribute("data-sk-delegation-open");
      var body = document.getElementById("sk-delegation-modal-body");
      if (body && typeof htmx !== "undefined") {
        body.innerHTML = '<span class="sk-muted">Loading delegation...</span>';
        htmx.ajax("GET", "/fragments/delegations/" + encodeURIComponent(delegationId), {
          target: "#sk-delegation-modal-body",
          swap: "innerHTML",
        });
      }
      Skipper.modal.open("sk-delegation-modal");
      return;
    }

    // Tree node toggle
    var treeNode = e.target.closest("[data-sk-tree-toggle]");
    if (treeNode) {
      Skipper.tree.toggle(treeNode.getAttribute("data-sk-tree-toggle"));
      return;
    }

    // Chat panel toggle
    var chatToggle = e.target.closest("[data-sk-chat-toggle]");
    if (chatToggle) {
      Skipper.chat.toggle();
      return;
    }

    // Sidebar mobile-drawer backdrop — tap to close
    var sidebarClose = e.target.closest("[data-sk-sidebar-close]");
    if (sidebarClose) {
      Skipper.sidebar.closeMobile();
      return;
    }

    // Sidebar collapse toggle
    var sidebarToggle = e.target.closest("[data-sk-sidebar-toggle]");
    if (sidebarToggle) {
      Skipper.sidebar.toggle();
      return;
    }

    // Sidebar task click — update active highlight and auto-close mobile drawer
    var sidebarItem = e.target.closest(".mc-sidebar__item");
    if (sidebarItem) {
      document.querySelectorAll(".mc-sidebar__item--active").forEach(function (el) {
        el.classList.remove("mc-sidebar__item--active");
      });
      sidebarItem.classList.add("mc-sidebar__item--active");
      // On mobile, slide the drawer back out so the user lands on the chosen task.
      if (Skipper.sidebar.isMobile()) Skipper.sidebar.closeMobile();
      // Don't return — let htmx handle the actual navigation
    }

    // Terminal filter button
    var filterBtn = e.target.closest("[data-sk-terminal-filter]");
    if (filterBtn) {
      var termId = filterBtn.getAttribute("data-sk-terminal-id");
      var filter = filterBtn.getAttribute("data-sk-terminal-filter");
      Skipper.terminal.setFilter(termId, filter);
      // Update active state
      var siblings = filterBtn.parentElement.querySelectorAll(
        "[data-sk-terminal-filter]"
      );
      siblings.forEach(function (s) {
        s.classList.remove("sk-terminal__filter-btn--active");
      });
      filterBtn.classList.add("sk-terminal__filter-btn--active");
      return;
    }

    // Activity filter
    var activityFilter = e.target.closest("[data-sk-activity-filter]");
    if (activityFilter) {
      var filter = activityFilter.getAttribute("data-sk-activity-filter");
      var feed = document.querySelector(".mc-activity__feed[data-activity-filter]");
      if (feed) feed.setAttribute("data-activity-filter", filter);
      // Update active state
      activityFilter.parentElement.querySelectorAll("[data-sk-activity-filter]").forEach(function (b) {
        b.classList.remove("mc-activity__filter--active");
      });
      activityFilter.classList.add("mc-activity__filter--active");
      return;
    }

    // Dock panel close (✕ in a column header)
    var dockClose = e.target.closest("[data-dock-close]");
    if (dockClose) {
      Skipper.dock.close(dockClose.getAttribute("data-dock-close"));
      return;
    }

    // Artifact raw/rendered toggle
    var artifactToggle = e.target.closest("[data-sk-artifact-toggle]");
    if (artifactToggle) {
      var container = artifactToggle.closest(".artifact-detail");
      if (container) {
        var rendered = container.querySelector(".artifact-rendered");
        var rawEl = container.querySelector(".artifact-raw");
        var mode = artifactToggle.getAttribute("data-mode") || "rendered";
        if (mode === "rendered") {
          rendered.style.display = "none";
          rawEl.style.display = "block";
          artifactToggle.textContent = "Rendered";
          artifactToggle.setAttribute("data-mode", "raw");
        } else {
          rendered.style.display = "block";
          rawEl.style.display = "none";
          artifactToggle.textContent = "Raw";
          artifactToggle.setAttribute("data-mode", "rendered");
        }
      }
      return;
    }

    // Artifact edit button
    var editBtn = e.target.closest("[data-sk-artifact-edit]");
    if (editBtn) {
      var container = editBtn.closest(".artifact-detail");
      if (container) {
        container.querySelector(".artifact-rendered").style.display = "none";
        container.querySelector(".artifact-raw").style.display = "none";
        container.querySelector(".artifact-edit").style.display = "block";
        var toggle = container.querySelector("[data-sk-artifact-toggle]");
        if (toggle) toggle.style.display = "none";
        editBtn.style.display = "none";
      }
      return;
    }

    // Artifact edit cancel
    var cancelBtn = e.target.closest("[data-sk-artifact-edit-cancel]");
    if (cancelBtn) {
      var container = cancelBtn.closest(".artifact-detail");
      if (container) {
        container.querySelector(".artifact-edit").style.display = "none";
        container.querySelector(".artifact-rendered").style.display = "block";
        container.querySelector(".artifact-raw").style.display = "none";
        var toggle = container.querySelector("[data-sk-artifact-toggle]");
        if (toggle) { toggle.style.display = ""; toggle.textContent = "Raw"; toggle.setAttribute("data-mode", "rendered"); }
        var edit = container.querySelector("[data-sk-artifact-edit]");
        if (edit) edit.style.display = "";
      }
      return;
    }

    // Artifact save (creates new version)
    var saveBtn = e.target.closest("[data-sk-artifact-save]");
    if (saveBtn) {
      var container = saveBtn.closest(".artifact-detail");
      var textarea = container ? container.querySelector(".artifact-edit textarea") : null;
      if (!textarea) return;
      var taskId = saveBtn.getAttribute("data-task-id");
      var artifactName = saveBtn.getAttribute("data-artifact-name");
      var kind = saveBtn.getAttribute("data-artifact-kind") || "other";
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      fetch("/api/tasks/" + encodeURIComponent(taskId) + "/artifacts/" + encodeURIComponent(artifactName), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: textarea.value, kind: kind })
      }).then(function(res) {
        if (!res.ok) throw new Error("Save failed");
        // Re-fetch the fresh detail into whatever container is showing it — the
        // in-panel artifact detail (#sk-artifact-detail) or, for legacy surfaces,
        // a modal body ending in artifact-modal-body.
        var detailHost = container.closest("[data-sk-artifact-detail]") || container.closest("[id$='artifact-modal-body']");
        if (detailHost) {
          var url = "/fragments/tasks/" + encodeURIComponent(taskId) + "/artifacts/" + encodeURIComponent(artifactName);
          htmx.ajax("GET", url, { target: detailHost, swap: "innerHTML" });
        }
      }).catch(function(err) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save failed — retry";
        console.error("Artifact save error:", err);
      });
      return;
    }

    // Dropdown toggle
    var dropdown = e.target.closest("[data-sk-dropdown]");
    if (dropdown) {
      dropdown.classList.toggle("open");
      return;
    }

    // Close open dropdowns on outside click
    document.querySelectorAll("[data-sk-dropdown].open").forEach(function (d) {
      if (!d.contains(e.target)) d.classList.remove("open");
    });
  });

  // Chat panel resize handle + outputs column resize
  document.addEventListener("mousedown", function (e) {
    var resizeHandle = e.target.closest("[data-sk-chat-resize]");
    if (resizeHandle) {
      Skipper.chat._startResize(e);
      return;
    }
    var outputsHandle = e.target.closest("[data-sk-outputs-resize]");
    if (outputsHandle) {
      var idx = parseInt(outputsHandle.getAttribute("data-sk-outputs-resize"), 10);
      Skipper.outputs._startResize(e, idx);
    }
  });

  // Dock column reorder — drag a column header ([data-dock-handle]) onto another
  // column to change the side-by-side order.
  document.addEventListener("dragstart", function (e) {
    var handle = e.target.closest("[data-dock-handle]");
    if (handle && e.dataTransfer) {
      e.dataTransfer.setData("text/x-sk-dock", handle.getAttribute("data-dock-handle"));
      e.dataTransfer.effectAllowed = "move";
    }
  });
  document.addEventListener("dragover", function (e) {
    var col = e.target.closest(".mc-outputs__col[data-dock-panel]");
    if (col && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "text/x-sk-dock") >= 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  });
  document.addEventListener("drop", function (e) {
    var col = e.target.closest(".mc-outputs__col[data-dock-panel]");
    if (!col || !e.dataTransfer) return;
    var name = e.dataTransfer.getData("text/x-sk-dock");
    if (!name) return;
    e.preventDefault();
    var target = col.getAttribute("data-dock-panel");
    if (target && target !== name) Skipper.dock.moveBefore(name, target);
  });

  // Open an artifact inside its own panel (not full-screen). Referenced by the
  // artifact list-item onclick (ARTIFACT_MODAL_VARIANTS openFn).
  window.skOpenArtifactPanel = function () {
    if (window.Skipper && Skipper.dock) Skipper.dock.open("artifacts");
    var win = document.getElementById("sk-artifact-detail-window");
    if (win) { win.hidden = false; win.scrollTop = 0; }
    var d = document.getElementById("sk-artifact-detail");
    if (d) d.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  // Close the artifact inset window (✕) — hide it and drop the detail content so
  // the artifacts list underneath is shown again.
  document.addEventListener("click", function (e) {
    var closeBtn = e.target.closest && e.target.closest("[data-sk-artifact-close]");
    if (!closeBtn) return;
    e.preventDefault();
    var win = document.getElementById("sk-artifact-detail-window");
    if (win) win.hidden = true;
    var d = document.getElementById("sk-artifact-detail");
    if (d) d.innerHTML = "";
  });

  // Escape key: close modals
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      var openModal = document.querySelector(".sk-modal--open");
      if (openModal) {
        Skipper.modal.close(openModal.id);
      }
      return;
    }

    // Enter/Space on a focused agent orb opens its instance modal.
    if (e.key === "Enter" || e.key === " ") {
      var tile = e.target.closest && e.target.closest("[data-mc-agent-tile]");
      if (tile) {
        e.preventDefault();
        Skipper.agentModal.open(
          tile.getAttribute("data-template-id"),
          tile.getAttribute("data-agent-name"),
          tile.getAttribute("data-task-id"),
        );
      }
    }
  });

  // ── Chat "hide tools" filter ──
  // Persisted in localStorage and reapplied after every HTMX settle. It must
  // run on afterSettle, not from an inline fragment script: htmx's settle
  // phase (~20ms after a swap) restores the incoming element's original
  // attributes, wiping any class an inline script added during the swap.
  var CHAT_HIDE_TOOLS_KEY = "skipper.chat.hideToolCalls";
  function applyChatToolFilter() {
    var boxes = document.querySelectorAll(".chat-filter-tool-calls");
    if (boxes.length === 0) return;
    var on = localStorage.getItem(CHAT_HIDE_TOOLS_KEY) === "1";
    boxes.forEach(function (box) {
      box.checked = on;
    });
    document.querySelectorAll(".chat-messages").forEach(function (msgs) {
      msgs.classList.toggle("hide-tool-calls", on);
    });
  }
  document.addEventListener("change", function (e) {
    if (!e.target.matches || !e.target.matches(".chat-filter-tool-calls")) return;
    localStorage.setItem(CHAT_HIDE_TOOLS_KEY, e.target.checked ? "1" : "0");
    applyChatToolFilter();
  });
  document.addEventListener("htmx:afterSettle", applyChatToolFilter);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyChatToolFilter);
  } else {
    applyChatToolFilter();
  }

  // ── Chat busy indicator ──
  // The busy indicator is server-driven: the conversation manager emits
  // `conversation:busy_changed` whenever the agent process starts or finishes
  // a turn, and the WS push layer broadcasts an OOB swap to the
  // `#chat-busy-{conversationId}` slot. The client only needs to do one
  // thing — show an optimistic indicator the moment the user submits a
  // message, so the user gets sub-roundtrip feedback. Once the server's
  // WS push lands, it overwrites the slot via hx-swap-oob.
  document.addEventListener("htmx:afterRequest", function (evt) {
    var form = evt.detail.elt;
    if (!form || !form.closest || !form.closest(".chat-input-area")) return;
    if (!evt.detail.successful) return;
    document.querySelectorAll(".chat-busy").forEach(function (slot) {
      if (slot.getAttribute("data-busy") === "1") return;
      var msgs = slot.previousElementSibling;
      var model =
        (msgs && msgs.classList && msgs.classList.contains("chat-messages")
          ? msgs.getAttribute("data-chat-model")
          : null) || "skipper";
      var modelEsc = model.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      slot.setAttribute("data-busy", "1");
      slot.innerHTML =
        '<div class="chat-busy__bubble"><span class="chat-busy__label">' +
        modelEsc +
        '</span><span class="chat-typing-dots"><span></span><span></span><span></span></span></div>';
    });
  });

  // ── HTMX Integration ──
  document.addEventListener("htmx:afterSwap", function (evt) {
    // (Re)initialize the panel dock when a task view is (re)inserted; no-op on
    // partial fragment swaps that leave #mc-outputs in place. Restores the
    // persisted open-set / order / column widths.
    Skipper.dock.init();

    // Flag the Escalations panel when review/escalation content lands in it. A
    // full task re-render (target #mc-main) re-baselines instead of auto-opening.
    var tgt = evt && evt.detail && evt.detail.target;
    Skipper.dock.refreshAttention(tgt && tgt.id === "mc-main" ? { reset: true } : undefined);

    renderMarkdownBlocks();

    // Re-initialize terminal observers for newly swapped content
    document
      .querySelectorAll("[data-sk-terminal-autoscroll]")
      .forEach(function (el) {
        Skipper.terminal.observeAppend(el.id);
      });

    // Re-initialize chat scroll
    document
      .querySelectorAll("[data-sk-chat-autoscroll]")
      .forEach(function (el) {
        Skipper.chat.scrollToBottom(el.id);
      });

    // Re-apply expand state to agent tree nodes after a tree swap
    if (Skipper.tree) Skipper.tree.restoreExpanded();
  });

  // WS ping + notification handler
  var notifAudioCache = {};
  function notifPlay(url) {
    var a = notifAudioCache[url];
    if (!a) {
      a = new Audio(url);
      a.preload = "auto";
      notifAudioCache[url] = a;
    }
    try {
      a.currentTime = 0;
      var p = a.play();
      if (p && typeof p.catch === "function") p.catch(function () { /* autoplay blocked */ });
    } catch (e) { /* ignore */ }
  }
  document.addEventListener("htmx:wsBeforeMessage", function (evt) {
    var raw = evt.detail && evt.detail.message;
    if (typeof raw !== "string" || raw.charCodeAt(0) !== 123 /* { */) return;
    try {
      var data = JSON.parse(raw);
      if (data && data.type === "ping") {
        evt.preventDefault();
        return;
      }
      if (data && data.__sk_notify && data.__sk_notify.kind === "audio") {
        notifPlay(data.__sk_notify.sound);
        evt.preventDefault();
        return;
      }
    } catch (e) {
      // Not JSON — HTML fragment, let htmx handle it
    }
  });

  // ── Chat Panel Restore ──
  // Restore chat panel visibility from localStorage on page load
  document.addEventListener("DOMContentLoaded", function () {
    var wasOpen = Skipper.prefs.get("chatPanelOpen", "0") === "1";
    if (wasOpen) {
      var workspace = document.getElementById("mc-workspace");
      var panel = document.getElementById("mc-chat-panel");
      if (workspace && panel) {
        workspace.classList.add("mc-workspace--chat-open");
        var savedHeight = Skipper.prefs.get("chatPanelHeight", "");
        if (savedHeight) panel.style.height = savedHeight;
        document.querySelectorAll("[data-sk-chat-toggle].mc-chat-toggle").forEach(function (btn) {
          btn.classList.add("mc-chat-toggle--active");
        });
      }
    }

    // Restore sidebar pinned state — desktop only. Default is the closed
    // hover-to-open rail; on mobile the drawer is always closed on load.
    if (!Skipper.sidebar.isMobile() && Skipper.prefs.get("sidebarPinned", "0") === "1") {
      var ws = document.getElementById("mc-workspace");
      if (ws) ws.classList.add("mc-workspace--sidebar-pinned");
    }

    // Initialize the panel dock on first (server-rendered) load — afterSwap
    // handles subsequent sidebar-click task swaps.
    Skipper.dock.init();

    renderMarkdownBlocks();
  });

  // Render markdown in any [data-artifact-md] block. Used for agent-authored
  // text (notes, escalations, chat messages) — content is server-escaped so
  // .textContent recovers the raw source for marked to parse. Idempotent: each
  // element is rendered at most once via the data-rendered flag.
  function renderMarkdownBlocks(root) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll("[data-artifact-md]").forEach(function (el) {
      if (el.dataset.rendered) return;
      el.dataset.rendered = "1";
      var raw = el.textContent;
      if (typeof marked !== "undefined" && raw) {
        try {
          marked.setOptions({ breaks: true, gfm: true });
          el.innerHTML = marked.parse(raw);
        } catch (e) { /* leave as text */ }
      }
    });
  }

  // OOB swaps (WebSocket-pushed chat messages, notes, escalations) bypass
  // htmx:afterSwap — listen on oobAfterSwap too so streaming content renders.
  document.addEventListener("htmx:oobAfterSwap", function (evt) {
    renderMarkdownBlocks(evt && evt.detail ? evt.detail.target : null);
  });
  document.addEventListener("htmx:wsAfterMessage", function () {
    renderMarkdownBlocks();
  });

  // Expose globally
  window.Skipper = Skipper;

  // Global chat fullscreen toggle expected by v1 chat fragments
  window.toggleChatFullscreen = function () {
    var chatPanel = document.getElementById("mc-chat-panel");
    if (!chatPanel) {
      // Fallback for v1 dashboard
      var panel = document.getElementById("dashboard-chat-panel");
      if (panel) panel.classList.toggle("chat-fullscreen");
      return;
    }
    var isFs = chatPanel.classList.contains("mc-chat-panel--fullscreen");
    if (isFs) {
      chatPanel.classList.remove("mc-chat-panel--fullscreen");
      chatPanel.style.height = Skipper.prefs.get("chatPanelHeight", "300px");
    } else {
      chatPanel.classList.add("mc-chat-panel--fullscreen");
      chatPanel.style.height = "100%";
      var msgs = chatPanel.querySelector(".chat-messages");
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
  };

  // Global artifact modal helpers expected by v1 fragments
  window.openTaskArtifactModal = function () {
    var modal = document.getElementById("task-artifact-modal") || document.getElementById("dashboard-artifact-modal");
    if (modal) {
      Skipper.modal.open(modal.id);
    }
  };
  window.closeTaskArtifactModal = function () {
    var modal = document.getElementById("task-artifact-modal") || document.getElementById("dashboard-artifact-modal");
    if (modal) {
      Skipper.modal.close(modal.id);
    }
  };
  window.openDashboardArtifactModal = window.openTaskArtifactModal;
  window.closeDashboardArtifactModal = window.closeTaskArtifactModal;

  window.syncDashboardInlineTaskTitle = function (textarea) {
    var titleInput = document.getElementById("dashboard-inline-title-input");
    var hidden = document.getElementById("dashboard-inline-title");
    if (!hidden) return;
    if (titleInput && titleInput.value.trim()) return;
    var first = (textarea.value || "").split("\n")[0].trim();
    hidden.value = first.slice(0, 120);
  };

  window.prepareDashboardInlineTaskSubmit = function (form) {
    var titleInput = document.getElementById("dashboard-inline-title-input");
    var hidden = document.getElementById("dashboard-inline-title");
    if (hidden && titleInput) {
      hidden.value = titleInput.value.trim() || hidden.value || "Untitled task";
    }
    return true;
  };
  // ── Config: team edit helpers ──
  Skipper.submitTeamEdit = function (teamId) {
    var form = document.getElementById("team-edit-form-" + teamId);
    if (!form) return;
    var payload = {
      name: form.querySelector('[name="name"]').value,
      goal: form.querySelector('[name="goal"]').value,
      entrypoint_agent_id: form.querySelector('[name="entrypoint_agent_id"]').value || null,
      phases: [],
      members: [],
    };
    form.querySelectorAll(".sk-phase-edit").forEach(function (el) {
      var phase = {
        name: el.querySelector('[data-phase-field="name"]').value,
        prompt: el.querySelector('[data-phase-field="prompt"]').value,
      };
      var reviewCb = el.querySelector('[data-phase-field="review"]');
      if (reviewCb && reviewCb.checked) phase.review = true;
      var conDetails = el.querySelector(".sk-phase-edit__consensus");
      if (conDetails && conDetails.open) {
        var agentCount = el.querySelector('[data-phase-field="consensus_agent_count"]');
        var strategy = el.querySelector('[data-phase-field="consensus_strategy"]');
        var worktreeCb = el.querySelector('[data-phase-field="consensus_worktree"]');
        var reviewer = el.querySelector('[data-phase-field="consensus_reviewer_agent_id"]');
        phase.consensus = {
          agent_count: parseInt(agentCount.value, 10) || 2,
          strategy: strategy.value || "best_of",
          worktree: worktreeCb ? worktreeCb.checked : false,
        };
        if (reviewer && reviewer.value) phase.consensus.reviewer_agent_id = reviewer.value;
      }
      payload.phases.push(phase);
    });
    form.querySelectorAll(".sk-member-edit").forEach(function (el) {
      payload.members.push({
        agent_id: el.querySelector('[data-member-field="agent_id"]').value,
        role: el.querySelector('[data-member-field="role"]').value || null,
        level: parseInt(el.querySelector('[data-member-field="level"]').value, 10) || 0,
        parent_agent_id: null,
      });
    });
    fetch("/api/config/teams/" + teamId, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      if (!resp.ok) throw new Error("Save failed");
      return resp.text();
    }).then(function (html) {
      var targetRow = document.getElementById("team-row-" + teamId);
      var editRow = document.getElementById("team-edit-" + teamId);
      if (targetRow) {
        targetRow.outerHTML = html;
        htmx.process(document.getElementById("team-row-" + teamId));
      }
      if (editRow) editRow.remove();
    }).catch(function (err) {
      console.error("[config] team save error:", err);
    });
  };

  Skipper.addPhaseForm = function (form) {
    var container = form.querySelector('[id^="team-phases-"]');
    if (!container) return;
    var idx = container.querySelectorAll(".sk-phase-edit").length;
    var div = document.createElement("div");
    div.className = "sk-phase-edit";
    div.setAttribute("data-phase-index", idx);
    div.innerHTML = '<div class="sk-phase-edit__header">' +
      '<span class="sk-phase-edit__number">' + (idx + 1) + '</span>' +
      '<input type="text" data-phase-field="name" value="" class="sk-input sk-input--sm" placeholder="Phase name" style="flex:1;">' +
      '<div class="sk-phase-edit__header-actions">' +
      '<button type="button" class="sk-btn sk-btn--sm" title="Move up" onclick="Skipper.movePhase(this,-1)">&#x25B2;</button>' +
      '<button type="button" class="sk-btn sk-btn--sm" title="Move down" onclick="Skipper.movePhase(this,1)">&#x25BC;</button>' +
      '<button type="button" class="sk-btn sk-btn--danger sk-btn--sm" onclick="this.closest(\'.sk-phase-edit\').remove()">&#x2715;</button>' +
      '</div></div>' +
      '<div class="sk-phase-edit__body">' +
      '<div class="sk-inline-edit-form__field">' +
      '<span class="sk-inline-edit-form__label">Prompt</span>' +
      '<span class="sk-inline-edit-form__hint">Instructions given to the entrypoint agent when this phase begins.</span>' +
      '<textarea data-phase-field="prompt" rows="3" class="sk-textarea sk-textarea--sm" style="font-family:var(--sk-font-mono);font-size:11px;"></textarea>' +
      '</div>' +
      '<div class="sk-phase-edit__review-toggle">' +
      '<label class="sk-phase-edit__review-label">' +
      '<input type="checkbox" data-phase-field="review" onchange="this.closest(\'.sk-phase-edit__review-toggle\').classList.toggle(\'sk-phase-edit__review-toggle--active\',this.checked)">' +
      '<div><strong>Review gate</strong>' +
      '<span class="sk-inline-edit-form__hint" style="display:block;margin-top:2px;">Pause after this phase completes and wait for operator approval before advancing.</span>' +
      '</div></label></div>' +
      '<details class="sk-phase-edit__consensus">' +
      '<summary>Consensus settings</summary>' +
      '<div class="sk-inline-edit-form__hint" style="margin-bottom:var(--sk-space-2);">Run multiple agents in parallel on this phase and merge or select the best result.</div>' +
      '<div class="sk-phase-edit__consensus-fields">' +
      '<div class="sk-inline-edit-form__field"><span class="sk-inline-edit-form__label">Agent count</span>' +
      '<input type="number" data-phase-field="consensus_agent_count" value="2" min="1" max="10" class="sk-input sk-input--sm" style="width:70px;"></div>' +
      '<div class="sk-inline-edit-form__field"><span class="sk-inline-edit-form__label">Strategy</span>' +
      '<select data-phase-field="consensus_strategy" class="sk-select sk-select--sm"><option value="best_of">best_of</option><option value="majority">majority</option><option value="merge">merge</option></select></div>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:var(--sk-text-xs);color:var(--sk-text-muted);align-self:end;padding-bottom:4px;">' +
      '<input type="checkbox" data-phase-field="consensus_worktree"> Isolate in worktrees</label>' +
      '<div class="sk-inline-edit-form__field"><span class="sk-inline-edit-form__label">Reviewer agent</span>' +
      '<select data-phase-field="consensus_reviewer_agent_id" class="sk-select sk-select--sm"><option value="">— none —</option></select></div>' +
      '</div></details></div>';
    container.appendChild(div);
  };

  Skipper.addMemberRow = function (form) {
    var container = form.querySelector('[id^="team-members-"]');
    if (!container) return;
    var idx = container.querySelectorAll(".sk-member-edit").length;
    var agentSelect = form.querySelector('[name="entrypoint_agent_id"]');
    var optionsHtml = agentSelect ? agentSelect.innerHTML.replace('selected', '') : '<option value="">— none —</option>';
    var tr = document.createElement("tr");
    tr.className = "sk-member-edit";
    tr.setAttribute("data-member-index", idx);
    tr.innerHTML = '<td><select data-member-field="agent_id" class="sk-select sk-select--sm" style="width:100%;">' + optionsHtml + '</select></td>' +
      '<td><input type="text" data-member-field="role" value="" class="sk-input sk-input--sm" placeholder="e.g. developer, qa" style="width:100%;"></td>' +
      '<td><input type="number" data-member-field="level" value="0" min="0" max="10" class="sk-input sk-input--sm" style="width:100%;"></td>' +
      '<td><button type="button" class="sk-btn sk-btn--danger sk-btn--sm" onclick="this.closest(\'.sk-member-edit\').remove()">&#x2715;</button></td>';
    container.appendChild(tr);
  };

  Skipper.movePhase = function (btn, direction) {
    var phase = btn.closest(".sk-phase-edit");
    var container = phase.parentElement;
    var phases = Array.from(container.querySelectorAll(".sk-phase-edit"));
    var idx = phases.indexOf(phase);
    var targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= phases.length) return;
    if (direction === -1) {
      container.insertBefore(phase, phases[targetIdx]);
    } else {
      container.insertBefore(phase, phases[targetIdx].nextSibling);
    }
    container.querySelectorAll(".sk-phase-edit").forEach(function (el, i) {
      var num = el.querySelector(".sk-phase-edit__number");
      if (num) num.textContent = (i + 1);
    });
  };

  // --- Live relative-timestamp updater ---
  function relativeTime(epochMs) {
    var diff = Date.now() - epochMs;
    var abs = Math.abs(diff);
    var sec = Math.floor(abs / 1000);
    var min = Math.floor(sec / 60);
    var hr = Math.floor(min / 60);
    var day = Math.floor(hr / 24);
    if (sec < 60) return "just now";
    if (diff >= 0) {
      if (min < 60) return min + "m ago";
      if (hr < 10) return hr + "h " + (min % 60) + "m ago";
      if (hr < 24) return hr + "h ago";
      if (day < 30) return day + "d ago";
      return new Date(epochMs).toLocaleDateString();
    }
    if (min < 60) return "in " + min + "m";
    if (hr < 10) return "in " + hr + "h " + (min % 60) + "m";
    if (hr < 24) return "in " + hr + "h";
    if (day < 30) return "in " + day + "d";
    return new Date(epochMs).toLocaleDateString();
  }
  function refreshTimestamps() {
    document.querySelectorAll("[data-ts]").forEach(function (el) {
      var ts = parseInt(el.getAttribute("data-ts"), 10);
      if (isNaN(ts)) return;
      el.textContent = relativeTime(ts);
    });
  }
  setInterval(refreshTimestamps, 30000);
  document.addEventListener("htmx:afterSettle", refreshTimestamps);

})(window, document);
