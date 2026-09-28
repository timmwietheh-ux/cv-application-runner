/* ==========================================================================
   app.js — LaTeX Runner, single-page controller.

   Sections
     1  constants & state          8  outline
     2  small utilities            9  review comments
     3  API layer                 10  git
     4  Monaco bootstrap          11  tool runners & console
     5  documents, tabs, saving   12  pdf, compile, logs, SyncTeX
     6  language intelligence     13  markdown preview
     7  file explorer             14  settings, shortcuts, boot
   ========================================================================== */
(function () {
  "use strict";

  /* ====================================================================== */
  /* 1. Constants & state                                                    */
  /* ====================================================================== */

  var MONACO_VS = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs";
  var PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  /* Filetype -> Font Awesome class + colour class (see style.css). */
  var FILE_ICONS = {
    tex: ["fa-solid fa-file-lines", "ic-tex"],
    sty: ["fa-solid fa-file-code", "ic-tex"],
    cls: ["fa-solid fa-file-code", "ic-tex"],
    ltx: ["fa-solid fa-file-lines", "ic-tex"],
    def: ["fa-solid fa-file-code", "ic-tex"],
    py: ["fa-brands fa-python", "ic-py"],
    ipynb: ["fa-brands fa-python", "ic-py"],
    jl: ["fa-solid fa-circle-nodes", "ic-jl"],
    bib: ["fa-solid fa-book-bookmark", "ic-bib"],
    md: ["fa-brands fa-markdown", "ic-md"],
    markdown: ["fa-brands fa-markdown", "ic-md"],
    ps1: ["fa-solid fa-terminal", "ic-shell"],
    psm1: ["fa-solid fa-terminal", "ic-shell"],
    sh: ["fa-solid fa-terminal", "ic-shell"],
    bash: ["fa-solid fa-terminal", "ic-shell"],
    bat: ["fa-solid fa-terminal", "ic-shell"],
    cmd: ["fa-solid fa-terminal", "ic-shell"],
    c: ["fa-solid fa-file-code", "ic-cpp"],
    h: ["fa-solid fa-file-code", "ic-cpp"],
    cpp: ["fa-solid fa-file-code", "ic-cpp"],
    cc: ["fa-solid fa-file-code", "ic-cpp"],
    hpp: ["fa-solid fa-file-code", "ic-cpp"],
    java: ["fa-brands fa-java", "ic-cpp"],
    rs: ["fa-solid fa-file-code", "ic-cpp"],
    js: ["fa-brands fa-js", "ic-cfg"],
    json: ["fa-solid fa-gear", "ic-cfg"],
    toml: ["fa-solid fa-gear", "ic-cfg"],
    yaml: ["fa-solid fa-gear", "ic-cfg"],
    yml: ["fa-solid fa-gear", "ic-cfg"],
    ini: ["fa-solid fa-gear", "ic-cfg"],
    cfg: ["fa-solid fa-gear", "ic-cfg"],
    csv: ["fa-solid fa-table", "ic-cfg"],
    pdf: ["fa-solid fa-file-pdf", "ic-pdf"],
    png: ["fa-solid fa-file-image", "ic-img"],
    jpg: ["fa-solid fa-file-image", "ic-img"],
    jpeg: ["fa-solid fa-file-image", "ic-img"],
    gif: ["fa-solid fa-file-image", "ic-img"],
    svg: ["fa-solid fa-file-image", "ic-img"],
    webp: ["fa-solid fa-file-image", "ic-img"],
    txt: ["fa-solid fa-file-lines", "ic-default"],
    log: ["fa-solid fa-file-lines", "ic-default"],
    lnk: ["fa-solid fa-link", "ic-default"],
  };

  var LANGUAGE_BY_EXT = {
    tex: "latex", sty: "latex", cls: "latex", ltx: "latex", def: "latex", bbx: "latex", cbx: "latex",
    bib: "bibtex",
    py: "python", ipynb: "json",
    jl: "julia",
    md: "markdown", markdown: "markdown",
    ps1: "powershell", psm1: "powershell",
    sh: "shell", bash: "shell",
    bat: "bat", cmd: "bat",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    java: "java", rs: "rust", go: "go", js: "javascript", ts: "typescript",
    json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
    html: "html", css: "css", xml: "xml", sql: "sql", r: "r", csv: "plaintext",
    txt: "plaintext", log: "plaintext", gitignore: "plaintext",
  };

  var BINARY_EXT = /\.(pdf|png|jpe?g|gif|webp|bmp|ico|zip|gz|7z|rar|exe|dll|pyc|woff2?|ttf|otf|mp4|mp3|xlsx?|docx?|pptx?|lnk)$/i;

  var state = {
    monacoReady: false,
    editor: null,
    splitEditor: null,
    diffEditor: null,
    docs: Object.create(null), /* path -> model plus disk version/stamp */
    order: [], /* open tab order */
    active: null,
    tree: null,
    treeIndex: [], /* flat list of file paths */
    expanded: new Set(),
    catalogueExpanded: new Set(),
    numericsTreeInitialized: false,
    workspaceMode: "latex",
    workspaceTabs: {
      latex: { order: [], active: null },
      numerics: { order: [], active: null },
    },
    fullRepository: false,
    numerics: { enabled: false, root: "Numerics", pipelines: [], groups: [], categories: [], figures: [], measurements: [] },
    selectedPipeline: null,
    selectedArtifact: null,
    selectedMeasurement: null,
    numericsResultMode: "figures",
    outline: { outline: [], labels: [], figures: [], equations: [] },
    comments: [],
    replyDrafts: Object.create(null),
    commentFilter: "open",
    commentDecorations: null,
    syncDecorations: null,
    pendingSelection: null,
    settings: null,
    project: null,
    pdf: null,
    pdfAvailable: false,
    pdfStamp: null,
    compiling: false,
    compileQueued: false,
    compileSession: null,
    compileStarted: 0,
    compileTimer: 0,
    compileRetryTimer: 0,
    logs: { errors: [], warnings: [], bad_boxes: [], raw: "" },
    logFilter: "all",
    consoleSessions: [],
    activeConsole: null,
    nextConsoleId: 1,
    diffPath: null,
    mdPreview: false,
    gitStatus: null,
    gitCollapsedGroups: new Set(),
    runners: { categories: [] },
    dragRunner: null,
    editingRunner: null,
    ai: null,
    liveTimer: null,
    liveBusy: false,
    connectionLost: false,
  };

  var $ = function (id) { return document.getElementById(id); };
  var dom = {};

  /* ====================================================================== */
  /* 2. Utilities                                                            */
  /* ====================================================================== */

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function extOf(path) {
    var name = String(path).split("/").pop();
    var dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  function baseName(path) { return String(path).split("/").pop(); }

  function iconFor(path) {
    return FILE_ICONS[extOf(path)] || ["fa-solid fa-file", "ic-default"];
  }

  function languageFor(path) {
    return LANGUAGE_BY_EXT[extOf(path)] || "plaintext";
  }

  function toast(message, kind, timeout) {
    var el = document.createElement("div");
    var icons = {
      success: "fa-circle-check",
      error: "fa-circle-exclamation",
      warn: "fa-triangle-exclamation",
      info: "fa-circle-info",
    };
    kind = kind || "info";
    el.className = "toast " + kind;
    el.innerHTML = '<i class="fa-solid ' + (icons[kind] || icons.info) + '"></i><span>' +
      escapeHtml(message) + "</span>";
    dom.toasts.appendChild(el);
    setTimeout(function () {
      el.classList.add("leaving");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, timeout || 3200);
  }

  function setStatusMessage(message, kind) {
    dom.statusMessage.textContent = message || "";
    dom.statusMessage.className = kind || "";
    if (message) {
      clearTimeout(setStatusMessage._t);
      setStatusMessage._t = setTimeout(function () {
        dom.statusMessage.textContent = "";
        dom.statusMessage.className = "";
      }, 4000);
    }
  }

  function openModal(id) {
    var modal = $(id);
    if (modal) modal.classList.add("open");
  }
  function closeModal(id) {
    var modal = $(id);
    if (modal) CommentDictation.cancel(modal);
    if (modal) modal.classList.remove("open");
  }

  function promptDialog(title, message, initial) {
    return new Promise(function (resolve) {
      $("prompt-title").textContent = title;
      $("prompt-message").innerHTML = message;
      var input = $("prompt-input");
      input.value = initial || "";
      openModal("modal-prompt");
      setTimeout(function () { input.focus(); input.select(); }, 40);

      function cleanup(value) {
        $("btn-prompt-ok").removeEventListener("click", onOk);
        input.removeEventListener("keydown", onKey);
        $("modal-prompt").removeEventListener("click", onBackdrop);
        closeModal("modal-prompt");
        resolve(value);
      }
      function onOk() { cleanup(input.value.trim() || null); }
      function onKey(event) {
        if (event.key === "Enter") { event.preventDefault(); onOk(); }
        if (event.key === "Escape") cleanup(null);
      }
      function onBackdrop(event) {
        if (event.target.id === "modal-prompt" || event.target.dataset.close) cleanup(null);
      }
      $("btn-prompt-ok").addEventListener("click", onOk);
      input.addEventListener("keydown", onKey);
      $("modal-prompt").addEventListener("click", onBackdrop);
    });
  }

  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      $("confirm-title").textContent = title;
      $("confirm-message").innerHTML = message;
      var ok = $("btn-confirm-ok");
      ok.textContent = okLabel || "Confirm";
      openModal("modal-confirm");

      function cleanup(value) {
        ok.removeEventListener("click", onOk);
        $("modal-confirm").removeEventListener("click", onBackdrop);
        closeModal("modal-confirm");
        resolve(value);
      }
      function onOk() { cleanup(true); }
      function onBackdrop(event) {
        if (event.target.id === "modal-confirm" || event.target.dataset.close) cleanup(false);
      }
      ok.addEventListener("click", onOk);
      $("modal-confirm").addEventListener("click", onBackdrop);
    });
  }

  function showContextMenu(event, items) {
    var menu = dom.contextMenu;
    menu.innerHTML = "";
    items.forEach(function (item) {
      if (item === "-") {
        var sep = document.createElement("div");
        sep.className = "ctx-sep";
        menu.appendChild(sep);
        return;
      }
      var button = document.createElement("button");
      if (item.danger) button.className = "danger";
      button.innerHTML = '<i class="fa-solid ' + item.icon + '"></i><span>' +
        escapeHtml(item.label) + "</span>";
      button.addEventListener("click", function () {
        hideContextMenu();
        item.action();
      });
      menu.appendChild(button);
    });
    menu.hidden = false;
    var rect = menu.getBoundingClientRect();
    var x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
    var y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
  }
  function hideContextMenu() { dom.contextMenu.hidden = true; }

  /* SGR-aware console rendering. */
  var ANSI_FG = {
    30: "c-dim", 31: "c-err", 32: "c-ok", 33: "c-warn", 34: "c-info",
    35: "c-cmd", 36: "c-info", 37: "", 90: "c-dim", 91: "c-err", 92: "c-ok",
    93: "c-warn", 94: "c-info", 95: "c-cmd", 96: "c-info", 97: "",
  };

  function ansiToHtml(text) {
    var out = "";
    var open = false;
    var index = 0;
    var pattern = /\x1b\[([0-9;]*)m|\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      out += escapeHtml(text.slice(index, match.index));
      index = pattern.lastIndex;
      if (match[1] === undefined) continue; /* non-SGR sequence: drop it */
      var codes = match[1].split(";").filter(Boolean).map(Number);
      if (!codes.length || codes.indexOf(0) !== -1) {
        if (open) { out += "</span>"; open = false; }
        continue;
      }
      var cls = "";
      codes.forEach(function (code) { if (ANSI_FG[code] !== undefined) cls = ANSI_FG[code]; });
      if (open) { out += "</span>"; open = false; }
      if (cls) { out += '<span class="' + cls + '">'; open = true; }
    }
    out += escapeHtml(text.slice(index));
    if (open) out += "</span>";
    return out;
  }

  /* Word-boundary matching keeps identifiers such as "relative_error" plain. */
  function classifyConsoleLine(line) {
    if (/^\[exit code 0\]/.test(line)) return "c-ok";
    if (/^\[exit code /.test(line)) return "c-err";
    if (/^\s*!\s/.test(line)) return "c-err";
    if (/(^|[^\w])(errors?|failed|failure|fatal|traceback|exception)([^\w]|$)/i.test(line)) return "c-err";
    if (/(^|[^\w])(warnings?|overfull|underfull|deprecated)([^\w]|$)/i.test(line)) return "c-warn";
    if (/(^|[^\w])(ok|pass(ed)?|success(ful)?|succeeded)([^\w]|$)/i.test(line)) return "c-ok";
    return "";
  }

  function findConsoleSession(id) {
    return state.consoleSessions.filter(function (session) { return session.id === id; })[0] || null;
  }

  function renderConsoleTabs() {
    dom.consoleTabs.innerHTML = "";
    state.consoleSessions.forEach(function (session) {
      var tab = document.createElement("button");
      tab.className = "console-tab " + session.status + (session.id === state.activeConsole ? " active" : "");
      tab.title = session.label + (session.command ? "\n" + session.command : "");
      tab.innerHTML = '<span class="session-dot"></span><span class="session-label">' +
        escapeHtml(session.label) + '</span><span class="session-close" title="Close this console"><i class="fa-solid fa-xmark"></i></span>';
      tab.addEventListener("click", function (event) {
        if (event.target.closest(".session-close")) closeConsoleSession(session.id);
        else selectConsoleSession(session.id);
      });
      dom.consoleTabs.appendChild(tab);
    });
    var active = findConsoleSession(state.activeConsole);
    dom.consoleEmpty.hidden = state.consoleSessions.length > 0;
    dom.drawerContext.textContent = active ? active.label : "";
    dom.numericsConsoleContext.textContent = active ? active.label : "";
    dom.btnStopConsole.disabled = !active || active.status !== "running";
    dom.btnNumericsStop.disabled = !active || active.status !== "running";
    dom.btnStopNumerics.hidden = !active || active.status !== "running";
    $("btn-clear-console").disabled = !active;
    dom.btnNumericsClear.disabled = !active;
  }

  function selectConsoleSession(id) {
    if (!findConsoleSession(id)) return;
    state.activeConsole = id;
    Array.prototype.forEach.call(dom.consoleSessions.querySelectorAll(".console-session"), function (output) {
      output.classList.toggle("active", output.dataset.session === id);
    });
    renderConsoleTabs();
  }

  function createConsoleSession(label, command, options) {
    options = options || {};
    var id = "job_" + Date.now().toString(36) + "_" + state.nextConsoleId++;
    var session = {
      id: id,
      label: label || command || "Console",
      command: command || "",
      status: options.status || "running",
      source: null,
      exitCode: null,
      onDone: options.onDone || null,
      doneCalled: false,
    };
    state.consoleSessions.push(session);
    var output = document.createElement("pre");
    output.className = "console console-session scroll-y";
    output.dataset.session = id;
    dom.consoleSessions.appendChild(output);
    if (options.activate === false) renderConsoleTabs();
    else selectConsoleSession(id);
    if (options.open !== false) {
      if (state.workspaceMode === "numerics") syncConsoleHome();
      else openDrawer("drawer-console");
    }

    var completed = state.consoleSessions.filter(function (item) { return item.status !== "running"; });
    while (completed.length > 18) {
      closeConsoleSession(completed.shift().id, true);
    }
    return session;
  }

  function consoleOutput(sessionId) {
    return dom.consoleSessions.querySelector('.console-session[data-session="' + sessionId + '"]');
  }

  /* Console output is buffered and written once per frame: a LaTeX run emits
     thousands of lines, and one layout per line would freeze the page. */
  var consoleQueue = Object.create(null);
  var consoleFlushPending = false;
  var CONSOLE_NODE_LIMIT = 16000;

  function flushConsole() {
    if (!consoleFlushPending) return;
    consoleFlushPending = false;
    Object.keys(consoleQueue).forEach(function (id) {
      var parts = consoleQueue[id];
      delete consoleQueue[id];
      var output = consoleOutput(id);
      if (!output || !parts.length) return;
      var pinned = output.scrollTop + output.clientHeight >= output.scrollHeight - 30;
      output.insertAdjacentHTML("beforeend", parts.join(""));
      var excess = output.childNodes.length - CONSOLE_NODE_LIMIT;
      while (excess-- > 0 && output.firstChild) output.removeChild(output.firstChild);
      if (pinned) output.scrollTop = output.scrollHeight;
    });
  }

  function queueConsole(sessionId, html) {
    (consoleQueue[sessionId] = consoleQueue[sessionId] || []).push(html);
    if (consoleFlushPending) return;
    consoleFlushPending = true;
    requestAnimationFrame(flushConsole);
    setTimeout(flushConsole, 150); /* rAF pauses in background tabs */
  }

  function appendConsoleHtml(html, sessionId) {
    var session = findConsoleSession(sessionId || state.activeConsole);
    if (!session) session = createConsoleSession("Activity", "", { status: "success" });
    queueConsole(session.id, html);
  }

  function appendConsole(chunk, sessionId) {
    var session = findConsoleSession(sessionId || state.activeConsole);
    if (!session) session = createConsoleSession("Activity", "", { status: "success" });
    var html = chunk.split("\n").map(function (line, index, all) {
      var suffix = index < all.length - 1 ? "\n" : "";
      if (!line) return suffix;
      var cls = classifyConsoleLine(line);
      var body = ansiToHtml(line);
      return (cls ? '<span class="' + cls + '">' + body + "</span>" : body) + suffix;
    }).join("");
    queueConsole(session.id, html);
  }

  function finishConsoleSession(session, payload) {
    if (!session || session.doneCalled) return;
    payload = Object.assign({}, payload || {});
    if (session.stopRequested) payload.interrupted = true;
    session.doneCalled = true;
    session.exitCode = payload && payload.exitCode !== undefined ? payload.exitCode : null;
    session.status = session.stopRequested || (payload && payload.interrupted) ? "interrupted" :
      (session.exitCode === 0 ? "success" : "failed");
    if (session.source) session.source.close();
    session.source = null;
    renderConsoleTabs();
    if (session.onDone) session.onDone(payload || {});
  }

  function stopConsoleSession(id) {
    var session = findConsoleSession(id || state.activeConsole);
    if (!session || session.status !== "running") return Promise.resolve(false);
    session.stopRequested = true;
    return api.stopJob(session.id).catch(function () { return { success: false }; }).then(function () {
      if (session.source) session.source.close();
      appendConsole("\n[stopped by user]\n", session.id);
      finishConsoleSession(session, { interrupted: true, exitCode: 130 });
      return true;
    });
  }

  function closeConsoleSession(id, quiet) {
    var session = findConsoleSession(id);
    if (!session) return;
    if (session.status === "running") {
      session.stopRequested = true;
      api.stopJob(session.id).catch(function () {});
      if (session.source) session.source.close();
      finishConsoleSession(session, { interrupted: true, exitCode: 130 });
    }
    var output = consoleOutput(id);
    if (output && output.parentNode) output.parentNode.removeChild(output);
    var oldIndex = state.consoleSessions.indexOf(session);
    state.consoleSessions.splice(oldIndex, 1);
    if (state.activeConsole === id) {
      var replacement = state.consoleSessions[Math.min(oldIndex, state.consoleSessions.length - 1)];
      state.activeConsole = replacement ? replacement.id : null;
    }
    if (state.activeConsole) selectConsoleSession(state.activeConsole);
    else renderConsoleTabs();
    if (!quiet && !state.consoleSessions.length && state.workspaceMode !== "numerics") closeDrawer();
  }

  function clearActiveConsole() {
    delete consoleQueue[state.activeConsole];
    var output = consoleOutput(state.activeConsole);
    if (output) output.innerHTML = "";
  }

  /* ====================================================================== */
  /* 3. API layer                                                            */
  /* ====================================================================== */

  /* A restarted server issues the session cookie again on request, so an
     open tab keeps saving instead of failing with 403 until a reload. */
  var sessionRenewal = null;
  function renewSession() {
    if (!sessionRenewal) {
      sessionRenewal = fetch("/api/session", { cache: "no-store" })
        .then(function (res) { return res.ok; })
        .catch(function () { return false; });
      sessionRenewal.then(function () {
        setTimeout(function () { sessionRenewal = null; }, 1500);
      });
    }
    return sessionRenewal;
  }

  function request(url, options, retried) {
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () {
        return { success: false, error: "Malformed response (HTTP " + res.status + ")" };
      }).then(function (data) {
        if (res.status === 403 && data && data.session && !retried) {
          return renewSession().then(function (ok) {
            return ok ? request(url, options, true) : data;
          });
        }
        if (data && typeof data === "object" && !Array.isArray(data)) data.httpStatus = res.status;
        return data;
      });
    });
  }

  function getJson(url) {
    return request(url, { cache: "no-store" });
  }

  function postJson(url, body) {
    return request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  var api = {
    tree: function () { return getJson("/api/files/tree"); },
    read: function (path) { return getJson("/api/files/read?path=" + encodeURIComponent(path)); },
    write: function (path, content, allowProtected, version) {
      return postJson("/api/files/write", {
        path: path, content: content, allowProtectedWrite: !!allowProtected, version: version,
      });
    },
    create: function (path, isDir) { return postJson("/api/files/create", { path: path, isDir: !!isDir }); },
    rename: function (from, to) { return postJson("/api/files/rename", { from: from, to: to }); },
    remove: function (path) { return postJson("/api/files/delete", { path: path }); },
    outline: function () { return getJson("/api/outline"); },
    bibtex: function () { return getJson("/api/bibtex"); },
    bibKey: function (key) { return getJson("/api/bibtex/key?k=" + encodeURIComponent(key)); },
    figureMeta: function (path) { return getJson("/api/figures/meta?path=" + encodeURIComponent(path)); },
    compileLog: function () { return getJson("/api/compile/log"); },
    inverse: function (page, x, y, textHit) {
      textHit = textHit || {};
      return getJson("/api/synctex/inverse?page=" + page + "&x=" + x.toFixed(2) +
        "&y=" + y.toFixed(2) + "&word=" + encodeURIComponent(textHit.word || "") +
        "&context=" + encodeURIComponent((textHit.text || "").slice(0, 500)) +
        "&offset=" + encodeURIComponent(textHit.offset || 0));
    },
    forward: function (file, line, col, page) {
      return getJson("/api/synctex/forward?file=" + encodeURIComponent(file) + "&line=" + line +
        "&col=" + col + "&page=" + (page || 0));
    },
    gitStatus: function () { return getJson("/api/git/status"); },
    gitLog: function () { return getJson("/api/git/log"); },
    gitGraph: function () { return getJson("/api/git/graph?limit=60"); },
    gitDiff: function (path) { return getJson("/api/git/diff?file=" + encodeURIComponent(path)); },
    gitStage: function (path) { return postJson("/api/git/stage", { path: path }); },
    gitStageAll: function () { return postJson("/api/git/stage-all", {}); },
    gitUnstage: function (path) { return postJson("/api/git/unstage", { path: path }); },
    gitUnstageAll: function () { return postJson("/api/git/unstage-all", {}); },
    gitCommitAndPush: function (message) { return postJson("/api/git/commit-and-push", { message: message }); },
    gitPull: function () { return postJson("/api/git/pull", {}); },
    gitPush: function () { return postJson("/api/git/push", {}); },
    comments: function () { return getJson("/api/comments"); },
    addComment: function (payload) { return postJson("/api/comments", payload); },
    commentReply: function (id, text) { return postJson("/api/comments/reply", { id: id, text: text, author: "Owner" }); },
    commentStatus: function (id, status) { return postJson("/api/comments/status", { id: id, status: status }); },
    deleteComment: function (id) {
      return request("/api/comments?id=" + encodeURIComponent(id), { method: "DELETE" });
    },
    project: function () { return getJson("/api/project"); },
    numerics: function () { return getJson("/api/numerics/workspace"); },
    numericsData: function (path) { return getJson("/api/numerics/data?path=" + encodeURIComponent(path)); },
    pdfInfo: function () { return getJson("/api/pdf/info"); },
    settings: function () { return getJson("/api/settings"); },
    saveSettings: function (payload) { return postJson("/api/settings", payload); },
    stopJob: function (job) { return postJson("/api/process/stop", { job: job }); },
  };

  /* ====================================================================== */
  /* 4. Monaco bootstrap                                                     */
  /* ====================================================================== */

  function bootMonaco() {
    return new Promise(function (resolve) {
      require.config({ paths: { vs: MONACO_VS } });
      require(["vs/editor/editor.main"], function () {
        window.LatexMonarch.register(window.monaco);

        state.editor = monaco.editor.create(dom.monacoHost, {
          model: null,
          theme: window.LatexMonarch.THEME_ID,
          automaticLayout: true,
          fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
          fontSize: 14,
          lineHeight: 22,
          fontLigatures: true,
          wordWrap: "on",
          wrappingIndent: "same",
          minimap: { enabled: false },
          renderLineHighlight: "all",
          renderWhitespace: "selection",
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          scrollBeyondLastLine: true,
          padding: { top: 12, bottom: 60 },
          tabSize: 2,
          glyphMargin: true,
          unicodeHighlight: { ambiguousCharacters: false },
          scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
        });

        state.commentDecorations = state.editor.createDecorationsCollection([]);
        state.syncDecorations = state.editor.createDecorationsCollection([]);

        var outlineSyncTimer = 0;
        state.editor.onDidChangeCursorPosition(function (event) {
          dom.statusPosition.textContent =
            "Ln " + event.position.lineNumber + ", Col " + event.position.column;
          clearTimeout(outlineSyncTimer);
          outlineSyncTimer = setTimeout(markOutlineCurrent, 140);
        });

        registerLanguageFeatures();
        registerEditorCommands();
        state.blueMarkup = window.BlueMarkup.attach(monaco, state.editor, blueMarkupOptions());

        state.monacoReady = true;
        resolve();
      });
    });
  }

  function registerEditorCommands() {
    var editor = state.editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () { saveActive(); });
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyS,
      function () { saveAll(true); }
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, primaryAction);
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyM,
      function () { startComment(); }
    );
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyJ,
      function () { forwardSync(); }
    );
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Backslash,
      function () { toggleSplitEditor(); }
    );

    editor.addAction({
      id: "faraday.forwardSync",
      label: "SyncTeX: reveal this line in the PDF",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      run: function () { forwardSync(); },
    });
    editor.addAction({
      id: "faraday.addComment",
      label: "Add review comment on selection",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 2,
      run: function () { startComment(); },
    });
  }

  /* Blue review colour (blue-markup.js): margin dot removes, Ctrl+Alt+B marks. */
  function blueMarkupOptions() {
    return {
      isEnabled: function (model) { return model.getLanguageId() === "latex"; },
      notify: function (message, kind) { toast(message, kind); },
      confirm: function (count) {
        return confirmDialog("Remove all blue",
          "Remove the blue colour from <strong>" + count + "</strong> places in this file and keep the text? " +
          "Ctrl+Z undoes it.", "Remove blue");
      },
    };
  }

  /* ====================================================================== */
  /* 5. Documents & tabs                                                     */
  /* ====================================================================== */

  function modelUri(path) {
    return monaco.Uri.parse("file:///" + path.split("/").map(encodeURIComponent).join("/"));
  }

  function saveWorkspaceTabs(mode) {
    mode = mode || state.workspaceMode;
    state.workspaceTabs[mode] = { order: state.order.slice(), active: state.active };
  }

  function allOpenPaths() {
    return Object.keys(state.docs);
  }

  function openFile(path, opts) {
    opts = opts || {};
    if (BINARY_EXT.test(path)) {
      window.open("/api/figures/image?path=" + encodeURIComponent(path), "_blank");
      return Promise.resolve(false);
    }
    var targetMode = modeForPath(path);
    if (targetMode !== state.workspaceMode) setWorkspaceMode(targetMode, { keepFile: true });
    if (state.docs[path]) {
      if (state.order.indexOf(path) === -1) state.order.push(path);
      activate(path, opts);
      return Promise.resolve(true);
    }
    return api.read(path).then(function (data) {
      if (!data.success) {
        toast(data.error || "Could not open " + path, "error");
        return false;
      }
      if (state.docs[path]) { activate(path, opts); return true; }
      var language = languageFor(path);
      var uri = modelUri(path);
      var model = monaco.editor.getModel(uri) || monaco.editor.createModel(data.content, language, uri);
      if (model.getValue() !== data.content) model.setValue(data.content);
      monaco.editor.setModelLanguage(model, language);

      var doc = {
        path: path,
        model: model,
        viewState: null,
        savedVersionId: model.getAlternativeVersionId(),
        diskVersion: data.version,
        diskStamp: data.stamp,
        language: language,
        manualSave: !!data.readOnly,
        conflict: false,
        saving: null,
        autosaveTimer: 0,
        saveError: "",
      };
      state.docs[path] = doc;
      model.onDidChangeContent(function () {
        refreshDirty();
        scheduleAutosave(path);
      });
      if (state.order.indexOf(path) === -1) state.order.push(path);
      activate(path, opts);
      return true;
    }).catch(function (error) {
      toast("Could not open " + path + ": " + (error.message || error), "error");
      return false;
    });
  }

  function activate(path, opts) {
    opts = opts || {};
    var doc = state.docs[path];
    if (!doc) return;

    if (state.active && state.docs[state.active] && state.active !== path) {
      state.docs[state.active].viewState = state.editor.saveViewState();
      flushAutosave(state.active);
    }
    state.active = path;
    if (state.order.indexOf(path) === -1) state.order.push(path);
    saveWorkspaceTabs();
    state.editor.setModel(doc.model);
    if (doc.viewState && !opts.line) state.editor.restoreViewState(doc.viewState);

    if (opts.line) {
      var line = Math.min(Math.max(1, opts.line), doc.model.getLineCount());
      var column = Math.max(1, opts.column || 1);
      if (opts.length) {
        state.editor.setSelection(new monaco.Selection(line, column, line, column + opts.length));
      } else {
        state.editor.setPosition({ lineNumber: line, column: column });
      }
      state.editor.revealLineInCenter(line, monaco.editor.ScrollType.Smooth);
      if (opts.flash) flashLine(line, opts.length ? { column: column, length: opts.length } : null);
    }
    if (opts.focus !== false) state.editor.focus();

    renderTabs();
    renderBreadcrumb(path);
    highlightTreeSelection();
    applyCommentDecorations();
    dom.statusLanguage.textContent = doc.language;
    dom.btnMdPreview.hidden = doc.language !== "markdown";
    if (doc.language !== "markdown" && state.mdPreview) toggleMarkdownPreview(false);
    else if (state.mdPreview) renderMarkdownPreview();
    syncSplitModel();
    renderConflictBar();
    refreshDirty();
    document.dispatchEvent(new CustomEvent("faraday:file-activated"));
    if (state.workspaceMode === "numerics") {
      var chamber = (state.numerics.pipelines || []).filter(function (item) {
        return (item.files || []).some(function (file) { return file.path === path; });
      })[0];
      if (chamber && chamber.id !== state.selectedPipeline) selectPipeline(chamber.id, { quiet: true });
    }
    rememberSession();
  }

  function flashLine(line, word) {
    var decorations = [{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: "synctex-line" },
    }];
    if (word) {
      decorations.push({
        range: new monaco.Range(line, word.column, line, word.column + word.length),
        options: { inlineClassName: "synctex-word" },
      });
    }
    state.syncDecorations.set(decorations);
    clearTimeout(flashLine._t);
    flashLine._t = setTimeout(function () { state.syncDecorations.set([]); }, 2600);
  }

  function isDirty(path) {
    var doc = state.docs[path];
    return !!doc && doc.model.getAlternativeVersionId() !== doc.savedVersionId;
  }

  function dirtyPaths() {
    return allOpenPaths().filter(isDirty);
  }

  /* One indicator in the top bar summarises every open document. */
  function renderSaveIndicator() {
    var dirty = dirtyPaths();
    var docs = allOpenPaths().map(function (p) { return state.docs[p]; }).filter(Boolean);
    var conflict = docs.filter(function (d) { return d.conflict; });
    var saving = docs.filter(function (d) { return d.saving; });
    var failed = docs.filter(function (d) { return d.saveError; });
    var stateName, text, title, icon;
    if (conflict.length) {
      stateName = "conflict"; icon = "fa-code-merge";
      text = conflict.length === 1 ? "Conflict: " + baseName(conflict[0].path) : conflict.length + " conflicts";
      title = "Changed on disk while you were editing. Resolve it in the bar above the editor.";
    } else if (state.connectionLost) {
      stateName = "offline"; icon = "fa-plug-circle-exclamation";
      text = dirty.length ? "Offline · " + dirty.length + " unsaved" : "Offline";
      title = "The editor server does not answer. Your text stays here and is saved on reconnect.";
    } else if (failed.length) {
      stateName = "error"; icon = "fa-triangle-exclamation";
      text = "Save failed";
      title = failed[0].saveError;
    } else if (saving.length) {
      stateName = "saving"; icon = "fa-circle-notch"; text = "Saving…"; title = "Writing to disk";
    } else if (dirty.length) {
      stateName = "pending"; icon = "fa-pen";
      text = autosaveEnabled() ? "Unsaved · autosave" : dirty.length + " unsaved";
      title = autosaveEnabled() ? "Saved automatically after a short pause" : "Press Ctrl+S to save";
      if (docs.some(function (d) { return d.manualSave && isDirty(d.path); })) {
        title = "Agreement files are saved manually (Ctrl+S)";
      }
    } else {
      stateName = "saved"; icon = "fa-circle-check"; text = "All saved"; title = "Every open file matches the disk";
    }
    dom.saveIndicator.dataset.state = stateName;
    dom.saveIndicator.title = title;
    dom.saveIndicator.querySelector("i").className = "fa-solid " + icon;
    dom.saveIndicatorText.textContent = text;
  }

  function refreshDirty() {
    var dirty = dirtyPaths();
    dom.dirtyChip.hidden = dirty.length < 2;
    dom.dirtyCount.textContent = String(dirty.length);
    var doc = state.active && state.docs[state.active];
    var fileState = !doc ? "no file" : doc.conflict ? "disk conflict" :
      (doc.saving ? "saving" : (isDirty(state.active) ? "unsaved" : "saved"));
    dom.statusFileState.textContent = fileState;
    dom.statusFileState.className = doc && doc.conflict ? "conflict" : (doc && isDirty(state.active) ? "unsaved" : "");
    Array.prototype.forEach.call(dom.tabbar.children, function (tab) {
      var tabDoc = state.docs[tab.dataset.path];
      tab.classList.toggle("dirty", isDirty(tab.dataset.path));
      tab.classList.toggle("conflict", !!(tabDoc && tabDoc.conflict));
    });
    Array.prototype.forEach.call(dom.fileTree.querySelectorAll(".tree-row[data-path]"), function (row) {
      if (row.dataset.type === "file") row.classList.toggle("dirty", isDirty(row.dataset.path));
    });
    renderSaveIndicator();
  }

  function renderTabs() {
    dom.tabbar.innerHTML = "";
    state.order.forEach(function (path) {
      var icon = iconFor(path);
      var tab = document.createElement("div");
      tab.className = "tab" + (path === state.active ? " active" : "");
      tab.dataset.path = path;
      tab.title = path;
      tab.innerHTML =
        '<i class="tab-icon ' + icon[0] + " " + icon[1] + '"></i>' +
        '<span class="tab-name">' + escapeHtml(baseName(path)) + "</span>" +
        '<span class="tab-close" title="Close"><i class="fa-solid fa-xmark"></i></span>';
      tab.addEventListener("click", function (event) {
        if (event.target.closest(".tab-close")) closeTab(path);
        else activate(path);
      });
      tab.addEventListener("auxclick", function (event) {
        if (event.button === 1) { event.preventDefault(); closeTab(path); }
      });
      dom.tabbar.appendChild(tab);
    });
    refreshDirty();
    var active = dom.tabbar.querySelector(".tab.active");
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderBreadcrumb(path) {
    var parts = path.split("/");
    var html = parts.map(function (part, index) {
      var last = index === parts.length - 1;
      return (index ? '<span class="crumb-sep"><i class="fa-solid fa-chevron-right"></i></span>' : "") +
        '<span class="crumb' + (last ? " crumb-last" : "") + '">' + escapeHtml(part) + "</span>";
    }).join("");
    var doc = state.docs[path];
    if (doc && doc.manualSave) html += '<span class="crumb-tag" title="Saved only on Ctrl+S, after a confirmation">protected</span>';
    dom.breadcrumb.innerHTML = html;
  }

  /* Remove a document and fall back to the neighbouring tab, if any. */
  function dropDocument(path) {
    var index = state.order.indexOf(path);
    if (index !== -1) state.order.splice(index, 1);
    var doc = state.docs[path];
    if (doc) {
      clearTimeout(doc.autosaveTimer);
      /* Detach before disposing, or the split view holds a dead model. */
      if (state.splitEditor && state.splitEditor.getModel() === doc.model) {
        state.splitEditor.setModel(null);
      }
      doc.model.dispose();
    }
    delete state.docs[path];

    if (state.active === path) {
      state.active = null;
      var next = state.order[Math.min(Math.max(index, 0), state.order.length - 1)];
      if (next) {
        activate(next, { focus: false });
        highlightTreeSelection();
        return;
      }
      state.editor.setModel(null);
      dom.breadcrumb.textContent = "";
      dom.statusLanguage.textContent = "—";
      dom.statusFileState.textContent = "no file";
      dom.btnMdPreview.hidden = true;
      if (state.mdPreview) toggleMarkdownPreview(false);
      renderConflictBar();
    }
    renderTabs();
    highlightTreeSelection();
    rememberSession();
  }

  /** Save / Don't save / Cancel. Resolves to "save", "discard" or "cancel". */
  function unsavedDialog(path) {
    return new Promise(function (resolve) {
      $("unsaved-message").innerHTML =
        "<strong>" + escapeHtml(baseName(path)) + "</strong> has unsaved changes.<br>" +
        '<span style="color:var(--text-mute)">' + escapeHtml(path) + "</span>";
      openModal("modal-unsaved");

      function cleanup(answer) {
        $("btn-unsaved-save").removeEventListener("click", onSave);
        $("btn-unsaved-discard").removeEventListener("click", onDiscard);
        $("btn-unsaved-cancel").removeEventListener("click", onCancel);
        $("modal-unsaved").removeEventListener("mousedown", onBackdrop);
        document.removeEventListener("keydown", onKey, true);
        closeModal("modal-unsaved");
        resolve(answer);
      }
      function onSave() { cleanup("save"); }
      function onDiscard() { cleanup("discard"); }
      function onCancel() { cleanup("cancel"); }
      function onBackdrop(event) {
        if (event.target.id === "modal-unsaved" || event.target.dataset.close) cleanup("cancel");
      }
      function onKey(event) {
        if (event.key === "Escape") { event.stopPropagation(); cleanup("cancel"); }
        if (event.key === "Enter") { event.stopPropagation(); cleanup("save"); }
      }
      $("btn-unsaved-save").addEventListener("click", onSave);
      $("btn-unsaved-discard").addEventListener("click", onDiscard);
      $("btn-unsaved-cancel").addEventListener("click", onCancel);
      $("modal-unsaved").addEventListener("mousedown", onBackdrop);
      document.addEventListener("keydown", onKey, true);
      setTimeout(function () { $("btn-unsaved-save").focus(); }, 40);
    });
  }

  function closeTab(path) {
    var doc = state.docs[path];
    if (!doc) return Promise.resolve(true);
    if (!isDirty(path)) {
      dropDocument(path);
      return Promise.resolve(true);
    }
    /* With autosave a clean close is the norm: save first, ask only on trouble. */
    if (autosaveAllowed(doc)) {
      return saveDocument(path, { quiet: true }).then(function (saved) {
        if (saved && !isDirty(path)) { dropDocument(path); onAfterSave([path]); return true; }
        return askAndClose(path);
      });
    }
    return askAndClose(path);
  }

  function askAndClose(path) {
    return unsavedDialog(path).then(function (answer) {
      if (answer === "cancel") return false;
      if (answer === "discard") { dropDocument(path); return true; }
      return saveDocument(path).then(function (saved) {
        if (saved) {
          setStatusMessage("saved " + baseName(path), "ok");
          dropDocument(path);
          onAfterSave([path]);
        }
        return saved;
      });
    });
  }

  /* ---- Saving ------------------------------------------------------------ */

  function autosaveEnabled() {
    var editorCfg = (state.settings || {}).editor || {};
    return editorCfg.autosave !== false;
  }

  function autosaveDelay() {
    var editorCfg = (state.settings || {}).editor || {};
    var value = Number(editorCfg.autosaveDelay);
    return value >= 300 && value <= 60000 ? value : 1200;
  }

  function autosaveAllowed(doc) {
    return !!doc && autosaveEnabled() && !doc.manualSave && !doc.conflict;
  }

  function scheduleAutosave(path) {
    var doc = state.docs[path];
    if (!doc) return;
    clearTimeout(doc.autosaveTimer);
    if (!autosaveAllowed(doc) || !isDirty(path)) return;
    doc.autosaveTimer = setTimeout(function () { autosave(path); }, autosaveDelay());
  }

  function autosave(path) {
    var doc = state.docs[path];
    if (!autosaveAllowed(doc) || !isDirty(path)) return Promise.resolve(true);
    if (doc.saving) {
      /* Edits made during a save are picked up right after it. */
      doc.saveAgain = true;
      return doc.saving;
    }
    return saveDocument(path, { quiet: true }).then(function (ok) {
      if (ok) onAfterSave([path], { quiet: true });
      return ok;
    });
  }

  /* Save immediately (tab switch, window blur, before a compile). */
  function flushAutosave(path) {
    var doc = state.docs[path];
    if (!doc) return Promise.resolve(true);
    clearTimeout(doc.autosaveTimer);
    if (!autosaveAllowed(doc) || !isDirty(path)) return Promise.resolve(true);
    return autosave(path);
  }

  function flushAllAutosaves() {
    return Promise.all(allOpenPaths().map(flushAutosave)).then(function (results) {
      return results.every(Boolean);
    });
  }

  /**
   * Write one document. Resolves true when the disk holds the saved text.
   * Conflicts pause autosave for the file and raise the conflict bar; network
   * failures keep the text dirty and retry with a growing delay.
   */
  function saveDocument(path, options) {
    options = options || {};
    var doc = state.docs[path];
    if (!doc) return Promise.resolve(false);
    if (doc.saving) return doc.saving.then(function (ok) {
      return ok && isDirty(path) ? saveDocument(path, options) : ok;
    });
    if (doc.conflict && !options.force) {
      renderConflictBar();
      return Promise.resolve(false);
    }
    var content = doc.model.getValue();
    var versionAtStart = doc.model.getAlternativeVersionId();

    function attempt(allowProtected) {
      return api.write(path, content, allowProtected, options.force ? null : doc.diskVersion).then(function (data) {
        if (data.success) {
          doc.savedVersionId = versionAtStart;
          doc.diskVersion = data.version;
          doc.diskStamp = data.stamp;
          doc.conflict = false;
          doc.saveError = "";
          doc.retryDelay = 0;
          return true;
        }
        if (data.conflict) {
          markConflict(path, "save");
          return false;
        }
        if (data.protected && !allowProtected) {
          return confirmDialog(
            "Protected file",
            "<strong>" + escapeHtml(path) + "</strong> is declared read-only in the project agreement. Save anyway?",
            "Save anyway"
          ).then(function (ok) { return ok ? attempt(true) : false; });
        }
        doc.saveError = data.error || "Save failed";
        if (!options.quiet) toast(doc.saveError, "error");
        return false;
      });
    }
    renderSaveIndicatorSoon();
    doc.saving = attempt(!!options.allowProtected).catch(function (error) {
      /* The server is unreachable: keep the text, retry automatically. */
      doc.saveError = "Server not reachable (" + (error.message || error) + ")";
      state.connectionLost = true;
      doc.retryDelay = Math.min(15000, (doc.retryDelay || 1000) * 2);
      clearTimeout(doc.autosaveTimer);
      doc.autosaveTimer = setTimeout(function () { autosave(path); }, doc.retryDelay);
      if (!options.quiet) toast("Save failed: the editor server does not answer. Your text is kept.", "error", 6000);
      return false;
    }).then(function (ok) {
      doc.saving = null;
      refreshDirty();
      if (doc.saveAgain) {
        doc.saveAgain = false;
        scheduleAutosave(path);
      } else if (ok && isDirty(path)) {
        scheduleAutosave(path);
      }
      return ok;
    });
    return doc.saving;
  }

  function renderSaveIndicatorSoon() {
    setTimeout(refreshDirty, 0);
  }

  function saveActive() {
    if (!state.active) return Promise.resolve(false);
    var path = state.active;
    var doc = state.docs[path];
    clearTimeout(doc.autosaveTimer);
    if (doc.conflict) { renderConflictBar(); toast("Resolve the disk conflict first (bar above the editor).", "warn"); return Promise.resolve(false); }
    if (!isDirty(path)) {
      setStatusMessage("already saved", "");
      return Promise.resolve(true);
    }
    return saveDocument(path, { allowProtected: false }).then(function (ok) {
      if (ok) {
        setStatusMessage("saved " + baseName(path), "ok");
        onAfterSave([path]);
      }
      return ok;
    });
  }

  function saveAll(announce) {
    var dirty = dirtyPaths().filter(function (path) { return !state.docs[path].conflict; });
    var openPaths = allOpenPaths();
    openPaths.forEach(function (path) { clearTimeout(state.docs[path].autosaveTimer); });
    if (!dirty.length) {
      if (announce) setStatusMessage("nothing to save", "");
      return Promise.resolve(!openPaths.some(function (p) { return state.docs[p].conflict; }));
    }
    return Promise.all(dirty.map(function (path) { return saveDocument(path, { quiet: !announce }); })).then(function (results) {
      var ok = results.every(Boolean) && !openPaths.some(function (path) { return state.docs[path].conflict; });
      if (announce) {
        setStatusMessage(ok ? "saved " + dirty.length + " file(s)" : "some files failed to save", ok ? "ok" : "err");
      }
      if (results.some(Boolean)) onAfterSave(dirty.filter(function (_, index) { return results[index]; }));
      return ok;
    });
  }

  /* Refresh the panels that depend on saved files, once per burst of saves. */
  var afterSaveTimer = 0;
  var afterSavePaths = new Set();
  function onAfterSave(paths, options) {
    options = options || {};
    (paths || []).forEach(function (path) { afterSavePaths.add(path); });
    clearTimeout(afterSaveTimer);
    afterSaveTimer = setTimeout(function () {
      var saved = Array.from(afterSavePaths);
      afterSavePaths.clear();
      document.dispatchEvent(new CustomEvent('faraday:disk-changed'));
      nextGitRefresh = 0;
      if (saved.some(function (path) { return /\.(tex|bib|sty|cls)$/i.test(path); })) loadOutline();
      if (saved.some(function (path) { return /\.(tex|bib)$/i.test(path); })) bibCache = null;
      if (state.settings && state.settings.compiler && state.settings.compiler.autoCompileOnSave &&
          saved.some(function (path) { return /\.(tex|bib|sty|cls)$/i.test(path); })) {
        recompile({ skipSave: true, reason: "auto" });
      }
    }, options.quiet ? 900 : 150);
  }

  /* ---- Disk conflicts ------------------------------------------------------ */

  function markConflict(path, origin) {
    var doc = state.docs[path];
    if (!doc) return;
    clearTimeout(doc.autosaveTimer);
    var fresh = !doc.conflict;
    doc.conflict = true;
    refreshDirty();
    renderConflictBar();
    if (fresh && state.active !== path) {
      toast(baseName(path) + " changed on disk while you were editing it. Your text is kept.", "warn", 7000);
    }
    if (origin === "save" && fresh) setStatusMessage("disk conflict: " + baseName(path), "err");
  }

  function renderConflictBar() {
    var doc = state.active && state.docs[state.active];
    var show = !!(doc && doc.conflict);
    dom.conflictBar.hidden = !show;
    if (show) {
      $("conflict-title").textContent = baseName(doc.path) + " changed on disk";
      $("conflict-detail").textContent = "Another program (for example an agent) saved this file while you had " +
        "unsaved edits. Autosave is paused for it until you choose.";
    }
    if (state.editor) state.editor.layout();
  }

  function compareConflict() {
    var path = state.active;
    var doc = state.docs[path];
    if (!doc) return;
    api.read(path).then(function (disk) {
      if (!disk.success) { toast("The file no longer exists on disk. Keep mine to recreate it.", "warn"); return; }
      showDiff(path, { success: true, head_content: disk.content, working_content: doc.model.getValue() },
        { left: "On disk now", right: "Your text" });
    });
  }

  function resolveConflict(keepMine) {
    var path = state.active;
    var doc = state.docs[path];
    if (!doc) return;
    api.read(path).then(function (disk) {
      if (keepMine) {
        doc.conflict = false;
        doc.diskVersion = disk.success ? disk.version : null;
        doc.diskStamp = disk.success ? disk.stamp : null;
        return saveDocument(path, { allowProtected: doc.manualSave }).then(function (ok) {
          if (ok) { toast("Your version of " + baseName(path) + " is saved.", "success"); onAfterSave([path]); }
          renderConflictBar();
        });
      }
      if (!disk.success) { toast("The file no longer exists on disk.", "warn"); return; }
      var view = state.editor.saveViewState();
      doc.model.setValue(disk.content);
      doc.savedVersionId = doc.model.getAlternativeVersionId();
      doc.diskVersion = disk.version;
      doc.diskStamp = disk.stamp;
      doc.conflict = false;
      if (view) state.editor.restoreViewState(view);
      refreshDirty();
      renderConflictBar();
      toast("Loaded the disk version of " + baseName(path) + ".", "info");
    });
  }

  /* ====================================================================== */
  /* 6. Language intelligence: hovers & completions                          */
  /* ====================================================================== */

  var bibCache = null;
  var thumbCache = Object.create(null);

  function loadBib() {
    if (bibCache) return Promise.resolve(bibCache);
    return api.bibtex().then(function (data) {
      bibCache = data.success ? data.entries : [];
      return bibCache;
    });
  }

  function figureThumbnail(rawPath, maxWidth) {
    maxWidth = maxWidth || 280;
    var cacheKey = rawPath + "@" + maxWidth;
    if (thumbCache[cacheKey] !== undefined) return Promise.resolve(thumbCache[cacheKey]);
    return api.figureMeta(rawPath).then(function (meta) {
      if (!meta.success) { thumbCache[cacheKey] = null; return null; }
      var url = "/api/figures/image?path=" + encodeURIComponent(meta.path);
      if (meta.kind === "image") { thumbCache[cacheKey] = url; return url; }
      if (meta.kind !== "pdf") { thumbCache[cacheKey] = null; return null; }
      return pdfjsLib.getDocument({ url: url }).promise.then(function (doc) {
        return doc.getPage(1).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var scale = Math.min(maxWidth / base.width, 2.5);
          var viewport = page.getViewport({ scale: scale });
          var canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          return page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport })
            .promise.then(function () {
              var data = canvas.toDataURL("image/png");
              doc.destroy();
              thumbCache[cacheKey] = data;
              return data;
            });
        });
      }).catch(function () { thumbCache[cacheKey] = null; return null; });
    });
  }

  function macroArgumentAt(line, column, macros) {
    var pattern = new RegExp("\\\\(" + macros + ")\\*?(?:\\[[^\\]]*\\])*\\{([^}]*)\\}", "g");
    var match;
    while ((match = pattern.exec(line)) !== null) {
      var start = match.index + 1;
      var end = match.index + match[0].length + 1;
      if (column >= start && column <= end) {
        return { macro: match[1], argument: match[2], start: start, end: end };
      }
    }
    return null;
  }

  function registerLanguageFeatures() {
    monaco.languages.registerHoverProvider("latex", {
      provideHover: function (model, position) {
        var line = model.getLineContent(position.lineNumber);
        var column = position.column;

        var cite = macroArgumentAt(line, column, "cite|citep|citet|parencite|textcite|autocite|footcite|citeauthor|citeyear|nocite");
        if (cite) {
          var keys = cite.argument.split(",").map(function (k) { return k.trim(); }).filter(Boolean);
          return Promise.all(keys.map(function (key) { return api.bibKey(key); })).then(function (results) {
            var contents = [];
            results.forEach(function (data, index) {
              if (!data.success) {
                contents.push({ value: "**" + keys[index] + "** — _not found in references.bib_" });
                return;
              }
              var e = data.entry;
              var head = "**" + (e.title || e.key) + "**";
              var meta = [e.author, e.year].filter(Boolean).join(" · ");
              var journal = [e.journal, e.volume, e.pages].filter(Boolean).join(", ");
              contents.push({ value: head });
              if (meta) contents.push({ value: meta });
              if (journal) contents.push({ value: "_" + journal + "_" });
              if (e.doi) contents.push({ value: "[doi:" + e.doi + "](https://doi.org/" + e.doi + ")" });
            });
            return contents.length ? { contents: contents } : null;
          });
        }

        var graphic = macroArgumentAt(line, column, "includegraphics");
        if (graphic) {
          return figureThumbnail(graphic.argument).then(function (src) {
            var contents = [{ value: "**Figure** `" + graphic.argument + "`" }];
            if (src) contents.push({ value: "![figure](" + src + ")" });
            return { contents: contents };
          });
        }

        var reference = macroArgumentAt(line, column, "ref|eqref|cref|Cref|autoref|nameref|pageref");
        if (reference) return hoverForLabel(reference.argument);

        return null;
      },
    });

    monaco.languages.registerCompletionItemProvider("latex", {
      triggerCharacters: ["{", "\\", ",", ":"],
      provideCompletionItems: function (model, position) {
        var prefix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        var word = model.getWordUntilPosition(position);
        var range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        if (/\\(?:cite|citep|citet|parencite|textcite|autocite|footcite|citeauthor|citeyear|nocite)\*?(?:\[[^\]]*\])*\{[^}]*$/.test(prefix)) {
          return loadBib().then(function (entries) {
            return {
              suggestions: entries.map(function (entry) {
                return {
                  label: entry.label,
                  kind: monaco.languages.CompletionItemKind.Reference,
                  detail: entry.detail,
                  documentation: { value: entry.documentation || "" },
                  insertText: entry.insertText,
                  range: range,
                };
              }),
            };
          });
        }

        if (/\\(?:ref|eqref|cref|Cref|autoref|nameref|pageref)\*?\{[^}]*$/.test(prefix)) {
          return {
            suggestions: state.outline.labels.map(function (label) {
              return {
                label: label.label,
                kind: monaco.languages.CompletionItemKind.Value,
                detail: label.file + ":" + label.line,
                insertText: label.label,
                range: range,
              };
            }),
          };
        }

        if (/\\(?:begin|end)\{[^}]*$/.test(prefix)) {
          var envs = ["equation", "equation*", "align", "align*", "gather", "gather*", "split",
            "itemize", "enumerate", "description", "figure", "table", "tabular", "center",
            "abstract", "quote", "verbatim", "cases", "pmatrix", "bmatrix", "subequations"];
          return {
            suggestions: envs.map(function (env) {
              return {
                label: env,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: env,
                range: range,
              };
            }),
          };
        }

        if (/\\[a-zA-Z]*$/.test(prefix)) {
          var backslash = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: prefix.lastIndexOf("\\") + 1,
            endColumn: position.column,
          };
          var snippets = [
            ["begin", "begin{${1:equation}}\n\t$0\n\\end{${1:equation}}"],
            ["section", "section{$1}\n$0"],
            ["subsection", "subsection{$1}\n$0"],
            ["subsubsection", "subsubsection{$1}\n$0"],
            ["label", "label{$1}"],
            ["ref", "ref{$1}"],
            ["eqref", "eqref{$1}"],
            ["cite", "cite{$1}"],
            ["textbf", "textbf{$1}"],
            ["textit", "textit{$1}"],
            ["emph", "emph{$1}"],
            ["frac", "frac{$1}{$2}"],
            ["partial", "partial"],
            ["includegraphics", "includegraphics[width=$1\\linewidth]{$2}"],
            ["figure", "begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{$1}\n\t\\caption{$2}\n\t\\label{fig:$3}\n\\end{figure}\n$0"],
          ];
          return {
            suggestions: snippets.map(function (pair) {
              return {
                label: "\\" + pair[0],
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: "\\" + pair[1],
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range: backslash,
              };
            }),
          };
        }
        return { suggestions: [] };
      },
    });

    /* Ctrl-click on \input{...} or \ref{...} jumps to the target. */
    monaco.languages.registerDefinitionProvider("latex", {
      provideDefinition: function (model, position) {
        var line = model.getLineContent(position.lineNumber);

        var include = macroArgumentAt(line, position.column, "input|include|subfile|import");
        if (include) {
          var target = include.argument;
          if (!/\.[a-z]+$/i.test(target)) target += ".tex";
          return openFile(target).then(function (ok) {
            return ok ? { uri: modelUri(target), range: new monaco.Range(1, 1, 1, 1) } : null;
          });
        }

        var reference = macroArgumentAt(line, position.column, "ref|eqref|cref|Cref|autoref|nameref");
        if (reference) {
          var label = findLabel(reference.argument);
          if (!label) return null;
          return openFile(label.file).then(function (ok) {
            return ok
              ? { uri: modelUri(label.file), range: new monaco.Range(label.line, 1, label.line, 1) }
              : null;
          });
        }
        return null;
      },
    });
  }

  function findLabel(name) {
    for (var i = 0; i < state.outline.labels.length; i += 1) {
      if (state.outline.labels[i].label === name) return state.outline.labels[i];
    }
    return null;
  }

  function hoverForLabel(name) {
    var figure = state.outline.figures.filter(function (f) { return f.label === name; })[0];
    if (figure) {
      return figureThumbnail(figure.image).then(function (src) {
        var contents = [{ value: "**Figure** `" + name + "`" }];
        if (figure.caption) contents.push({ value: figure.caption });
        if (src) contents.push({ value: "![figure](" + src + ")" });
        contents.push({ value: "_" + figure.file + ":" + figure.start_line + "_" });
        return { contents: contents };
      });
    }
    var equation = state.outline.equations.filter(function (e) { return e.label === name; })[0];
    if (equation) {
      return {
        contents: [
          { value: "**Equation** `" + name + "`" },
          { value: "```latex\n" + equation.latex.slice(0, 600) + "\n```" },
          { value: "_" + equation.file + ":" + equation.line + "_" },
        ],
      };
    }
    var label = findLabel(name);
    if (label) {
      var section = null;
      state.outline.outline.forEach(function (item) {
        if (item.file === label.file && item.line <= label.line) section = item;
      });
      var contents = [{ value: "**Label** `" + name + "`" }];
      if (section) contents.push({ value: section.type + " — " + section.title });
      contents.push({ value: "_" + label.file + ":" + label.line + "_" });
      return { contents: contents };
    }
    return { contents: [{ value: "`" + name + "` — _no matching \\label found_" }] };
  }

  /* ====================================================================== */
  /* 7. File explorer                                                        */
  /* ====================================================================== */

  function loadTree() {
    return api.tree().then(function (data) {
      if (!data.success) {
        toast(data.error || "Could not read the repository tree", "error");
        return;
      }
      state.tree = data.tree;
      state.treeIndex = [];
      (function walk(nodes) {
        nodes.forEach(function (node) {
          if (node.type === "directory") walk(node.children || []);
          else state.treeIndex.push(node.path);
        });
      })(data.tree);
      renderTree();
    });
  }

  function renderTree() {
    var filter = dom.fileFilter.value.trim().toLowerCase();
    dom.fileTree.innerHTML = "";

    if (!state.fullRepository) {
      if (state.workspaceMode === "numerics") renderNumericsCatalogue(filter);
      else renderLatexCatalogue(filter);
      refreshDirty();
      highlightTreeSelection();
      return;
    }
    dom.fileTree.className = "tree scroll-y";

    if (filter) {
      var matches = state.treeIndex.filter(function (path) {
        return path.toLowerCase().indexOf(filter) !== -1;
      }).slice(0, 300);
      if (!matches.length) {
        dom.fileTree.innerHTML = '<div class="tree-empty">No file matches “' + escapeHtml(filter) + '”.</div>';
        return;
      }
      matches.forEach(function (path) {
        dom.fileTree.appendChild(fileRow({ name: path, path: path, type: "file" }, 0, true));
      });
      refreshDirty();
      highlightTreeSelection();
      return;
    }

    dom.fileTree.appendChild(renderNodes(state.tree || [], 0));
    refreshDirty();
    highlightTreeSelection();
  }

  function printedUnit(path) {
    var name = baseName(path);
    // Appendices are lettered A, B, C, ... (B_03_02_ is B.3.2).
    var appendix = name.match(/^([A-Z])(?:_(\d{2}))?(?:_(\d{2}))?_/);
    if (appendix) {
      return [appendix[1]].concat(appendix.slice(2).filter(Boolean).map(function (part) {
        return String(Number(part));
      })).join(".");
    }
    var section = name.match(/^(\d{2})(?:_(\d{2}))?(?:_(\d{2}))?_/);
    if (!section) return "";
    return [toRoman(Number(section[1]))].concat(section.slice(2).filter(Boolean).map(function (part) {
      return String(Number(part));
    })).join(".");
  }

  function outlineTitleForFile(path) {
    var headings = state.outline.outline.filter(function (item) { return item.file === path; });
    return headings.length ? headings[0].title : baseName(path).replace(/\.tex$/i, "").replace(/_/g, " ");
  }

  function catalogueFile(item, subtitle, action) {
    var icon = iconFor(item.path);
    var button = document.createElement("button");
    button.className = "workspace-file" + (isDirty(item.path) ? " dirty" : "");
    button.dataset.path = item.path;
    button.title = item.path;
    button.innerHTML = '<i class="' + icon[0] + " " + icon[1] + '"></i>' +
      '<span class="workspace-file-copy"><strong>' + escapeHtml(item.name || baseName(item.path)) +
      "</strong><span>" + escapeHtml(subtitle || item.path) + "</span></span>";
    button.addEventListener("click", function () {
      if (action) action(item);
      else openFile(item.path);
    });
    return button;
  }

  function renderCatalogueGroup(group, mode, filter) {
    var items = (group.files || []).filter(function (item) {
      var haystack = [item.path, item.name, group.label, group.description].join(" ").toLowerCase();
      return !filter || haystack.indexOf(filter) !== -1;
    });
    if (!items.length) return null;
    var key = mode + ":" + group.id;
    var forceOpen = !!filter || items.some(function (item) { return item.path === state.active; });
    var open = forceOpen || state.catalogueExpanded.has(key);
    var section = document.createElement("section");
    section.className = "workspace-group " + (mode === "numerics" ? "program " : "") + (open ? "open" : "");
    section.dataset.group = key;
    var head = document.createElement("button");
    head.type = "button";
    head.className = "workspace-group-head";
    head.innerHTML = '<span class="workspace-group-icon"><i class="fa-solid ' +
      escapeHtml(group.icon || "fa-folder") + '"></i></span><span class="workspace-group-copy"><strong>' +
      escapeHtml(group.label) + "</strong><span>" + escapeHtml(group.description || (items.length + " files")) +
      '</span></span><i class="group-caret fa-solid fa-chevron-right"></i>';
    var body = document.createElement("div");
    body.className = "workspace-group-items";
    body.id = "workspace-group-" + key.replace(/[^a-z0-9_-]+/gi, "-");
    head.setAttribute("aria-controls", body.id);
    head.setAttribute("aria-expanded", String(open));
    items.forEach(function (item) {
      body.appendChild(catalogueFile(item, item.unit || item.path));
    });
    head.addEventListener("click", function () {
      var nowOpen = !section.classList.contains("open");
      section.classList.toggle("open", nowOpen);
      head.setAttribute("aria-expanded", String(nowOpen));
      if (nowOpen) state.catalogueExpanded.add(key);
      else state.catalogueExpanded.delete(key);
    });
    section.appendChild(head);
    section.appendChild(body);
    return section;
  }

  function renderLatexCatalogue(filter) {
    if (state.project && state.project.features && state.project.features.applications) {
      renderCvCatalogue(filter);
      return;
    }
    var seen = Object.create(null);
    var groups = [];
    var setup = [
      { path: "Notes/Notes.tex", name: "Document assembly", unit: "Notes/Notes.tex" },
      { path: "main.tex", name: "Main document", unit: "main.tex" },
      { path: "LaTeX/preamble.tex", name: "Preamble", unit: "LaTeX/preamble.tex" },
      { path: "Bibliography/references.bib", name: "Bibliography", unit: "Bibliography/references.bib" },
    ].filter(function (item) { return state.treeIndex.indexOf(item.path) !== -1; });
    if (setup.length) groups.push({
      id: "setup", label: "Project setup", description: "Assembly, preamble and references",
      icon: "fa-screwdriver-wrench", files: setup,
    });

    state.outline.outline.forEach(function (item) {
      if (!/^Notes\/Sections\//.test(item.file) || seen[item.file]) return;
      seen[item.file] = true;
      var name = baseName(item.file);
      var match = name.match(/^(\d{2})_/);
      var letter = match ? null : name.match(/^([A-Z])_/);
      var groupId = match ? "section-" + match[1] : (letter ? "appendix-" + letter[1] : "other");
      var group = groups.filter(function (candidate) { return candidate.id === groupId; })[0];
      if (!group) {
        var label;
        var description;
        var icon = "fa-book-open";
        if (match) {
          label = "Section " + toRoman(Number(match[1]));
          var rootHeading = state.outline.outline.filter(function (heading) {
            return heading.level === 2 && new RegExp("^" + match[1] + "_(?!\\d{2}_)").test(baseName(heading.file));
          })[0];
          description = rootHeading ? rootHeading.title : "Manuscript section";
        } else if (letter) {
          label = "Appendix " + letter[1];
          var appendixHeading = state.outline.outline.filter(function (heading) {
            return heading.level === 2 && new RegExp("^" + letter[1] + "_(?!\\d{2}_)").test(baseName(heading.file));
          })[0];
          description = appendixHeading ? appendixHeading.title : "Appendix";
          icon = "fa-book-bookmark";
        } else {
          label = "Other LaTeX";
          description = "Additional document modules";
        }
        group = { id: groupId, label: label, description: description, icon: icon, files: [] };
        groups.push(group);
      }
      group.files.push({ path: item.file, name: outlineTitleForFile(item.file), unit: printedUnit(item.file) });
    });

    if (!state.catalogueExpanded.size) state.catalogueExpanded.add("latex:section-01");
    dom.fileTree.className = "tree scroll-y workspace-catalogue";
    groups.forEach(function (group) {
      var element = renderCatalogueGroup(group, "latex", filter);
      if (element) dom.fileTree.appendChild(element);
    });
    if (!dom.fileTree.children.length) dom.fileTree.innerHTML = '<div class="catalogue-empty">No manuscript file matches.</div>';
  }

  function renderCvCatalogue(filter) {
    var paths = state.treeIndex || [];
    var groups = [];
    var slugs = [];
    paths.forEach(function (path) {
      var match = path.match(/^applications\/([^/]+)\/application\.json$/);
      if (match) slugs.push(match[1]);
    });
    slugs.sort(function (left, right) { return left.localeCompare(right); });
    slugs.forEach(function (slug) {
      var prefix = "applications/" + slug + "/";
      var files = paths.filter(function (path) {
        return path.indexOf(prefix) === 0 && path.slice(prefix.length).indexOf("/") === -1;
      }).sort(function (left, right) {
        if (/application\.json$/.test(left)) return -1;
        if (/application\.json$/.test(right)) return 1;
        return left.localeCompare(right);
      }).map(function (path) { return {path:path, name:baseName(path)}; });
      if (files.length) groups.push({
        id: slug,
        label: slug.replace(/-/g, " ").replace(/\b\w/g, function (char) { return char.toUpperCase(); }),
        description: "CV, letters, texts and dossier",
        icon: "fa-folder-open",
        files: files,
      });
    });
    var shared = paths.filter(function (path) {
      return path === "applications/profile.json" || path === "applications/categories.json" ||
        /^applications\/_templates\/[^/]+$/.test(path) || path === "src/common/cvmodern.sty" ||
        path === "src/certificates/certificates.tex";
    }).map(function (path) { return {path:path, name:baseName(path)}; });
    if (shared.length) groups.push({id:"shared", label:"Shared design & templates",
      description:"Contact data, block starters and LaTeX style", icon:"fa-layer-group", files:shared});
    var guidance = ["AGENTS.md", "README.md", "TODO.md", "applications/README.md"]
      .filter(function (path) { return paths.indexOf(path) !== -1; })
      .map(function (path) { return {path:path, name:baseName(path)}; });
    groups.push({id:"guidance", label:"Guidance", description:"Agent rules and open questions",
      icon:"fa-circle-info", files:guidance});
    if (!state.catalogueExpanded.size && slugs.length) state.catalogueExpanded.add("latex:" + slugs[0]);
    dom.fileTree.className = "tree scroll-y workspace-catalogue";
    groups.forEach(function (group) {
      var element = renderCatalogueGroup(group, "latex", filter);
      if (element) dom.fileTree.appendChild(element);
    });
    if (!dom.fileTree.children.length) dom.fileTree.innerHTML = '<div class="catalogue-empty">No CV source file matches.</div>';
  }

  function numericsNodeContains(node, path) {
    if (node.path === path) return true;
    return (node.children || []).some(function (child) { return numericsNodeContains(child, path); });
  }

  function numericsNodeElement(node, depth, filter) {
    var haystack = [node.name, node.path].join(" ").toLowerCase();
    var ownMatch = !filter || haystack.indexOf(filter) !== -1;
    if (node.type === "file") {
      if (!ownMatch) return null;
      var file = catalogueFile(node, node.path);
      file.classList.add("numerics-tree-node");
      file.style.paddingLeft = 7 + depth * 12 + "px";
      return file;
    }

    var childFilter = ownMatch ? "" : filter;
    var children = (node.children || []).map(function (child) {
      return numericsNodeElement(child, depth + 1, childFilter);
    }).filter(Boolean);
    if (filter && !ownMatch && !children.length) return null;

    var key = "numerics-node:" + node.path;
    var forceOpen = !!filter || numericsNodeContains(node, state.active);
    var open = forceOpen || state.catalogueExpanded.has(key);
    var wrap = document.createElement("div");
    wrap.className = "numerics-tree-branch";
    var row = document.createElement("button");
    row.type = "button";
    row.className = "numerics-tree-node directory" + (open ? " open" : "");
    row.style.paddingLeft = 7 + depth * 12 + "px";
    row.title = node.path;
    row.setAttribute("aria-expanded", String(open));
    row.innerHTML = '<i class="tree-caret fa-solid fa-chevron-right"></i>' +
      '<i class="tree-icon fa-solid ' + (open ? "fa-folder-open ic-folder-open" : "fa-folder ic-folder") + '"></i>' +
      '<span class="tree-name">' + escapeHtml(node.name) + '</span><span class="node-count">' +
      Number(node.fileCount || 0) + "</span>";
    var body = document.createElement("div");
    body.className = "numerics-tree-children";
    body.id = "numerics-node-" + node.path.replace(/[^a-z0-9_-]+/gi, "-");
    body.hidden = !open;
    row.setAttribute("aria-controls", body.id);
    children.forEach(function (child) { body.appendChild(child); });
    row.addEventListener("click", function () {
      var next = body.hidden;
      body.hidden = !next;
      row.classList.toggle("open", next);
      row.setAttribute("aria-expanded", String(next));
      var icon = row.querySelector(".tree-icon");
      icon.className = "tree-icon fa-solid " + (next ? "fa-folder-open ic-folder-open" : "fa-folder ic-folder");
      if (next) state.catalogueExpanded.add(key);
      else state.catalogueExpanded.delete(key);
    });
    wrap.appendChild(row);
    wrap.appendChild(body);
    return wrap;
  }

  function renderNumericsCategory(category, filter) {
    var categoryMatch = !filter || [category.label, category.description].join(" ").toLowerCase().indexOf(filter) !== -1;
    var effectiveFilter = categoryMatch ? "" : filter;
    var nodes = category.nodes || [];
    if (nodes.length === 1 && nodes[0].type === "directory") nodes = nodes[0].children || [];
    var children = nodes.map(function (node) { return numericsNodeElement(node, 0, effectiveFilter); }).filter(Boolean);
    if (!children.length) return null;

    var key = "numerics-category:" + category.id;
    var open = !!filter || state.catalogueExpanded.has(key);
    var section = document.createElement("section");
    section.className = "workspace-group program" + (open ? " open" : "");
    var head = document.createElement("button");
    head.type = "button";
    head.className = "workspace-group-head";
    head.setAttribute("aria-expanded", String(open));
    head.innerHTML = '<span class="workspace-group-icon"><i class="fa-solid ' +
      escapeHtml(category.icon || "fa-folder") + '"></i></span><span class="workspace-group-copy"><strong>' +
      escapeHtml(category.label) + "</strong><span>" + escapeHtml(category.description || "") +
      '</span></span><span class="count">' + Number(category.fileCount || 0) +
      '</span><i class="group-caret fa-solid fa-chevron-right"></i>';
    var body = document.createElement("div");
    body.className = "workspace-group-items numerics-tree";
    body.id = "numerics-category-" + category.id;
    head.setAttribute("aria-controls", body.id);
    children.forEach(function (child) { body.appendChild(child); });
    head.addEventListener("click", function () {
      var next = !section.classList.contains("open");
      section.classList.toggle("open", next);
      head.setAttribute("aria-expanded", String(next));
      if (next) state.catalogueExpanded.add(key);
      else state.catalogueExpanded.delete(key);
    });
    section.appendChild(head);
    section.appendChild(body);
    return section;
  }

  function renderNumericsChamber(pipeline, filter) {
    var files = (pipeline.files || []).filter(function (item) {
      return !filter || [item.name, item.path, pipeline.section, pipeline.title, pipeline.description]
        .join(" ").toLowerCase().indexOf(filter) !== -1;
    });
    var chamberMatch = !filter || [pipeline.section, pipeline.title, pipeline.description, pipeline.entry]
      .join(" ").toLowerCase().indexOf(filter) !== -1;
    if (!chamberMatch && !files.length) return null;
    if (chamberMatch && filter) files = pipeline.files || [];

    var key = "numerics-chamber:" + pipeline.id;
    var open = !!filter || state.catalogueExpanded.has(key);
    var section = document.createElement("section");
    section.className = "workspace-group program numerics-chamber" +
      (open ? " open" : "") + (pipeline.id === state.selectedPipeline ? " selected" : "");
    section.dataset.pipeline = pipeline.id;
    var head = document.createElement("button");
    head.type = "button";
    head.className = "workspace-group-head";
    head.setAttribute("aria-expanded", String(open));
    head.innerHTML = '<span class="workspace-group-icon">' + escapeHtml(pipeline.section) +
      '</span><span class="workspace-group-copy"><strong>' + escapeHtml(pipeline.title) +
      '</strong><span>' + escapeHtml(pipeline.description || pipeline.entry) +
      '</span></span><span class="count">' + files.length +
      '</span><i class="group-caret fa-solid fa-chevron-right"></i>';
    var body = document.createElement("div");
    body.className = "workspace-group-items";
    body.id = "numerics-chamber-" + pipeline.id;
    head.setAttribute("aria-controls", body.id);

    var run = document.createElement("button");
    run.type = "button";
    run.className = "numerics-run-entry";
    run.title = pipeline.command || ("Run " + pipeline.entry);
    run.disabled = !pipeline.command;
    run.innerHTML = '<i class="fa-solid fa-play"></i><span class="numerics-run-entry-copy"><strong>' +
      escapeHtml(baseName(pipeline.entry || "Run chamber")) + '</strong><span>' +
      escapeHtml(pipeline.command || "No command configured") + '</span></span><span class="run-label">Run</span>';
    run.addEventListener("click", function () {
      selectPipeline(pipeline.id, { quiet: true });
      runNumericsCommand(pipeline.command, pipeline.title);
    });
    body.appendChild(run);

    var fileList = document.createElement("div");
    fileList.className = "numerics-chamber-files";
    files.forEach(function (item) {
      fileList.appendChild(catalogueFile(item, item.path, function () {
        selectPipeline(pipeline.id, { quiet: true });
        openFile(item.path);
      }));
    });
    body.appendChild(fileList);
    head.addEventListener("click", function () {
      var next = !section.classList.contains("open");
      if (next) state.catalogueExpanded.add(key);
      else state.catalogueExpanded.delete(key);
      if (pipeline.id !== state.selectedPipeline) selectPipeline(pipeline.id, { quiet: true });
      else renderTree();
    });
    section.appendChild(head);
    section.appendChild(body);
    return section;
  }

  function renderNumericsCatalogue(filter) {
    if (!state.numerics.enabled) {
      dom.fileTree.innerHTML = '<div class="catalogue-empty">This project has no configured Numerics workspace.</div>';
      return;
    }
    if (!state.numericsTreeInitialized) {
      if (state.selectedPipeline) state.catalogueExpanded.add("numerics-chamber:" + state.selectedPipeline);
      state.numericsTreeInitialized = true;
    }
    dom.fileTree.className = "tree scroll-y workspace-catalogue";
    (state.numerics.pipelines || []).forEach(function (pipeline) {
      var element = renderNumericsChamber(pipeline, filter);
      if (element) dom.fileTree.appendChild(element);
    });
    if (!dom.fileTree.children.length) dom.fileTree.innerHTML = '<div class="catalogue-empty">No numerical source matches.</div>';
  }

  function renderNodes(nodes, depth) {
    var fragment = document.createDocumentFragment();
    nodes.forEach(function (node) {
      if (node.type === "directory") {
        var open = state.expanded.has(node.path);
        var row = document.createElement("div");
        row.className = "tree-row" + (open ? " open" : "");
        row.dataset.path = node.path;
        row.dataset.type = "directory";
        row.style.paddingLeft = 6 + depth * 12 + "px";
        row.innerHTML =
          '<i class="tree-caret fa-solid fa-chevron-right"></i>' +
          '<i class="tree-icon fa-solid ' + (open ? "fa-folder-open ic-folder-open" : "fa-folder ic-folder") + '"></i>' +
          '<span class="tree-name">' + escapeHtml(node.name) + "</span>";
        var children = document.createElement("div");
        children.className = "tree-children" + (open ? "" : " hidden");
        children.appendChild(renderNodes(node.children || [], depth + 1));

        row.addEventListener("click", function () {
          var nowOpen = children.classList.toggle("hidden") === false;
          row.classList.toggle("open", nowOpen);
          var icon = row.querySelector(".tree-icon");
          icon.className = "tree-icon fa-solid " +
            (nowOpen ? "fa-folder-open ic-folder-open" : "fa-folder ic-folder");
          if (nowOpen) state.expanded.add(node.path);
          else state.expanded.delete(node.path);
        });
        row.addEventListener("contextmenu", function (event) {
          event.preventDefault();
          directoryMenu(event, node.path);
        });

        fragment.appendChild(row);
        fragment.appendChild(children);
      } else {
        fragment.appendChild(fileRow(node, depth, false));
      }
    });
    return fragment;
  }

  function fileRow(node, depth, showFullPath) {
    var icon = iconFor(node.path);
    var row = document.createElement("div");
    row.className = "tree-row";
    row.dataset.path = node.path;
    row.dataset.type = "file";
    row.style.paddingLeft = 6 + depth * 12 + (showFullPath ? 0 : 12) + "px";
    row.title = node.path;
    row.innerHTML =
      '<i class="tree-icon ' + icon[0] + " " + icon[1] + '"></i>' +
      '<span class="tree-name">' + escapeHtml(showFullPath ? node.path : node.name) + "</span>";
    row.addEventListener("click", function () { openFile(node.path); });
    row.addEventListener("dblclick", function () { openFile(node.path); });
    row.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      fileMenu(event, node.path);
    });
    return row;
  }

  function highlightTreeSelection() {
    Array.prototype.forEach.call(dom.fileTree.querySelectorAll(".tree-row, .workspace-file"), function (row) {
      row.classList.toggle("active", row.dataset.type === "file" && row.dataset.path === state.active);
      if (row.classList.contains("workspace-file")) row.classList.toggle("active", row.dataset.path === state.active);
    });
  }

  function directoryMenu(event, dirPath) {
    showContextMenu(event, [
      {
        label: "New file…", icon: "fa-file-circle-plus",
        action: function () { createEntry(dirPath, false); },
      },
      {
        label: "New folder…", icon: "fa-folder-plus",
        action: function () { createEntry(dirPath, true); },
      },
      "-",
      {
        label: "Copy path", icon: "fa-copy",
        action: function () { copyText(dirPath); },
      },
      {
        label: "Delete folder", icon: "fa-trash", danger: true,
        action: function () { deleteEntry(dirPath, true); },
      },
    ]);
  }

  function fileMenu(event, path) {
    showContextMenu(event, [
      { label: "Open", icon: "fa-arrow-right-to-bracket", action: function () { openFile(path); } },
      {
        label: "Diff against HEAD", icon: "fa-code-compare",
        action: function () { showDiff(path); },
      },
      "-",
      {
        label: "Rename…", icon: "fa-pen",
        action: function () { renameEntry(path); },
      },
      { label: "Copy path", icon: "fa-copy", action: function () { copyText(path); } },
      {
        label: "Delete file", icon: "fa-trash", danger: true,
        action: function () { deleteEntry(path, false); },
      },
    ]);
  }

  function copyText(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast("Copied " + text, "success"); });
    }
  }

  function createEntry(dirPath, isDir) {
    promptDialog(
      isDir ? "New folder" : "New file",
      "Create inside <strong>" + escapeHtml(dirPath || "the repository root") + "</strong>:",
      ""
    ).then(function (name) {
      if (!name) return;
      var target = dirPath ? dirPath + "/" + name : name;
      api.create(target, isDir).then(function (data) {
        if (!data.success) { toast(data.error || "Could not create " + target, "error"); return; }
        if (dirPath) state.expanded.add(dirPath);
        loadTree().then(function () { if (!isDir) openFile(target); });
        toast("Created " + target, "success");
      });
    });
  }

  function renameEntry(path) {
    promptDialog("Rename", "Rename <strong>" + escapeHtml(path) + "</strong> to:", path).then(function (target) {
      if (!target || target === path) return;
      api.rename(path, target).then(function (data) {
        if (!data.success) { toast(data.error || "Rename failed", "error"); return; }
        if (state.docs[path]) {
          var wasActive = state.active === path;
          closeTabSilently(path);
          loadTree().then(function () { if (wasActive) openFile(target); });
        } else {
          loadTree();
        }
        toast("Renamed to " + target, "success");
      });
    });
  }

  function closeTabSilently(path) {
    if (state.docs[path]) dropDocument(path);
  }

  function deleteEntry(path, isDir) {
    confirmDialog(
      "Delete " + (isDir ? "folder" : "file"),
      "Permanently delete <strong>" + escapeHtml(path) + "</strong>? This cannot be undone from the IDE.",
      "Delete"
    ).then(function (ok) {
      if (!ok) return;
      api.remove(path).then(function (data) {
        if (!data.success) { toast(data.error || "Delete failed", "error"); return; }
        closeTabSilently(path);
        loadTree();
        toast("Deleted " + path, "success");
      });
    });
  }

  /* ====================================================================== */
  /* 8. Outline                                                              */
  /* ====================================================================== */

  function loadOutline() {
    return api.outline().then(function (data) {
      if (!data.success) return;
      state.outline = {
        outline: data.outline || [],
        labels: data.labels || [],
        figures: data.figures || [],
        equations: data.equations || [],
      };
      renderOutline();
      if (state.workspaceMode === "latex" && !state.fullRepository) renderTree();
    });
  }

  var ROMAN = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];

  function toRoman(value) {
    var out = "";
    ROMAN.forEach(function (pair) {
      while (value >= pair[0]) { out += pair[1]; value -= pair[0]; }
    });
    return out;
  }

  /**
   * Number the outline the way the document does: Roman sections, then dotted
   * decimals below. Starred headings carry a glyph instead of a number.
   */
  function numberOutline(items) {
    var counters = [0, 0, 0, 0, 0, 0, 0, 0];
    return items.map(function (item) {
      var level = Math.max(2, Math.min(item.level, 7));
      if (item.numbered === false) return { item: item, label: "•" };
      var printed = printedUnit(item.file);
      if (printed) return { item: item, label: printed };
      counters[level] += 1;
      for (var deeper = level + 1; deeper < counters.length; deeper += 1) counters[deeper] = 0;
      var parts = [toRoman(counters[2] || 1)];
      for (var l = 3; l <= level; l += 1) parts.push(counters[l]);
      return { item: item, label: parts.join(".") };
    });
  }

  function renderOutline() {
    if (state.workspaceMode === "numerics") {
      renderNumericsOutline();
      return;
    }
    var filter = dom.outlineFilter.value.trim().toLowerCase();
    var numbered = numberOutline(state.outline.outline);
    var items = numbered.filter(function (entry) {
      return !filter ||
        entry.item.title.toLowerCase().indexOf(filter) !== -1 ||
        entry.label.toLowerCase().indexOf(filter) !== -1;
    });

    dom.outlineList.innerHTML = "";
    if (!items.length) {
      dom.outlineList.innerHTML = '<div class="tree-empty">No sections match.</div>';
      return;
    }
    items.forEach(function (entry) {
      var item = entry.item;
      var row = document.createElement("div");
      row.className = "outline-row lvl-" + Math.max(2, Math.min(item.level, 7));
      row.dataset.file = item.file;
      row.dataset.line = item.line;
      row.title = item.title + "  —  " + item.file + ":" + item.line;
      row.innerHTML =
        '<span class="ol-num">' + escapeHtml(entry.label) + "</span>" +
        '<span class="ol-title">' + escapeHtml(item.title || "(untitled)") + "</span>";
      row.addEventListener("click", function () {
        openFile(item.file, { line: item.line, flash: true });
      });
      dom.outlineList.appendChild(row);
    });
    markOutlineCurrent();
  }

  function renderNumericsOutline() {
    var filter = dom.outlineFilter.value.trim().toLowerCase();
    var items = (state.numerics.pipelines || []).filter(function (item) {
      return !filter || [item.title, item.path, item.description, item.section].join(" ").toLowerCase().indexOf(filter) !== -1;
    });
    dom.outlineList.innerHTML = "";
    if (!items.length) {
      dom.outlineList.innerHTML = '<div class="tree-empty">No numerical pipeline matches.</div>';
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement("article");
      row.className = "outline-row pipeline-row pipeline-chamber" + (item.id === state.selectedPipeline ? " selected" : "");
      row.dataset.file = item.path;
      row.dataset.pipeline = item.id;
      row.title = item.path;
      var figureCount = (item.figureNumbers || []).length;
      var dataCount = (state.numerics.measurements || []).filter(function (data) { return data.pipeline === item.id; }).length;
      row.innerHTML = '<span class="pipeline-section">' + escapeHtml(item.section) + '</span>' +
        '<span class="pipeline-copy"><strong>' + escapeHtml(item.title) + "</strong><span>" + escapeHtml(item.description || item.path) +
        '</span><span class="pipeline-counts"><b>' + figureCount + '</b> figures · <b>' + dataCount +
        '</b> data sets</span></span><button class="pipeline-run" title="Run this chamber"><i class="fa-solid fa-play"></i></button>';
      row.addEventListener("click", function (event) {
        if (!event.target.closest(".pipeline-run")) selectPipeline(item.id, { openEntry: true });
      });
      row.querySelector(".pipeline-run").addEventListener("click", function (event) {
        event.stopPropagation();
        selectPipeline(item.id, { quiet: true });
        runNumericsCommand(item.command, item.title);
      });
      dom.outlineList.appendChild(row);
    });
    markOutlineCurrent();
  }

  /* Highlight the heading that contains the cursor in the active file. */
  function markOutlineCurrent() {
    if (!state.active || !state.editor) return;
    var position = state.editor.getPosition();
    var bestLine = -1;
    state.outline.outline.forEach(function (item) {
      if (item.file === state.active && item.line <= (position ? position.lineNumber : 1) && item.line > bestLine) {
        bestLine = item.line;
      }
    });
    Array.prototype.forEach.call(dom.outlineList.querySelectorAll(".outline-row"), function (row) {
      row.classList.toggle(
        "current",
        row.dataset.file === state.active && Number(row.dataset.line) === bestLine
      );
    });
  }

  /* ====================================================================== */
  /* 8b. LaTeX / Numerics workspace                                         */
  /* ====================================================================== */

  function loadNumericsWorkspace(options) {
    options = options || {};
    if (options.refreshArtifacts) thumbCache = Object.create(null);
    return api.numerics().then(function (data) {
      if (!data.success) {
        if (!options.quiet) toast(data.error || "Could not read the Numerics workspace", "error");
        return;
      }
      state.numerics = Object.assign({
        enabled: false, root: "Numerics", pipelines: [], groups: [], categories: [], figures: [], measurements: [],
      }, data);
      if (!(state.numerics.pipelines || []).some(function (item) { return item.id === state.selectedPipeline; }))
        state.selectedPipeline = ((state.numerics.pipelines || [])[0] || {}).id || null;
      renderNumericsActions();
      if (state.workspaceMode === "numerics") {
        renderTree();
        renderOutline();
        renderNumericsResults();
      }
    });
  }

  function pipelineUnit(pipeline) {
    return pipeline.unit || "Section " + pipeline.section;
  }

  function pipelineById(id) {
    return (state.numerics.pipelines || []).filter(function (item) { return item.id === id; })[0] || null;
  }

  function renderNumericsActions() {
    var pipeline = pipelineById(state.selectedPipeline);
    dom.numericsActions.innerHTML = pipeline ? '<span class="numerics-chamber-chip"><b>' +
      escapeHtml(pipeline.section) + '</b> ' + escapeHtml(pipeline.title) + '</span>' : "";
    dom.numericsContext.textContent = pipeline
      ? pipelineUnit(pipeline) + " · " + pipeline.description
      : "Choose a calculation chamber.";
  }

  function figuresForPipeline() {
    return (state.numerics.figures || []).filter(function (item) { return item.pipeline === state.selectedPipeline; });
  }

  function measurementsForPipeline() {
    return (state.numerics.measurements || []).filter(function (item) {
      return item.pipeline === state.selectedPipeline && item.available !== false;
    });
  }

  function selectPipeline(id, options) {
    options = options || {};
    var pipeline = pipelineById(id);
    if (!pipeline) return;
    state.selectedPipeline = id;
    state.selectedArtifact = null;
    state.selectedMeasurement = null;
    renderNumericsActions();
    if (state.workspaceMode === "numerics") {
      renderOutline();
      renderTree();
      renderNumericsResults();
    }
    dom.numericsContext.textContent = pipelineUnit(pipeline) + " · " + pipeline.description;
    if (options.openEntry) openFile(pipeline.entry, { focus: true });
  }

  function clearResultPreview() {
    dom.artifactImage.hidden = true;
    dom.artifactPdf.hidden = true;
    dom.measurementTableWrap.hidden = true;
    dom.artifactImage.removeAttribute("src");
    dom.artifactPdf.removeAttribute("src");
    dom.artifactEmpty.hidden = false;
    dom.btnOpenArtifact.disabled = true;
  }

  function selectArtifact(label) {
    var item = figuresForPipeline().filter(function (figure) { return figure.label === label; })[0];
    state.selectedArtifact = item ? item.label : null;
    clearResultPreview();
    dom.artifactTitle.textContent = item ? "Figure " + item.number + " · " + item.title : "Active manuscript figures";
    dom.artifactPath.textContent = item ? item.label : "This chamber has no figure preview";
    dom.btnOpenArtifact.disabled = !item;
    if (item) {
      dom.artifactEmpty.querySelector("p").textContent = "Rendering Figure " + item.number + " from the current manuscript PDF…";
      dom.artifactImage.onload = function () { dom.artifactImage.hidden = false; dom.artifactEmpty.hidden = true; };
      dom.artifactImage.onerror = function () {
        dom.artifactEmpty.hidden = false;
        dom.artifactEmpty.querySelector("p").textContent = "Preview unavailable. Recompile the document to refresh its SyncTeX figure crop.";
      };
      dom.artifactImage.src = "/api/numerics/figure?label=" + encodeURIComponent(item.label) + "&t=" + Date.now();
    } else {
      dom.artifactEmpty.querySelector("p").textContent = "This calculation chamber has no active manuscript figure.";
    }
    Array.prototype.forEach.call(dom.artifactFilmstrip.querySelectorAll(".artifact-card"), function (card) {
      card.classList.toggle("active", card.dataset.label === state.selectedArtifact);
    });
  }

  function renderMeasurementTable(data) {
    var head = "<thead><tr>" + (data.columns || []).map(function (column) {
      return "<th>" + escapeHtml(column) + "</th>";
    }).join("") + "</tr></thead>";
    var body = "<tbody>" + (data.rows || []).map(function (row) {
      return "<tr>" + row.map(function (cell) { return "<td>" + escapeHtml(cell) + "</td>"; }).join("") + "</tr>";
    }).join("") + "</tbody>";
    dom.measurementTable.innerHTML = head + body;
    dom.measurementMeta.textContent = data.totalRows + " rows" + (data.truncated ? " · showing the first " + data.rows.length : "");
  }

  function selectMeasurement(path) {
    var item = measurementsForPipeline().filter(function (measurement) { return measurement.path === path; })[0];
    state.selectedMeasurement = item ? item.path : null;
    clearResultPreview();
    dom.artifactTitle.textContent = item ? item.name : "Measurement library";
    dom.artifactPath.textContent = item ? "Figure " + item.figure + " · " + item.path : "No active table in this chamber";
    dom.btnOpenArtifact.disabled = !item;
    if (!item) {
      dom.artifactEmpty.querySelector("p").textContent = "This calculation chamber has no separate measurement table.";
      return;
    }
    dom.artifactEmpty.querySelector("p").textContent = "Loading measurement data…";
    api.numericsData(item.path).then(function (data) {
      if (state.selectedMeasurement !== item.path) return;
      if (!data.success) {
        dom.artifactEmpty.querySelector("p").textContent = data.error || "The measurement could not be loaded.";
        return;
      }
      renderMeasurementTable(data);
      dom.measurementTableWrap.hidden = false;
      dom.artifactEmpty.hidden = true;
    });
    Array.prototype.forEach.call(dom.artifactFilmstrip.querySelectorAll(".artifact-card"), function (card) {
      card.classList.toggle("active", card.dataset.path === state.selectedMeasurement);
    });
  }

  function setNumericsResultMode(mode) {
    state.numericsResultMode = mode === "measurements" ? "measurements" : "figures";
    Array.prototype.forEach.call(document.querySelectorAll("[data-result-mode]"), function (button) {
      var active = button.dataset.resultMode === state.numericsResultMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    renderNumericsResults();
  }

  function renderNumericsResults() {
    if (!dom.artifactFilmstrip) return;
    var figures = figuresForPipeline();
    var measurements = measurementsForPipeline();
    dom.resultFigureCount.textContent = String(figures.length);
    dom.resultDataCount.textContent = String(measurements.length);
    dom.artifactFilmstrip.innerHTML = "";
    var items = state.numericsResultMode === "measurements" ? measurements : figures;
    items.forEach(function (item) {
      var card = document.createElement("button");
      card.className = "artifact-card";
      if (state.numericsResultMode === "measurements") {
        card.dataset.path = item.path;
        card.title = item.path;
        card.innerHTML = '<i class="fa-solid fa-table"></i><strong>' + escapeHtml(item.name) +
          '</strong><span>FIG ' + item.figure + " · " + escapeHtml(item.extension) + "</span>";
        card.addEventListener("click", function () { selectMeasurement(item.path); });
      } else {
        card.dataset.label = item.label;
        card.title = item.label + "\n" + (item.sources || []).join("\n");
        card.innerHTML = '<i class="fa-solid fa-chart-line"></i><strong>Figure ' + item.number + "</strong><span>" +
          escapeHtml(item.title) + "</span>";
        card.addEventListener("click", function () { selectArtifact(item.label); });
      }
      dom.artifactFilmstrip.appendChild(card);
    });
    if (state.numericsResultMode === "measurements") {
      var keepData = measurements.some(function (item) { return item.path === state.selectedMeasurement; });
      selectMeasurement(keepData ? state.selectedMeasurement : (measurements[0] || {}).path);
    } else {
      var keepFigure = figures.some(function (item) { return item.label === state.selectedArtifact; });
      selectArtifact(keepFigure ? state.selectedArtifact : (figures[0] || {}).label);
    }
  }

  function syncConsoleHome() {
    var home = state.workspaceMode === "numerics" ? dom.numericsConsoleHome : dom.drawerConsoleHome;
    if (!home || dom.consoleTabs.parentNode === home) return;
    home.appendChild(dom.consoleTabs);
    home.appendChild(dom.consoleSessions);
    renderConsoleTabs();
  }

  function defaultFileForMode(mode) {
    var remembered = state.workspaceTabs[mode] && state.workspaceTabs[mode].active;
    if (remembered && state.treeIndex.indexOf(remembered) !== -1) return remembered;
    if (mode === "numerics") {
      var firstPipeline = (state.numerics.pipelines || [])[0];
      return firstPipeline ? firstPipeline.entry : null;
    }
    return chooseEntryFile();
  }

  function modeForPath(path) {
    var numericsRoot = ((state.numerics || {}).root || "Numerics").replace(/\/+$/, "") + "/";
    var normalized = String(path || "").replace(/\\/g, "/");
    if (normalized.indexOf(numericsRoot) === 0) return "numerics";
    return /\.(?:py|pyw|jl|ps1|psm1|sh|bat|cmd|c|cc|cpp|cxx|h|hh|hpp|hxx|java|kt|kts|rs|go|js|mjs|cjs|ts|tsx|jsx)$/i.test(normalized)
      ? "numerics"
      : "latex";
  }

  function setWorkspaceMode(mode, options) {
    options = options || {};
    if (mode !== "numerics") mode = "latex";
    if (mode === "numerics" && !state.numerics.enabled) {
      toast("This project has no configured Numerics workspace", "warn");
      mode = "latex";
    }
    var previousMode = state.workspaceMode;
    if (previousMode !== mode) {
      saveWorkspaceTabs(previousMode);
      var next = state.workspaceTabs[mode] || { order: [], active: null };
      state.order = next.order.filter(function (path) { return !!state.docs[path]; });
      state.active = next.active && state.order.indexOf(next.active) !== -1 ? next.active : (state.order[0] || null);
      state.editor.setModel(null);
    }
    state.workspaceMode = mode;
    state.fullRepository = false;
    document.body.dataset.workspaceMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll("[data-workspace-mode]"), function (button) {
      var active = button.dataset.workspaceMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    dom.workspaceFilesTitle.textContent = mode === "numerics" ? "Run chambers & files" : "CV sources";
    dom.workspaceOutlineTitle.textContent = mode === "numerics" ? "Run chambers" : "Document outline";
    dom.fileFilter.placeholder = mode === "numerics" ? "Filter chambers or files (Ctrl+P)" : "Find a file (Ctrl+P)";
    dom.outlineFilter.placeholder = mode === "numerics" ? "Filter run chambers" : "Filter sections";
    dom.latexViewerHead.hidden = mode !== "latex";
    dom.numericsViewerHead.hidden = mode !== "numerics";
    dom.viewPdf.classList.toggle("active", mode === "latex");
    dom.viewLogs.classList.remove("active");
    dom.viewNumerics.classList.toggle("active", mode === "numerics");
    dom.btnSyncForward.disabled = mode === "numerics";
    dom.btnSyncForward.tabIndex = mode === "numerics" ? -1 : 0;
    dom.btnSyncForward.setAttribute("aria-hidden", mode === "numerics" ? "true" : "false");
    dom.btnToggleFullRepo.classList.remove("active");
    dom.btnNewFile.hidden = true;
    dom.btnNewFolder.hidden = true;
    dom.btnToggleDrawer.title = mode === "numerics" ? "Diff drawer (Ctrl+`)" : "Console and diff (Ctrl+`)";
    syncConsoleHome();
    if (mode === "numerics") closeDrawer();
    renderTree();
    renderOutline();
    renderNumericsResults();
    var target = defaultFileForMode(mode);
    if (state.active && state.docs[state.active]) activate(state.active, { focus: false });
    else if (!options.keepFile && target) openFile(target, { focus: false });
    else {
      renderTabs();
      dom.breadcrumb.textContent = "";
      dom.statusLanguage.textContent = "—";
      dom.statusFileState.textContent = "no file";
    }
    saveWorkspaceTabs(mode);
    rememberSession();
  }

  function toggleFullRepository() {
    state.fullRepository = !state.fullRepository;
    dom.btnToggleFullRepo.classList.toggle("active", state.fullRepository);
    dom.btnToggleFullRepo.title = state.fullRepository ? "Return to the curated workspace" : "Show every repository file";
    dom.btnNewFile.hidden = !state.fullRepository;
    dom.btnNewFolder.hidden = !state.fullRepository;
    dom.workspaceFilesTitle.textContent = state.fullRepository ? "Full repository" :
      (state.workspaceMode === "numerics" ? "Numerics structure" : "CV sources");
    renderTree();
  }

  function commandForActiveFile() {
    var pipeline = (state.numerics.pipelines || []).filter(function (item) { return item.path === state.active; })[0];
    if (pipeline && pipeline.command) return pipeline.command;
    var quoted = '"' + String(state.active || "").replace(/"/g, "") + '"';
    var ext = extOf(state.active || "");
    if (ext === "py") return "python -X utf8 " + quoted;
    if (ext === "jl") return "julia " + quoted;
    if (ext === "ps1") return "pwsh -NoProfile -ExecutionPolicy Bypass -File " + quoted;
    return "";
  }

  function runNumericsCommand(command, label) {
    if (!command) {
      toast("Open a Python, Julia or PowerShell program to run it", "warn");
      return;
    }
    saveAll(false).then(function (saved) {
      if (!saved) toast("Some files could not be saved. Running the disk version.", "warn", 5500);
      dom.numericsStatus.textContent = "Running";
      dom.numericsStatus.className = "chip chip-status is-busy";
      dom.numericsContext.textContent = command;
      runCommand(command, label || baseName(state.active || "Numerics"), function (result) {
        var ok = result && result.exitCode === 0 && !result.interrupted;
        dom.numericsStatus.textContent = result && result.interrupted ? "Stopped" : (ok ? "Complete" : "Failed");
        dom.numericsStatus.className = "chip chip-status " + (ok ? "is-ok" : "is-error");
        loadNumericsWorkspace({ quiet: true, refreshArtifacts: true });
      });
    });
  }

  function runActiveNumerics() {
    var pipeline = pipelineById(state.selectedPipeline);
    runNumericsCommand(pipeline ? pipeline.command : commandForActiveFile(), pipeline ? pipeline.title :
      (state.active ? baseName(state.active) : "Run chamber"));
  }

  function primaryAction() {
    if (state.workspaceMode === "numerics") runActiveNumerics();
    else recompile();
  }

  /* ====================================================================== */
  /* 9. Review comments                                                      */
  /* ====================================================================== */

  function loadComments() {
    return api.comments().then(function (data) {
      state.comments = data.success ? data.comments : [];
      renderComments();
      applyCommentDecorations();
      if (state.ai) renderAiOverview();
    });
  }

  function setCommentFilter(filter) {
    state.commentFilter = filter;
    Array.prototype.forEach.call(document.querySelectorAll("#comments-filter .seg-btn"), function (button) {
      button.classList.toggle("active", button.dataset.filter === filter);
    });
    renderComments();
  }

  function renderComments() {
    CommentDictation.cancel(dom.commentsList);
    var items = state.comments.filter(function (comment) {
      if (state.commentFilter === "all") return true;
      return (comment.status || "open") === state.commentFilter;
    });
    var open = state.comments.filter(function (c) { return (c.status || "open") === "open"; }).length;
    var resolvedCount = state.comments.length - open;
    dom.commentsCount.textContent = String(open);
    dom.commentsCount.hidden = open === 0;
    $("comments-open-count").textContent = String(open);
    $("comments-resolved-count").textContent = String(resolvedCount);

    dom.commentsList.innerHTML = "";
    if (!items.length) {
      dom.commentsList.innerHTML = state.commentFilter === "open"
        ? '<div class="comments-empty"><i class="fa-solid fa-circle-check"></i>No open comments.' +
          (resolvedCount ? '<br>' + resolvedCount + ' resolved in the Resolved tab.' : '') + '</div>'
        : '<div class="comments-empty">No comments here yet.</div>';
      return;
    }
    items.forEach(function (comment) {
      var card = document.createElement("div");
      var resolved = (comment.status || "open") === "resolved";
      var replies = (comment.replies || []).map(function (reply) {
        return '<div class="comment-reply">' +
          '<div class="comment-reply-meta"><strong>' + escapeHtml(reply.author || "Author") + '</strong><span>' +
          escapeHtml((reply.createdAt || "").slice(0, 16).replace("T", " ")) + '</span></div>' +
          '<div class="comment-reply-body">' + escapeHtml(reply.text || "") + '</div></div>';
      }).join("");
      card.className = "comment-card" + (resolved ? " resolved" : "");
      card.innerHTML =
        '<div class="comment-meta">' +
          '<span class="comment-loc" title="' + escapeHtml(comment.file + ":" + comment.startLine) + '">' +
            escapeHtml(baseName(comment.file)) + ":" + comment.startLine + "</span>" +
          (state.commentFilter === "all" ? '<span class="comment-state ' + (resolved ? "resolved" : "open") + '">' +
            (resolved ? "resolved" : "open") + '</span>' : '') +
          "<span>" + escapeHtml((comment.createdAt || "").slice(0, 16).replace("T", " ")) + "</span>" +
        "</div>" +
         (comment.selectedText ? '<div class="comment-quote">' + escapeHtml(comment.selectedText.slice(0, 240)) + "</div>" : "") +
         '<div class="comment-body">' + escapeHtml(comment.text) + "</div>" +
         (replies ? '<div class="comment-thread">' + replies + '</div>' : '') +
         '<div class="comment-actions">' +
           '<button data-act="jump"><i class="fa-solid fa-arrow-right"></i> Jump</button>' +
           '<button data-act="reply"><i class="fa-solid fa-reply"></i> Reply' +
             ((comment.replies || []).length ? ' (' + (comment.replies || []).length + ')' : '') + '</button>' +
           '<button data-act="toggle">' + (resolved ? "Reopen" : '<i class="fa-solid fa-check"></i> Resolve') + "</button>" +
           '<button data-act="delete" class="danger">Delete</button>' +
         '</div>' +
         '<div class="comment-reply-form" hidden><textarea rows="2" placeholder="Write a reply…"></textarea>' +
         '<button type="button" class="comment-reply-send"><i class="fa-solid fa-paper-plane"></i> Send</button></div>';

      card.querySelector('[data-act="jump"]').addEventListener("click", function () {
        openFile(comment.file, { line: comment.startLine, column: comment.startCol, flash: true });
      });
      card.querySelector(".comment-loc").addEventListener("click", function () {
        openFile(comment.file, { line: comment.startLine, column: comment.startCol, flash: true });
      });
      card.querySelector('[data-act="toggle"]').addEventListener("click", function () {
        api.commentStatus(comment.id, resolved ? "open" : "resolved").then(loadComments);
      });
      var replyForm = card.querySelector(".comment-reply-form");
      var replyText = replyForm.querySelector("textarea");
      var draft = state.replyDrafts[comment.id];
      if (draft) {
        replyText.value = draft.text;
        replyForm.hidden = draft.hidden;
      }
      function rememberReply() {
        state.replyDrafts[comment.id] = { text: replyText.value, hidden: replyForm.hidden };
      }
      replyText.addEventListener("input", rememberReply);
      CommentDictation.attach(replyText);
      var replySubmitting = false;
      async function submitReply() {
        if (replySubmitting) return;
        replySubmitting = true;
        await CommentDictation.finish(replyText);
        var text = replyText.value.trim();
        if (!text || replyForm.hidden || !replyText.isConnected) { replySubmitting = false; return; }
        replyText.disabled = true;
        api.commentReply(comment.id, text).then(function (data) {
          if (!data.success) {
            replySubmitting = false;
            replyText.disabled = false;
            toast(data.error || "Could not save the reply", "error");
            return;
          }
          delete state.replyDrafts[comment.id];
          loadComments();
        }).catch(function (error) {
          replySubmitting = false;
          replyText.disabled = false;
          toast(error.message || "Could not save the reply", "error");
        });
      }
      card.querySelector('[data-act="reply"]').addEventListener("click", function () {
        if (!replyForm.hidden) CommentDictation.cancel(replyForm);
        replyForm.hidden = !replyForm.hidden;
        rememberReply();
        if (!replyForm.hidden) replyText.focus();
      });
      replyForm.querySelector(".comment-reply-send").addEventListener("click", submitReply);
      replyText.addEventListener("keydown", function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          submitReply();
        }
      });
      card.querySelector('[data-act="delete"]').addEventListener("click", function () {
        confirmDialog("Delete comment",
          "Delete this comment on <strong>" + escapeHtml(baseName(comment.file) + ":" + comment.startLine) +
          "</strong> with its replies? Resolving keeps it in the Resolved tab instead.", "Delete")
          .then(function (ok) { if (ok) api.deleteComment(comment.id).then(loadComments); });
      });
      dom.commentsList.appendChild(card);
    });
  }

  function applyCommentDecorations() {
    if (!state.monacoReady || !state.commentDecorations || !state.active) return;
    var forFile = state.comments.filter(function (c) { return c.file === state.active; });
    state.commentDecorations.set(forFile.map(function (comment) {
      var resolved = (comment.status || "open") === "resolved";
      return {
        range: new monaco.Range(
          comment.startLine, comment.startCol,
          comment.endLine, Math.max(comment.endCol, comment.startCol + 1)
        ),
        options: {
          className: "comment-inline" + (resolved ? " resolved" : ""),
          glyphMarginClassName: "comment-glyph",
          hoverMessage: [{ value: "**Review** — " + comment.text }],
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    }));
  }

  function startComment() {
    if (!state.active) return;
    var selection = state.editor.getSelection();
    var model = state.editor.getModel();
    if (!model) return;
    var text = model.getValueInRange(selection);
    if (!text.trim()) {
      var line = selection.startLineNumber;
      selection = new monaco.Selection(line, 1, line, model.getLineMaxColumn(line));
      text = model.getValueInRange(selection);
    }
    state.pendingSelection = {
      file: state.active,
      startLine: selection.startLineNumber,
      startCol: selection.startColumn,
      endLine: selection.endLineNumber,
      endCol: selection.endColumn,
      selectedText: text,
    };
    $("comment-anchor").textContent =
      state.active + ":" + selection.startLineNumber + "\n" + text.slice(0, 400);
    CommentDictation.cancel($("modal-comment"));
    $("comment-text").value = "";
    openModal("modal-comment");
    setTimeout(function () { $("comment-text").focus(); }, 40);
  }

  async function submitComment() {
    var button = $("btn-submit-comment");
    if (button.disabled) return;
    button.disabled = true;
    var pendingSelection = state.pendingSelection;
    await CommentDictation.finish($("comment-text"));
    button.disabled = false;
    if (!$("modal-comment").classList.contains("open") || state.pendingSelection !== pendingSelection) return;
    var text = $("comment-text").value.trim();
    if (!text || !state.pendingSelection) return;
    button.disabled = true;
    var payload = Object.assign({}, state.pendingSelection, { text: text, author: "Owner" });
    api.addComment(payload).then(function (data) {
      if (!data.success) { toast(data.error || "Could not save the comment", "error"); return; }
      closeModal("modal-comment");
      state.pendingSelection = null;
      loadComments();
      toast("Comment added", "success");
    }).catch(function (error) {
      toast(error.message || "Could not save the comment", "error");
    }).finally(function () {
      button.disabled = false;
    });
  }

  /* ====================================================================== */
  /* 10. Git                                                                 */
  /* ====================================================================== */

  var gitOperationRunning = false;

  function updateGitControls() {
    var data = state.gitStatus || {};
    var staged = (data.staged || []).length;
    var canPublish = data.success && data.branch === "main" &&
      (data.remotes || []).indexOf("origin") !== -1 && !(data.conflicts || []).length;
    $("btn-git-commit").disabled = gitOperationRunning || !canPublish || (!staged && !data.canPush);
    $("git-commit-label").textContent = gitOperationRunning ? "Working…" :
      (staged ? "Commit and Push" : "Push to main");
    $("btn-git-commit").title = staged ? "Commit staged files and push directly to origin/main" :
      "Push existing local commits to origin/main without creating another commit";
    $("btn-git-push").disabled = gitOperationRunning || !canPublish || !data.canPush;
    $("btn-git-pull").disabled = gitOperationRunning;
    $("btn-git-stage-all").disabled = gitOperationRunning ||
      (!(data.modified || []).length && !(data.untracked || []).length);
    $("btn-git-unstage-all").disabled = gitOperationRunning || !staged;
    $("git-commit-msg").disabled = gitOperationRunning;
    document.querySelectorAll("#panel-git .git-act").forEach(function (button) {
      button.disabled = gitOperationRunning;
    });
  }

  function publishGit(commitStaged) {
    if (gitOperationRunning) return;
    var message = $("git-commit-msg").value.trim();
    var hasStaged = ((state.gitStatus || {}).staged || []).length > 0;
    if (commitStaged && hasStaged && !message) {
      toast("Write a commit message first", "warn");
      return;
    }
    gitOperationRunning = true;
    updateGitControls();
    $("git-publish-status").textContent = commitStaged && hasStaged ? "Committing and pushing to origin/main…" :
      "Pushing local commits to origin/main…";
    var request = commitStaged ? api.gitCommitAndPush(message) : api.gitPush();
    request.then(function (data) {
      if (data.steps && data.steps.length) {
        data.steps.forEach(function (step) { recordOperation(step.label, step, true); });
      } else {
        recordOperation("Git publish", data, true);
      }
      if (data.committed) $("git-commit-msg").value = "";
      var summary = data.summary || (data.success ? "Pushed to origin/main." :
        (data.stderr || data.error || "Push failed. Local commits are still saved; see console."));
      $("git-publish-status").textContent = summary;
      toast(summary, data.success ? "success" : "error", data.success ? 4500 : 9000);
    }).catch(function (error) {
      var summary = "Could not confirm publication. Refresh Git status before retrying. " + error.message;
      $("git-publish-status").textContent = summary;
      toast(summary, "error", 9000);
    }).finally(function () {
      gitOperationRunning = false;
      updateGitControls();
      loadGitStatus();
    });
  }

  function recordOperation(label, data, openOnSuccess) {
    data = data || { success: false, stderr: "No response" };
    var shouldOpen = !!openOnSuccess || !data.success;
    var session = createConsoleSession(label, data.command || label, {
      status: "running", open: shouldOpen, activate: shouldOpen,
    });
    appendConsoleHtml('<span class="c-cmd">$ ' + escapeHtml(data.command || label) + '</span>\n', session.id);
    appendConsole(data.stdout || "", session.id);
    if (data.success && data.stderr) {
      // A successful Git command may emit progress or maintenance diagnostics.
      // Preserve them without colouring a successful commit as a failed one.
      appendConsoleHtml('<span class="c-warn">' + escapeHtml(data.stderr) + '</span>', session.id);
    } else {
      appendConsole(data.stderr || "", session.id);
    }
    if (!String((data.stdout || "") + (data.stderr || "")).endsWith("\n")) appendConsole("\n", session.id);
    appendConsole("[exit code " + (data.exit_code == null ? (data.success ? 0 : 1) : data.exit_code) + "]\n", session.id);
    finishConsoleSession(session, { exitCode: data.success ? 0 : (data.exit_code == null ? 1 : data.exit_code) });
    return data;
  }

  function loadGitStatus(options) {
    options = options || {};
    return api.gitStatus().then(function (data) {
      if (!data.success) {
        state.gitStatus = data;
        updateGitControls();
        renderGitGroups([], { unavailable: true });
        dom.gitCount.hidden = true;
        dom.gitRemoteSummary.textContent = data.error || data.stderr || "Git status unavailable";
        return data;
      }
      var groups = normalizedGitGroups(data);
      data.groups = groups;
      state.gitStatus = data;
      dom.currentBranch.textContent = data.branch +
        (data.ahead ? " ↑" + data.ahead : "") + (data.behind ? " ↓" + data.behind : "");

      renderGitGroups(groups);

      $("git-staged-count").textContent = String((data.staged || []).length);
      $("git-modified-count").textContent = String((data.modified || []).length);
      $("git-untracked-count").textContent = String((data.untracked || []).length);

      var remoteText = data.upstream ? data.upstream :
        ((data.remotes || []).length ? "Remote: " + data.remotes.join(", ") + " · no upstream yet" : "No remote configured");
      dom.gitRemoteSummary.textContent = remoteText +
        (data.ahead ? " · " + data.ahead + " ahead" : "") +
        (data.behind ? " · " + data.behind + " behind" : "");
      updateGitControls();

      var total = groups.reduce(function (sum, group) {
        return sum + (group.entries || []).length;
      }, 0);
      dom.gitCount.textContent = String(total);
      dom.gitCount.hidden = total === 0;
      return data;
    }).then(function () {
      if (options.graph === false) return null;
      return api.gitGraph().then(function (data) {
        if (data.success) renderGitGraph(data);
      }).catch(function (error) {
        console.warn("Git history unavailable", error);
        return null;
      });
    }).catch(function (error) {
      state.gitStatus = { success: false, error: error && error.message ? error.message : String(error) };
      updateGitControls();
      renderGitGroups([], { unavailable: true });
      dom.gitCount.hidden = true;
      dom.gitRemoteSummary.textContent = "Git status unavailable";
      return null;
    });
  }

  function gitAction(entry, action) {
    if (gitOperationRunning) return;
    var call = action === "stage" ? api.gitStage : api.gitUnstage;
    call(entry.path).then(function (data) {
      if (!data.success) {
        recordOperation((action === "stage" ? "Stage " : "Unstage ") + entry.path, data, false);
        toast(data.stderr || data.error || "Git operation failed", "error", 6000);
      }
      return loadGitStatus();
    });
  }

  function renderGitEntry(entry) {
    var icon = iconFor(entry.path);
    var name = baseName(entry.path);
    var dir = entry.path.slice(0, entry.path.length - name.length).replace(/\/$/, "");
    var status = String(entry.status || "M").toUpperCase().charAt(0);
    var row = document.createElement("div");
    row.className = "git-row s-" + status;
    row.title = entry.path;
    row.innerHTML = '<i class="git-icon ' + icon[0] + " " + icon[1] + '"></i>' +
      '<span class="git-name">' + escapeHtml(name) + "</span>" +
      '<span class="git-dir">' + escapeHtml(dir) + '</span><span class="git-actions"></span>' +
      '<span class="git-state-flags"></span>';
    var actions = row.querySelector(".git-actions");
    function actionButton(action, iconName, label) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "git-act";
      button.title = label;
      button.setAttribute("aria-label", label + " " + entry.path);
      button.innerHTML = '<i class="fa-solid fa-' + iconName + '"></i>';
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        gitAction(entry, action);
      });
      actions.appendChild(button);
    }
    if (entry.hasWorktree || entry.isUntracked) actionButton("stage", "plus", "Stage");
    if (entry.isStaged) actionButton("unstage", "minus", "Unstage");
    var flags = row.querySelector(".git-state-flags");
    function flag(code, label) {
      code = String(code || "M").toUpperCase().charAt(0);
      var node = document.createElement("span");
      node.className = "git-flag " + code;
      node.textContent = code;
      node.title = label + ": " + code;
      flags.appendChild(node);
    }
    if (entry.isStaged) flag(entry.stagedStatus, "Staged");
    if (entry.hasWorktree || entry.isUntracked) flag(entry.isUntracked ? "U" : entry.worktreeStatus, "Working tree");
    row.addEventListener("click", function () { showDiff(entry.path); });
    row.addEventListener("dblclick", function () { openFile(entry.path); });
    return row;
  }

  var GIT_GROUP_RULES = [
    { id: "manuscript", label: "LaTeX / Manuscript", prefixes: ["Notes/", "LaTeX/", "Bibliography/", "Figures/"], exact: ["main.tex"] },
    { id: "numerics", label: "Numerics / Scientific code", prefixes: ["Numerics/", "Scripts/Analysis/", "Scripts/Plots/"], exact: [] },
    { id: "runner", label: "LaTeX Runner", prefixes: ["Scripts/editor/"], exact: ["latex-runner.json", "start-editor.ps1", "start-editor.bat"] },
    { id: "ai", label: "AI / Contracts / Governance", prefixes: ["Docs/AI/", ".agents/", ".agent/", ".claude/", ".codex/", ".gemini/"], exact: ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "MEMORY.md", "HANDOFF.md"] },
    { id: "tooling", label: "Tests / Tooling", prefixes: ["Scripts/", ".github/", "tests/"], exact: ["pyproject.toml", "package.json", "package-lock.json"] },
  ];

  function classifyGitPath(path) {
    var normalized = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    for (var index = 0; index < GIT_GROUP_RULES.length; index += 1) {
      var rule = GIT_GROUP_RULES[index];
      if (rule.exact.indexOf(normalized) !== -1 || rule.prefixes.some(function (prefix) {
        return normalized.indexOf(prefix) === 0;
      })) return rule;
    }
    return { id: "other", label: "Other" };
  }

  function fallbackGitGroups(data) {
    var entries = Object.create(null);
    function record(value, fields) {
      var path = typeof value === "string" ? value : value && value.path;
      if (!path) return;
      var item = entries[path] || { path: path, isStaged: false, hasWorktree: false, isUntracked: false, conflict: false };
      Object.keys(fields || {}).forEach(function (key) {
        if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") item[key] = fields[key];
      });
      entries[path] = item;
    }
    (data.staged || []).forEach(function (item) {
      record(item, { isStaged: true, stagedStatus: item.stagedStatus || item.status || "M",
        worktreeStatus: item.worktreeStatus || ".", oldPath: item.oldPath });
    });
    (data.modified || []).forEach(function (item) {
      record(item, { hasWorktree: true, worktreeStatus: item.worktreeStatus || item.status || "M",
        stagedStatus: item.stagedStatus || ".", oldPath: item.oldPath });
    });
    (data.untracked || []).forEach(function (item) {
      record(item, { hasWorktree: true, isUntracked: true, worktreeStatus: "U" });
    });
    (data.conflicts || []).forEach(function (item) {
      record(item, { hasWorktree: true, conflict: true, worktreeStatus: "C",
        stagedStatus: item.stagedStatus || item.status || "C" });
    });

    var grouped = Object.create(null);
    Object.keys(entries).sort(function (a, b) { return a.localeCompare(b); }).forEach(function (path) {
      var entry = entries[path];
      var rule = classifyGitPath(path);
      if (!grouped[rule.id]) grouped[rule.id] = { id: rule.id, label: rule.label, entries: [] };
      entry.status = entry.conflict ? "C" : (entry.isUntracked ? "U" :
        (entry.worktreeStatus && entry.worktreeStatus !== "." ? entry.worktreeStatus : (entry.stagedStatus || "M")));
      grouped[rule.id].entries.push(entry);
    });
    return GIT_GROUP_RULES.concat([{ id: "other", label: "Other" }]).map(function (rule) {
      return grouped[rule.id];
    }).filter(Boolean);
  }

  function normalizedGitGroups(data) {
    var fallback = fallbackGitGroups(data || {});
    var rawPaths = new Set();
    fallback.forEach(function (group) {
      group.entries.forEach(function (entry) { rawPaths.add(entry.path); });
    });
    var supplied = Array.isArray(data.groups) ? data.groups.filter(function (group) {
      return group && Array.isArray(group.entries) && group.entries.length;
    }) : [];
    var suppliedPaths = new Set();
    supplied.forEach(function (group) {
      group.entries.forEach(function (entry) { if (entry && entry.path) suppliedPaths.add(entry.path); });
    });
    var complete = suppliedPaths.size === rawPaths.size;
    suppliedPaths.forEach(function (path) { if (!rawPaths.has(path)) complete = false; });
    return complete ? supplied : fallback;
  }

  function renderGitGroups(groups, options) {
    options = options || {};
    dom.gitChangeGroups.innerHTML = "";
    if (!groups.length) {
      dom.gitChangeGroups.innerHTML = '<div class="tree-empty">' +
        (options.unavailable ? "Git status is unavailable. Refresh to try again." : "Working tree is clean.") + "</div>";
      return;
    }
    groups.forEach(function (group) {
      var collapsed = state.gitCollapsedGroups.has(group.id);
      var section = document.createElement("section");
      section.className = "git-group" + (collapsed ? "" : " open");
      var head = document.createElement("button");
      head.type = "button";
      head.className = "git-group-head";
      head.setAttribute("aria-expanded", String(!collapsed));
      head.innerHTML = '<i class="group-caret fa-solid fa-chevron-right"></i><span>' +
        escapeHtml(group.label || "Other") + '</span><span class="count">' +
        (group.entries || []).length + "</span>";
      var list = document.createElement("div");
      list.className = "git-group-list";
      (group.entries || []).forEach(function (entry) { list.appendChild(renderGitEntry(entry)); });
      head.addEventListener("click", function () {
        var open = !section.classList.contains("open");
        section.classList.toggle("open", open);
        head.setAttribute("aria-expanded", String(open));
        if (open) state.gitCollapsedGroups.delete(group.id);
        else state.gitCollapsedGroups.add(group.id);
      });
      section.appendChild(head);
      section.appendChild(list);
      dom.gitChangeGroups.appendChild(section);
    });
  }

  /* ---- Commit graph ------------------------------------------------------ */
  var LANE_COLORS = ["#5ac8fa", "#35c98a", "#ffc451", "#b392f0", "#ff9f5a", "#3fd4e8", "#ff6f91"];
  var GRAPH_ROW = 26;
  var GRAPH_LANE = 14;

  function laneColor(lane) {
    return LANE_COLORS[lane % LANE_COLORS.length];
  }

  function renderGitGraph(data) {
    var commits = data.commits || [];
    dom.gitGraphCount.textContent = String(commits.length);
    dom.gitGraph.innerHTML = "";
    if (!commits.length) {
      dom.gitGraph.innerHTML = '<div class="tree-empty" style="padding:4px 6px">No history.</div>';
      return;
    }

    var laneCount = Math.max(1, data.laneCount || 1);
    var gutter = laneCount * GRAPH_LANE + 10;
    var height = commits.length * GRAPH_ROW;
    var rowIndex = {};
    commits.forEach(function (commit, index) { rowIndex[commit.hash] = index; });

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", String(gutter));
    svg.setAttribute("height", String(height));

    function laneX(lane) { return 9 + lane * GRAPH_LANE; }
    function rowY(index) { return index * GRAPH_ROW + GRAPH_ROW / 2; }

    commits.forEach(function (commit, index) {
      (commit.parents || []).forEach(function (parentHash) {
        var parentRow = rowIndex[parentHash];
        if (parentRow === undefined) return;
        var parentLane = commits[parentRow].lane;
        var x1 = laneX(commit.lane);
        var y1 = rowY(index);
        var x2 = laneX(parentLane);
        var y2 = rowY(parentRow);
        var path = document.createElementNS(svgNS, "path");
        var d;
        if (x1 === x2) {
          d = "M" + x1 + "," + y1 + " L" + x2 + "," + y2;
        } else {
          /* Run down the child's lane, then bend into the parent's. */
          var bend = Math.max(y1, y2 - GRAPH_ROW);
          d = "M" + x1 + "," + y1 + " L" + x1 + "," + bend +
              " C" + x1 + "," + (bend + GRAPH_ROW / 2) + " " + x2 + "," + (y2 - GRAPH_ROW / 2) +
              " " + x2 + "," + y2;
        }
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", laneColor(Math.min(commit.lane, parentLane)));
        path.setAttribute("stroke-width", "1.6");
        path.setAttribute("stroke-opacity", "0.75");
        svg.appendChild(path);
      });
    });

    commits.forEach(function (commit, index) {
      var dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", String(laneX(commit.lane)));
      dot.setAttribute("cy", String(rowY(index)));
      dot.setAttribute("r", commit.refs && commit.refs.length ? "4.5" : "3.4");
      dot.setAttribute("fill", commit.refs && commit.refs.length ? laneColor(commit.lane) : "#0a1c31");
      dot.setAttribute("stroke", laneColor(commit.lane));
      dot.setAttribute("stroke-width", "1.8");
      svg.appendChild(dot);
    });

    dom.gitGraph.appendChild(svg);

    var rows = document.createElement("div");
    rows.className = "graph-rows";
    commits.forEach(function (commit) {
      var row = document.createElement("div");
      row.className = "graph-row";
      row.style.paddingLeft = gutter + 4 + "px";
      row.title = commit.short + " — " + commit.message + "\n" + commit.author + " · " + commit.date;
      var refs = (commit.refs || []).map(function (ref) {
        var cls = /HEAD/.test(ref) ? "head" : (/^origin\//.test(ref) ? "remote" : "");
        return '<span class="g-ref ' + cls + '">' + escapeHtml(ref.replace("HEAD -> ", "")) + "</span>";
      }).join("");
      row.innerHTML =
        '<span class="g-sha">' + escapeHtml(commit.short) + "</span>" + refs +
        '<span class="g-msg">' + escapeHtml(commit.message) + "</span>" +
        '<span class="g-date">' + escapeHtml(commit.date) + "</span>";
      row.addEventListener("contextmenu", function (event) {
        event.preventDefault();
        commitMenu(event, commit);
      });
      rows.appendChild(row);
    });
    dom.gitGraph.appendChild(rows);
  }

  function commitMenu(event, commit) {
    showContextMenu(event, [
      {
        label: "Show details", icon: "fa-circle-info",
        action: function () {
          getJson("/api/git/commit-detail?sha=" + encodeURIComponent(commit.hash)).then(function (data) {
            var session = createConsoleSession("Commit " + commit.short, "git show --stat " + commit.short);
            appendConsoleHtml('<span class="c-cmd">$ git show --stat ' + escapeHtml(commit.short) + "</span>\n", session.id);
            appendConsole((data.text || "(no output)") + "\n", session.id);
            finishConsoleSession(session, { exitCode: data.success ? 0 : 1 });
          });
        },
      },
      { label: "Copy full SHA", icon: "fa-copy", action: function () { copyText(commit.hash); } },
      { label: "Copy message", icon: "fa-quote-left", action: function () { copyText(commit.message); } },
    ]);
  }

  /* ====================================================================== */
  /* 10b. Tool runners: user-defined categories                              */
  /* ====================================================================== */

  function runnerIcon(command) {
    var text = String(command || "");
    if (/^\s*(python|py)\b/.test(text)) return ["fa-brands fa-python", "ic-py"];
    if (/^\s*julia\b/.test(text)) return ["fa-solid fa-circle-nodes", "ic-jl"];
    if (/^\s*(pwsh|powershell)\b/.test(text)) return ["fa-solid fa-terminal", "ic-shell"];
    if (/^\s*git\b/.test(text)) return ["fa-solid fa-code-branch", "ic-cfg"];
    if (/latexmk|lualatex|pdflatex|xelatex|biber/.test(text)) return ["fa-solid fa-file-lines", "ic-tex"];
    if (/\.(sh|bat|cmd)\b/.test(text)) return ["fa-solid fa-terminal", "ic-shell"];
    return ["fa-solid fa-play", "ic-default"];
  }

  function loadRunners() {
    return getJson("/api/runners").then(function (data) {
      state.runners = data.success ? { categories: data.categories || [] } : { categories: [] };
      renderRunners();
    });
  }

  function saveRunners() {
    return postJson("/api/runners", state.runners).then(function (data) {
      if (!data.success) { toast(data.error || "Could not save the tool palette", "error"); return; }
      state.runners = { categories: data.categories || [] };
      renderRunners();
    });
  }

  function findRunner(runnerId) {
    for (var c = 0; c < state.runners.categories.length; c += 1) {
      var list = state.runners.categories[c].runners;
      for (var r = 0; r < list.length; r += 1) {
        if (list[r].id === runnerId) return { category: state.runners.categories[c], runner: list[r], index: r };
      }
    }
    return null;
  }

  function renderRunners() {
    dom.runnerGroups.innerHTML = "";
    if (!state.runners.categories.length) {
      dom.runnerGroups.innerHTML = '<div class="tree-empty">No tools yet — use + below.</div>';
      return;
    }

    state.runners.categories.forEach(function (category) {
      var group = document.createElement("div");
      group.className = "runner-group" + (category.collapsed ? " collapsed" : "");
      group.dataset.cat = category.id;

      var head = document.createElement("div");
      head.className = "runner-group-head";
      head.innerHTML =
        '<i class="g-caret fa-solid fa-chevron-down"></i>' +
        '<span class="g-name">' + escapeHtml(category.name) + "</span>" +
        '<span class="count">' + category.runners.length + "</span>" +
        '<button class="g-act" data-act="add" title="Add a tool here"><i class="fa-solid fa-plus"></i></button>' +
        '<button class="g-act" data-act="rename" title="Rename category"><i class="fa-solid fa-pen"></i></button>' +
        '<button class="g-act danger" data-act="delete" title="Delete category"><i class="fa-solid fa-trash"></i></button>';
      head.addEventListener("click", function (event) {
        var action = event.target.closest("[data-act]");
        if (action) {
          event.stopPropagation();
          var kind = action.dataset.act;
          if (kind === "add") openRunnerModal(null, category.id);
          else if (kind === "rename") renameCategory(category);
          else if (kind === "delete") deleteCategory(category);
          return;
        }
        category.collapsed = !category.collapsed;
        group.classList.toggle("collapsed", category.collapsed);
        saveRunnersQuietly();
      });

      var list = document.createElement("div");
      list.className = "runner-list";
      list.dataset.cat = category.id;

      category.runners.forEach(function (runner) {
        list.appendChild(buildRunnerItem(runner, category));
      });

      attachRunnerDropTargets(list, category);
      group.appendChild(head);
      group.appendChild(list);
      dom.runnerGroups.appendChild(group);
    });
  }

  function buildRunnerItem(runner, category) {
    var icon = runnerIcon(runner.command);
    var item = document.createElement("div");
    item.className = "runner-item";
    if (runner.available === false) item.classList.add("unavailable");
    item.draggable = true;
    item.dataset.id = runner.id;
    item.dataset.cat = category.id;
    item.title = runner.command;
    if (runner.diagnostic) item.title += '\n' + runner.diagnostic;
    item.innerHTML =
      '<i class="' + icon[0] + " " + icon[1] + '"></i>' +
      '<span class="r-text"><span class="r-label">' + escapeHtml(runner.label) + "</span>" +
      '<span class="r-cmd">' + escapeHtml(runner.command) + "</span>" +
      (runner.diagnostic ? '<span class="r-diagnostic">' + escapeHtml(runner.diagnostic) + '</span>' : '') +
      "</span>" +
      '<button class="r-act" data-act="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>' +
      '<button class="r-act danger" data-act="delete" title="Delete"><i class="fa-solid fa-trash"></i></button>';

    item.addEventListener("click", function (event) {
      var action = event.target.closest("[data-act]");
      if (action) {
        event.stopPropagation();
        if (action.dataset.act === "edit") openRunnerModal(runner, category.id);
        else deleteRunner(runner);
        return;
      }
      if (runner.available === false) { toast(runner.diagnostic, 'warn'); return; }
      /* The project's own compile runs through the viewer: queue, live preview, SyncTeX. */
      if (runner.kind === "compile") { recompile(); return; }
      item.classList.add("running");
      runCommand(runner.command, runner.label, function () { item.classList.remove("running"); });
    });
    item.addEventListener("dragstart", function (event) {
      state.dragRunner = runner.id;
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      try { event.dataTransfer.setData("text/plain", runner.id); } catch (err) { /* Safari */ }
    });
    item.addEventListener("dragend", function () {
      state.dragRunner = null;
      item.classList.remove("dragging");
      Array.prototype.forEach.call(document.querySelectorAll(".drop-before,.drop-after,.drop-target"), function (el) {
        el.classList.remove("drop-before", "drop-after", "drop-target");
      });
    });
    item.addEventListener("dragover", function (event) {
      if (!state.dragRunner || state.dragRunner === runner.id) return;
      event.preventDefault();
      var rect = item.getBoundingClientRect();
      var after = event.clientY > rect.top + rect.height / 2;
      item.classList.toggle("drop-after", after);
      item.classList.toggle("drop-before", !after);
    });
    item.addEventListener("dragleave", function () {
      item.classList.remove("drop-before", "drop-after");
    });
    item.addEventListener("drop", function (event) {
      if (!state.dragRunner) return;
      event.preventDefault();
      event.stopPropagation();
      var rect = item.getBoundingClientRect();
      var after = event.clientY > rect.top + rect.height / 2;
      moveRunner(state.dragRunner, category.id, runner.id, after);
    });
    return item;
  }

  function attachRunnerDropTargets(list, category) {
    list.addEventListener("dragover", function (event) {
      if (!state.dragRunner) return;
      event.preventDefault();
      list.parentNode.classList.add("drop-target");
    });
    list.addEventListener("dragleave", function () {
      list.parentNode.classList.remove("drop-target");
    });
    list.addEventListener("drop", function (event) {
      if (!state.dragRunner) return;
      event.preventDefault();
      list.parentNode.classList.remove("drop-target");
      moveRunner(state.dragRunner, category.id, null, true);
    });
  }

  function moveRunner(runnerId, targetCategoryId, anchorId, after) {
    var found = findRunner(runnerId);
    if (!found) return;
    found.category.runners.splice(found.index, 1);
    var target = state.runners.categories.filter(function (c) { return c.id === targetCategoryId; })[0];
    if (!target) return;
    var position = target.runners.length;
    if (anchorId) {
      var anchorIndex = target.runners.findIndex(function (r) { return r.id === anchorId; });
      if (anchorIndex !== -1) position = anchorIndex + (after ? 1 : 0);
    }
    target.runners.splice(position, 0, found.runner);
    saveRunners();
  }

  var runnerSaveTimer = 0;
  function saveRunnersQuietly() {
    clearTimeout(runnerSaveTimer);
    runnerSaveTimer = setTimeout(function () {
      postJson("/api/runners", state.runners);
    }, 350);
  }

  function openRunnerModal(runner, categoryId) {
    state.editingRunner = runner ? runner.id : null;
    $("runner-modal-title").innerHTML = runner
      ? '<i class="fa-solid fa-pen"></i> Edit tool'
      : '<i class="fa-solid fa-play"></i> New tool';
    $("runner-label").value = runner ? runner.label : "";
    $("runner-command").value = runner ? runner.command : (dom.customCmd.value.trim() || "");
    var select = $("runner-category");
    select.innerHTML = "";
    state.runners.categories.forEach(function (category) {
      var option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      select.appendChild(option);
    });
    select.value = categoryId || (state.runners.categories[0] || {}).id || "";
    openModal("modal-runner");
    setTimeout(function () { $("runner-label").focus(); }, 40);
  }

  function submitRunnerModal() {
    var label = $("runner-label").value.trim();
    var command = $("runner-command").value.trim();
    var categoryId = $("runner-category").value;
    if (!command) { toast("A command is required", "warn"); return; }
    if (!label) label = command;

    if (state.editingRunner) {
      var found = findRunner(state.editingRunner);
      if (found) {
        found.runner.label = label;
        found.runner.command = command;
        if (found.category.id !== categoryId) {
          found.category.runners.splice(found.index, 1);
          var target = state.runners.categories.filter(function (c) { return c.id === categoryId; })[0];
          if (target) target.runners.push(found.runner);
        }
      }
    } else {
      var category = state.runners.categories.filter(function (c) { return c.id === categoryId; })[0];
      if (!category) { toast("Pick a category first", "warn"); return; }
      category.runners.push({ id: "", label: label, command: command });
    }
    state.editingRunner = null;
    closeModal("modal-runner");
    dom.customCmd.value = "";
    saveRunners().then(function () { toast("Tool saved", "success", 1800); });
  }

  function deleteRunner(runner) {
    confirmDialog("Delete tool", "Remove <strong>" + escapeHtml(runner.label) + "</strong> from the palette?", "Delete")
      .then(function (ok) {
        if (!ok) return;
        var found = findRunner(runner.id);
        if (found) found.category.runners.splice(found.index, 1);
        saveRunners();
      });
  }

  function renameCategory(category) {
    promptDialog("Rename category", "New name for <strong>" + escapeHtml(category.name) + "</strong>:", category.name)
      .then(function (name) {
        if (!name) return;
        category.name = name;
        saveRunners();
      });
  }

  function deleteCategory(category) {
    confirmDialog(
      "Delete category",
      "Delete <strong>" + escapeHtml(category.name) + "</strong> and its " + category.runners.length + " tool(s)?",
      "Delete"
    ).then(function (ok) {
      if (!ok) return;
      state.runners.categories = state.runners.categories.filter(function (c) { return c.id !== category.id; });
      saveRunners();
    });
  }

  function addCategory() {
    promptDialog("New category", "Name the new tool category:", "").then(function (name) {
      if (!name) return;
      state.runners.categories.push({ id: "", name: name, collapsed: false, runners: [] });
      saveRunners();
    });
  }

  /* ====================================================================== */
  /* 10c. AI workspace                                                       */
  /* ====================================================================== */

  function relativeTime(seconds) {
    if (!seconds) return "";
    var delta = Date.now() / 1000 - seconds;
    if (delta < 90) return "just now";
    if (delta < 3600) return Math.round(delta / 60) + " min ago";
    if (delta < 86400) return Math.round(delta / 3600) + " h ago";
    if (delta < 7 * 86400) return Math.round(delta / 86400) + " d ago";
    return new Date(seconds * 1000).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
  }

  function aiEnabled() {
    return !(state.project && state.project.features && state.project.features.aiWorkspace === false);
  }

  function loadAiOverview() {
    if (!aiEnabled()) return Promise.resolve();
    if (dom.aiLive) dom.aiLive.classList.add("refreshing");
    return getJson("/api/ai/overview").then(function (data) {
      if (!data.success) return;
      state.ai = data;
      renderAiOverview();
    }).catch(function () {
      /* The next live tick retries; keep the editor itself responsive. */
    }).then(function () {
      if (dom.aiLive) dom.aiLive.classList.remove("refreshing");
    });
  }

  var AI_STAGE_ORDER = ["thinker", "gate", "editor", "review"];

  function aiRow(kind, title, sub, path, tooltip) {
    var row = document.createElement("div");
    row.className = "ai-row";
    row.title = tooltip || path;
    row.innerHTML =
      '<span class="ai-kind ' + escapeHtml(kind) + '">' + escapeHtml(kind === "GOV" ? "FILE" : kind) + "</span>" +
      '<span class="ai-name">' + escapeHtml(title || path) + "</span>" +
      (sub ? '<span class="ai-sub">' + escapeHtml(sub) + "</span>" : "");
    row.addEventListener("click", function () { openFile(path); });
    return row;
  }

  function openPanel(panelId) {
    var button = document.querySelector('.rail-btn[data-panel="' + panelId + '"]');
    if (button) button.click();
  }

  function setAiBlockExpanded(name, expanded, scroll) {
    var block = document.querySelector('.ai-block[data-block="' + name + '"]');
    if (!block) return;
    block.classList.toggle("collapsed", !expanded);
    var head = block.querySelector(".ai-block-head");
    if (head) head.setAttribute("aria-expanded", String(expanded));
    if (scroll) block.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderAiOverview() {
    var data = state.ai || {};
    if (data.enabled === false) return;
    var counts = data.counts || {};
    dom.aiCount.textContent = String(counts.active || 0);
    dom.aiCount.hidden = !counts.active;
    $("ai-active-count").textContent = String(counts.active || 0);
    $("ai-prompts-count").textContent = String(counts.prompts || 0);
    $("ai-dossiers-count").textContent = String(counts.dossiers || 0);
    $("ai-archive-count").textContent = String(counts.archive || 0);
    $("ai-research-count").textContent = String(counts.research || 0);

    /* Summary tiles ------------------------------------------------------ */
    var openCommentItems = state.comments.filter(function (c) { return (c.status || "open") === "open"; });
    var openComments = openCommentItems.length;
    $("ai-comments-count").textContent = String(openComments);
    var tiles = [
      { value: counts.active || 0, label: "Active contracts", hot: counts.active > 0,
        action: function () { setAiBlockExpanded("active", true, true); } },
      { value: openComments, label: "Open comments", hot: openComments > 0,
        action: function () { setAiBlockExpanded("comments", true, true); } },
      { value: counts.research || 0, label: "Research dossiers", hot: false,
        action: function () { setAiBlockExpanded("research", true, true); } },
    ];
    dom.aiSummary.innerHTML = "";
    tiles.forEach(function (tile) {
      var node = document.createElement("button");
      node.type = "button";
      node.className = "ai-stat" + (tile.hot ? " hot" : "");
      node.innerHTML = "<strong>" + tile.value + "</strong><span>" + escapeHtml(tile.label) + "</span>";
      node.addEventListener("click", tile.action);
      dom.aiSummary.appendChild(node);
    });

    /* Latest handoff ----------------------------------------------------- */
    var handoff = data.handoff;
    dom.aiHandoff.hidden = !handoff;
    if (handoff) {
      dom.aiHandoff.innerHTML =
        '<div class="ai-handoff-top"><span class="ai-handoff-label"><i class="fa-solid fa-flag-checkered"></i> Latest handoff</span>' +
        '<span class="ai-handoff-date">' + escapeHtml(handoff.date || relativeTime(handoff.mtime)) + "</span></div>" +
        '<div class="ai-handoff-title">' + escapeHtml(handoff.title) + "</div>" +
        (handoff.summary ? '<div class="ai-handoff-summary">' + escapeHtml(handoff.summary) + "</div>" : "");
      dom.aiHandoff.title = handoff.path + ":" + handoff.line;
      dom.aiHandoff.onclick = function () { openFile(handoff.path, { line: handoff.line, flash: true }); };
    }

    /* High-frequency actions -------------------------------------------- */
    dom.aiActions.innerHTML = "";
    var agents = (data.governance || []).filter(function (item) { return item.file === "AGENTS.md"; })[0];
    var memory = (data.governance || []).filter(function (item) { return item.file === "MEMORY.md"; })[0];
    var actions = [
      { label: "Agents", icon: "fa-user-gear", title: "Open the repository agent agreement",
        action: function () { if (agents) openFile(agents.path); } },
      { label: "Intent Handoff", icon: "fa-flag-checkered", title: "Open the latest handoff entry",
        action: function () { if (handoff) openFile(handoff.path, { line: handoff.line, flash: true }); else openFile("HANDOFF.md"); } },
      { label: "MEMORY.md", icon: "fa-brain", title: "Open the durable project memory",
        action: function () { openFile(memory ? memory.path : "MEMORY.md"); } },
      { label: "Context Map", icon: "fa-map", title: "Open the repository context map",
        action: function () { openFile(".agents/CONTEXT_MAP.md"); } },
    ];
    actions.forEach(function (item) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "ai-action";
      button.title = item.title;
      button.innerHTML = '<i class="fa-solid ' + item.icon + '"></i><span>' + escapeHtml(item.label) + "</span>";
      button.addEventListener("click", item.action);
      dom.aiActions.appendChild(button);
    });

    /* Open comment details ---------------------------------------------- */
    dom.aiComments.innerHTML = "";
    openCommentItems.forEach(function (comment) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "ai-comment-row";
      var label = comment.selectedText || comment.text || "Open comment";
      button.title = (comment.text || label) + "\n" + comment.file + ":" + comment.startLine;
      button.innerHTML = "<strong>" + escapeHtml(label) + "</strong><span>" +
        escapeHtml(comment.file + ":" + comment.startLine) + "</span>";
      button.addEventListener("click", function () {
        setCommentFilter("open");
        openPanel("panel-review");
        openFile(comment.file, { line: comment.startLine, column: comment.startCol || 1, flash: true });
      });
      dom.aiComments.appendChild(button);
    });
    if (!openCommentItems.length) dom.aiComments.innerHTML = '<div class="tree-empty">No open comments.</div>';

    /* Contract pipeline -------------------------------------------------- */
    dom.aiPipeline.innerHTML = "";
    (data.stages || []).forEach(function (stage) {
      var node = document.createElement("div");
      node.className = "ai-stage" + (stage.count ? " hot" : "");
      node.title = stage.label + ": " + stage.count + " active contract(s)";
      node.innerHTML = "<b>" + stage.count + "</b><span>" + escapeHtml(stage.label) + "</span>";
      dom.aiPipeline.appendChild(node);
    });

    /* Active contracts --------------------------------------------------- */
    function contractCard(contract) {
      var card = document.createElement("div");
      card.className = "ai-card s-" + contract.statusClass;
      var meta = [];
      if (contract.editor) meta.push("<span><b>Editor:</b> " + escapeHtml(contract.editor.slice(0, 46)) + "</span>");
      if (contract.reviewer) meta.push("<span><b>Review:</b> " + escapeHtml(contract.reviewer.slice(0, 46)) + "</span>");
      if (contract.createdBy) meta.push("<span><b>By:</b> " + escapeHtml(contract.createdBy.slice(0, 40)) + "</span>");
      /* Statuses can be a whole sentence; the badge shows the leading clause. */
      var badge = (contract.status || contract.statusClass).split(/[—(;,]/)[0].replace(/`/g, "").trim();
      if (badge.length > 30) badge = badge.slice(0, 29) + "…";
      var stageIndex = AI_STAGE_ORDER.indexOf(contract.phase);
      var steps = AI_STAGE_ORDER.map(function (_key, index) {
        return '<i class="' + (stageIndex > index ? "done" : (stageIndex === index ? "now" : "")) + '"></i>';
      }).join("");
      card.title = contract.path + (contract.status ? "\n\nStatus: " + contract.status : "");
      card.innerHTML =
        '<div class="ai-card-top">' +
          '<span class="ai-status s-' + contract.statusClass + '">' + escapeHtml(badge) + "</span>" +
          '<span class="ai-card-date">' + escapeHtml(contract.created || "") + "</span>" +
        "</div>" +
        '<div class="ai-card-title">' + escapeHtml(contract.title) + "</div>" +
        (meta.length ? '<div class="ai-card-meta">' + meta.join("") + "</div>" : "") +
        '<div class="ai-steps">' + steps + "</div>" +
        '<div class="ai-card-flow"><span class="ai-phase">' + escapeHtml(contract.phaseLabel || "Gate") +
        '</span><span class="ai-next">' + escapeHtml(contract.nextAction || "Open contract") + "</span></div>";
      card.addEventListener("click", function () { openFile(contract.path); });
      return card;
    }

    dom.aiActive.innerHTML = "";
    (data.active || []).forEach(function (contract) { dom.aiActive.appendChild(contractCard(contract)); });
    if (!(data.active || []).length) {
      dom.aiActive.innerHTML = '<div class="tree-empty">No active contracts. Owner comments use the light path in the Review panel.</div>';
    }

    /* Recent activity ---------------------------------------------------- */
    dom.aiActivity.innerHTML = "";
    (data.activity || []).forEach(function (item) {
      dom.aiActivity.appendChild(aiRow(item.kind || "AI", item.title || item.path, relativeTime(item.mtime),
        item.path, item.path + (item.detail ? "\n" + item.detail : "")));
    });
    $("ai-activity-count").textContent = String((data.activity || []).length);

    /* Research dossiers -------------------------------------------------- */
    dom.aiResearch.innerHTML = "";
    (data.research || []).forEach(function (item) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "ai-research-card";
      card.title = item.path;
      card.innerHTML = "<strong>" + escapeHtml(item.title) + "</strong><span>" +
        escapeHtml([item.date, item.files ? item.files + " files" : "", relativeTime(item.mtime)].filter(Boolean).join(" · ")) +
        "</span>";
      card.addEventListener("click", function () { openFile(item.path); });
      dom.aiResearch.appendChild(card);
    });
    if (!(data.research || []).length) dom.aiResearch.innerHTML = '<div class="tree-empty">No research dossiers.</div>';

    /* Prompts, briefs, archive -------------------------------------------- */
    dom.aiPrompts.innerHTML = "";
    (data.prompts || []).forEach(function (item) {
      dom.aiPrompts.appendChild(aiRow("PROMPT", item.title, (item.date || "").slice(5), item.path,
        (item.role ? item.role + "\n" : "") + (item.model ? "Target: " + item.model + "\n" : "") + item.path));
    });
    if (!(data.prompts || []).length) dom.aiPrompts.innerHTML = '<div class="tree-empty">No prompts.</div>';

    dom.aiDossiers.innerHTML = "";
    (data.dossiers || []).forEach(function (item) {
      dom.aiDossiers.appendChild(aiRow(item.kind, item.title, (item.date || "").slice(5), item.path,
        item.kindLabel + " — " + item.path));
    });

    dom.aiArchive.innerHTML = "";
    (data.archive || []).forEach(function (contract) {
      dom.aiArchive.appendChild(aiRow("ARCHIVE", contract.title, contract.created || "", contract.path,
        contract.path + (contract.status ? "\n\n" + contract.status : "")));
    });

    /* Agreements --------------------------------------------------------- */
    dom.aiGovernance.innerHTML = "";
    (data.governance || []).forEach(function (item) {
      var node = document.createElement("button");
      node.type = "button";
      node.className = "ai-gov";
      node.title = item.path + (item.mtime ? "\nChanged " + relativeTime(item.mtime) : "");
      node.innerHTML = "<b>" + escapeHtml(item.file) + "</b><span>" + escapeHtml(item.description || item.path) + "</span>";
      node.addEventListener("click", function () { openFile(item.path); });
      dom.aiGovernance.appendChild(node);
    });
  }

  var workspaceSnapshot = null, nextGitRefresh = 0;

  /* A file changed on disk (an agent, Git, another editor). A clean buffer
     follows the disk; a buffer with unsaved edits raises the conflict bar. */
  function syncOpenDocument(path, diskStamp) {
    var doc = state.docs[path];
    if (!doc || doc.saving || doc.diskStamp === diskStamp) return Promise.resolve();
    if (diskStamp == null) {
      if (!doc.missingNotified) {
        doc.missingNotified = true;
        toast(baseName(path) + " is no longer on disk. Your text is kept; saving writes it again.", "warn", 7000);
      }
      return Promise.resolve();
    }
    doc.missingNotified = false;
    var localVersion = doc.model.getAlternativeVersionId();
    return api.read(path).then(function (disk) {
      if (!disk.success || state.docs[path] !== doc || doc.saving) return;
      if (disk.version === doc.diskVersion) {
        doc.diskStamp = disk.stamp; /* touched, same content */
        return;
      }
      if (disk.content === doc.model.getValue()) {
        /* Both sides already agree, for example after a save from elsewhere. */
        doc.savedVersionId = doc.model.getAlternativeVersionId();
        doc.diskVersion = disk.version; doc.diskStamp = disk.stamp; doc.conflict = false;
        refreshDirty(); renderConflictBar();
        return;
      }
      if (isDirty(path) || doc.model.getAlternativeVersionId() !== localVersion) {
        markConflict(path, "disk");
        return;
      }
      var view = state.active === path ? state.editor.saveViewState() : doc.viewState;
      doc.model.setValue(disk.content);
      doc.savedVersionId = doc.model.getAlternativeVersionId();
      if (state.active === path && view) state.editor.restoreViewState(view);
      doc.diskVersion = disk.version; doc.diskStamp = disk.stamp; doc.conflict = false;
      refreshDirty();
      if (state.active === path) setStatusMessage("reloaded " + baseName(path) + " (changed on disk)", "ok");
    });
  }

  async function refreshWorkspace() {
    if (document.hidden || state.liveBusy) return;
    state.liveBusy = true;
    try {
      var openPaths = allOpenPaths();
      var result = await postJson('/api/workspace/state', {paths: openPaths});
      if (!result.success) throw new Error(result.error || 'Workspace unavailable');
      if (result.session === false) renewSession();
      var wasOffline = state.connectionLost;
      if (wasOffline) {
        state.connectionLost = false;
        toast('Reconnected to the editor server', 'success');
        openPaths.forEach(function (path) { if (state.docs[path]) state.docs[path].saveError = ""; });
        flushAllAutosaves();
        refreshDirty();
      }
      var current = result.state, previous = workspaceSnapshot;
      await Promise.all(openPaths.map(function (path) { return syncOpenDocument(path, result.files[path]); }));
      var tasks = [];
      if (previous) {
        var repositoryChanged = current.tree !== previous.tree || current.source !== previous.source ||
          current.ai !== previous.ai || current.tools !== previous.tools || current.assets !== previous.assets ||
          current.comments !== previous.comments;
        if (repositoryChanged) nextGitRefresh = 0;
        if (current.tree !== previous.tree) tasks.push(loadTree());
        if (current.source !== previous.source) {
          bibCache = null; thumbCache = Object.create(null);
          tasks.push(loadOutline());
        }
        if (current.source !== previous.source || current.aux !== previous.aux)
          document.dispatchEvent(new CustomEvent('faraday:disk-changed'));
        if (current.assets !== previous.assets) {
          thumbCache = Object.create(null);
          document.dispatchEvent(new CustomEvent('faraday:disk-changed'));
        }
        if (current.source !== previous.source || current.assets !== previous.assets)
          tasks.push(loadNumericsWorkspace({quiet: true}));
        if (current.ai !== previous.ai) tasks.push(loadAiOverview());
        if (current.comments !== previous.comments) {
          if (CommentDictation.isActive(dom.commentsList) ||
              (document.activeElement && document.activeElement.closest('.comment-reply-form'))) current.comments = previous.comments;
          else tasks.push(loadComments());
        }
        if (current.pdf !== previous.pdf) {
          /* A build outside the viewer (agent, terminal) also refreshes the PDF. */
          if (state.compiling || result.compiling) current.pdf = previous.pdf;
          else if (current.pdf) tasks.push(loadPdf(true).then(function (doc) {
            if (!doc) current.pdf = previous.pdf;
            return loadLogs();
          }));
        }
      }
      if ($('panel-git').classList.contains('active') && Date.now() >= nextGitRefresh) {
        tasks.push(loadGitStatus({graph: true}));
        nextGitRefresh = Date.now() + 30000;
      }
      await Promise.all(tasks);
      workspaceSnapshot = current;
    } catch (error) {
      if (!state.connectionLost) {
        toast('Lost the connection to the editor server. Your text stays here; reconnecting…', 'warn', 6000);
      }
      state.connectionLost = true;
      refreshDirty();
    } finally { state.liveBusy = false; }
  }

  function startLiveRefresh() {
    clearTimeout(state.liveTimer);
    (function tick() {
      refreshWorkspace().then(function () {
        state.liveTimer = setTimeout(tick, state.connectionLost ? 4000 : 2000);
      });
    })();
    window.addEventListener('focus', function () { refreshWorkspace(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushAllAutosaves();
      else refreshWorkspace();
    });
    window.addEventListener('blur', function () { flushAllAutosaves(); });
  }

  function showDiff(path, supplied, labels) {
    openDrawer("drawer-diff");
    dom.drawerContext.textContent = path;
    labels = labels || { left: "HEAD", right: "Working copy" };
    (supplied ? Promise.resolve(supplied) : api.gitDiff(path)).then(function (data) {
      if (!data.success) { toast("Could not diff " + path, "error"); return; }
      $("diff-empty").hidden = true;
      var title = $("diff-title");
      title.hidden = false;
      title.innerHTML = "<span><b>" + escapeHtml(labels.left) + "</b> (left)</span><span><b>" +
        escapeHtml(labels.right) + "</b> (right)</span><span>" + escapeHtml(path) + "</span>";
      if (!state.diffEditor) {
        state.diffEditor = monaco.editor.createDiffEditor($("monaco-diff"), {
          theme: window.LatexMonarch.THEME_ID,
          automaticLayout: true,
          readOnly: true,
          renderSideBySide: true,
          fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
          fontSize: 12.5,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
        });
      }
      var language = languageFor(path);
      var original = monaco.editor.createModel(data.head_content || "", language);
      var modified = monaco.editor.createModel(data.working_content || "", language);
      var previous = state.diffEditor.getModel();
      state.diffEditor.setModel({ original: original, modified: modified });
      if (previous) {
        if (previous.original) previous.original.dispose();
        if (previous.modified) previous.modified.dispose();
      }
      state.diffPath = path;
    });
  }

  /* ====================================================================== */
  /* 11. Tool runners & console                                              */
  /* ====================================================================== */

  function stopStream() {
    return stopConsoleSession(state.activeConsole);
  }

  /**
   * Stream a command's output into a console session. The session cookie is
   * renewed first: an EventSource cannot recover from a 403 by itself.
   */
  function runStream(url, label, onDone, options) {
    options = options || {};
    var session = createConsoleSession(options.tabLabel || label, label, {
      onDone: onDone, open: options.open, activate: options.activate,
    });
    appendConsole('\n\x1b[35m$ ' + label + "\x1b[0m\n", session.id);
    var finished = false;

    function finish(payload) {
      if (finished) return;
      finished = true;
      if (session.source) session.source.close();
      finishConsoleSession(session, payload || {});
    }

    renewSession().then(function () {
      if (finished || session.status !== "running") return;
      var source = new EventSource(
        url + (url.indexOf("?") === -1 ? "?" : "&") + "job=" + encodeURIComponent(session.id)
      );
      session.source = source;
      source.onmessage = function (event) {
        try {
          var data = JSON.parse(event.data);
          if (data.line !== undefined) appendConsole(data.line, session.id);
        } catch (err) { /* ignore malformed frame */ }
      };
      source.addEventListener("step", function (event) {
        try { if (options.onStep) options.onStep(JSON.parse(event.data)); } catch (err) { /* ignore */ }
      });
      source.addEventListener("pass", function (event) {
        try { if (options.onPass) options.onPass(JSON.parse(event.data)); } catch (err) { /* ignore */ }
      });
      source.addEventListener("done", function (event) {
        var payload = {};
        try { payload = JSON.parse(event.data); } catch (err) { /* ignore */ }
        if (payload.exitCode !== undefined && !payload.busy) {
          appendConsole("\n[exit code " + payload.exitCode + "]\n", session.id);
        }
        finish(payload);
      });
      source.onerror = function () {
        if (!finished) {
          appendConsole("\n[connection interrupted]\n", session.id);
          finish({ interrupted: true, exitCode: 1 });
        }
      };
    }).catch(function (error) {
      appendConsole("\n[connection failed: " + (error.message || error) + "]\n", session.id);
      finish({ interrupted: true, exitCode: 1 });
    });
    return session;
  }

  function runCommand(command, label, onDone) {
    runStream(
      "/api/run/stream?cmd=" + encodeURIComponent(command),
      label ? label + "  —  " + command : command,
      function (result) { loadGitStatus(); loadTree(); if (onDone) onDone(result); },
      { tabLabel: label || command }
    );
  }

  /* ====================================================================== */
  /* 12. PDF, compile, logs & SyncTeX                                        */
  /* ====================================================================== */

  function initPdf() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    var defaultZoom = ((state.settings || {}).viewer || {}).defaultZoom || "page-width";
    state.pdf = new ContinuousPdfViewer({
      container: dom.pdfScroll,
      pagesEl: dom.pdfPages,
      onPageChange: function (page, total) {
        if (document.activeElement !== dom.pdfPageInput) dom.pdfPageInput.value = page;
        dom.pdfPageCount.textContent = total;
        dom.pdfPageInput.max = total;
      },
      onZoomChange: function () { /* select stays on the chosen mode */ },
      onInverseSync: inverseSync,
      onHistoryChange: function (depth) { dom.pdfBack.disabled = depth === 0; },
      onStatus: function (status) {
        /* A failed reload keeps the previous document on screen. */
        state.pdfAvailable = !!status.loaded;
        dom.pdfEmpty.hidden = !!status.loaded;
        if (!status.loaded) dom.pdfPageCount.textContent = "–";
      },
    });
    state.pdf.zoomMode = defaultZoom;
    dom.pdfZoom.value = defaultZoom;
    return loadPdf(false);
  }

  var pdfLoad = null;
  var pdfReloadAgain = false;

  /* Reload the PDF; overlapping requests collapse into one follow-up load. */
  function loadPdf(preservePosition) {
    if (pdfLoad) { pdfReloadAgain = true; return pdfLoad; }
    pdfLoad = api.pdfInfo().catch(function () { return {}; }).then(function (info) {
      if (info && info.exists === false) {
        state.pdfAvailable = false;
        dom.pdfEmpty.hidden = false;
        return null;
      }
      return state.pdf.load("/api/pdf?t=" + Date.now(), { preservePosition: preservePosition }).then(function (doc) {
        if (doc) state.pdfStamp = info ? info.stamp : null;
        return doc;
      });
    });
    function releaseLoad() {
      pdfLoad = null;
      if (pdfReloadAgain) {
        pdfReloadAgain = false;
        loadPdf(true);
      }
    }
    pdfLoad.then(releaseLoad, releaseLoad);
    return pdfLoad;
  }

  function inverseSync(page, x, y, textHit) {
    setStatusMessage("SyncTeX…", "");
    api.inverse(page, x, y, textHit).then(function (data) {
      if (!data.success) {
        toast(data.error || "SyncTeX found no source for that point", "warn", 6000);
        setStatusMessage("SyncTeX: no match", "err");
        return;
      }
      var column = Math.max(1, data.column || 1);
      var exact = data.precision === "word" || data.precision === "context";
      openFile(data.file, {
        line: data.line, column: column, flash: true,
        length: exact && data.length ? data.length : 0,
      }).then(function (ok) {
        if (!ok) return;
        setStatusMessage("SyncTeX → " + data.file + ":" + data.line + ":" + column +
          (exact ? "" : " (line)"), "ok");
        if (data.stale) toast("The PDF is newer than its SyncTeX index. Recompile for exact jumps.", "warn", 6000);
        else if (data.approximate && !exact) toast("Nearest source line (the click was between lines).", "info", 2600);
      });
    }).catch(function (err) {
      toast("SyncTeX request failed: " + (err && err.message ? err.message : err), "error", 6000);
    });
  }

  /* The word under the cursor plus neighbours, to mark it inside the PDF line. */
  function wordTargetAt(model, position) {
    var text = model.getLineContent(position.lineNumber);
    if (/^\s*%/.test(text)) return null;
    var pattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
    var words = [];
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > 0 && text.charAt(match.index - 1) === "\\") continue; /* a macro name */
      words.push({ text: match[0], start: match.index + 1, end: match.index + 1 + match[0].length });
    }
    if (!words.length) return null;
    var column = position.column;
    var index = -1;
    for (var i = 0; i < words.length; i += 1) {
      if (column >= words[i].start && column <= words[i].end) { index = i; break; }
      if (words[i].start > column) { index = i; break; }
    }
    if (index < 0) index = words.length - 1;
    if (words[index].text.length < 2) return null;
    return {
      word: words[index].text,
      before: words.slice(Math.max(0, index - 3), index).map(function (w) { return w.text; }),
      after: words.slice(index + 1, index + 4).map(function (w) { return w.text; }),
    };
  }

  function forwardSync() {
    if (!state.active) return;
    if (!state.pdfAvailable) { toast("Compile the document first", "warn"); return; }
    var position = state.editor.getPosition();
    var target = wordTargetAt(state.editor.getModel(), position);
    api.forward(state.active, position.lineNumber, position.column, state.pdf.currentPage).then(function (data) {
      if (!data.success) {
        toast(data.error || "SyncTeX found no output for that line", "warn");
        return;
      }
      switchView("pdf");
      var rects = data.rects && data.rects.length ? data.rects
        : [{ x: data.x, y: data.y - data.height, width: data.width, height: data.height }];
      state.pdf.highlightRects(data.page, rects);
      if (target && data.line === position.lineNumber) state.pdf.markWord(data.page, target, rects);
      setStatusMessage("SyncTeX → page " + data.page +
        (data.approximate ? " (nearest typeset line " + data.line + ")" : ""), "ok");
      if (data.stale) toast("The PDF is older than your last edits. Recompile for exact positions.", "info", 4000);
    }).catch(function (err) {
      toast("SyncTeX request failed: " + (err && err.message ? err.message : err), "error", 6000);
    });
  }

  function programLabel(program) {
    var name = String(program || "").toLowerCase().replace(/\.exe$/, "");
    if (/latex/.test(name)) return "LaTeX";
    if (name === "biber" || name === "bibtex") return "Bibliography";
    if (/index|glossar/.test(name)) return "Index";
    return name || "Compile";
  }

  function updateCompileUi(label, kind) {
    var busy = state.compiling;
    dom.btnRecompile.classList.toggle("is-busy", busy);
    dom.recompileLabel.textContent = busy ? "Compiling…" : "Recompile";
    dom.btnStopCompile.hidden = !busy;
    dom.compileProgress.hidden = !busy;
    if (label !== undefined) {
      dom.compileStatus.textContent = label;
      dom.compileStatus.className = "chip chip-status" + (kind ? " " + kind : "");
    }
    if (state.compileQueued && busy) {
      dom.compileStatus.title = "Another compile follows to include your newest saves";
    } else {
      dom.compileStatus.title = "Compile status";
    }
  }

  function compileElapsed() {
    return ((Date.now() - state.compileStarted) / 1000).toFixed(0) + " s";
  }

  /**
   * Save, then compile. A request during a running compile queues exactly one
   * follow-up run, so the last save always reaches the PDF.
   */
  function recompile(opts) {
    opts = opts || {};
    if (state.compiling) {
      state.compileQueued = true;
      updateCompileUi(dom.compileStatus.textContent.replace(/ · queued$/, "") + " · queued", "is-busy");
      return;
    }
    var pre = opts.skipSave ? Promise.resolve(true) : saveAll(false);
    pre.then(function (saved) {
      var conflicts = allOpenPaths().filter(function (path) { return state.docs[path] && state.docs[path].conflict; });
      if (conflicts.length) {
        toast("Compiling the disk version of " + baseName(conflicts[0]) + ": resolve its conflict to include your edits.", "warn", 6500);
      } else if (!saved) {
        toast("Some files could not be saved; the PDF shows the saved state.", "warn", 6000);
      }
      if (state.compiling) { state.compileQueued = true; return; }
      startCompile(opts);
    });
  }

  function startCompile(opts) {
    clearTimeout(state.compileRetryTimer);
    state.compileRetryTimer = 0;
    state.compiling = true;
    state.compileQueued = false;
    state.compileStarted = Date.now();
    var progressive = ((state.settings || {}).compiler || {}).progressivePreview !== false;
    var stepText = "Compiling";
    updateCompileUi("Compiling · 0 s", "is-busy");
    clearInterval(state.compileTimer);
    state.compileTimer = setInterval(function () {
      if (!state.compiling) return;
      dom.compileStatus.textContent = stepText + " · " + compileElapsed() + (state.compileQueued ? " · queued" : "");
    }, 1000);
    var session = runStream("/api/compile/stream", "compile", function (result) {
      finishCompile(result || {}, session);
    }, {
      tabLabel: "Compile",
      open: false,
      activate: !state.activeConsole,
      onStep: function (step) {
        stepText = programLabel(step.program);
        dom.compileStatus.textContent = stepText + " · " + compileElapsed();
      },
      onPass: function (pass) {
        appendConsoleHtml('<span class="c-pass">PDF pass ' + pass.pass + " · " + pass.seconds + " s</span>\n", session.id);
        if (progressive) {
          loadPdf(true).then(function (doc) {
            if (doc && state.compiling) setStatusMessage("preview updated after pass " + pass.pass, "ok");
          });
        }
      },
    });
    state.compileSession = session;
  }

  function finishCompile(result, session) {
    clearInterval(state.compileTimer);
    var seconds = ((Date.now() - state.compileStarted) / 1000).toFixed(1);
    if (result.busy) {
      /* Keep Stop available while another browser tab holds the lock. */
      updateCompileUi("Waiting for another compile", "is-queued");
      state.compileRetryTimer = setTimeout(function () {
        state.compileRetryTimer = 0;
        state.compiling = false;
        recompile();
      }, 2000);
      return;
    }
    if (result.interrupted) {
      state.compiling = false;
      updateCompileUi("Stopped", "is-error");
      runQueuedCompile();
      return;
    }
    api.pdfInfo().catch(function () { return {}; }).then(function (info) {
      /* Reload only if the last pass has not been shown already. */
      if (info && info.exists && info.stamp !== state.pdfStamp) return loadPdf(true);
      return null;
    }).then(function () {
      return loadLogs();
    }).then(function () {
      state.compiling = false;
      var errors = state.logs.errors.length;
      var ok = result.exitCode === 0 && !errors && state.pdfAvailable;
      if (ok) {
        updateCompileUi("Compiled · " + seconds + " s", "is-ok");
      } else {
        updateCompileUi(errors ? errors + " error" + (errors === 1 ? "" : "s") : "Failed · " + seconds + " s", "is-error");
        if (errors) switchView("logs");
        else openDrawer("drawer-console");
        if (session) selectConsoleSession(session.id);
        toast(errors ? "Compilation finished with errors. The log view lists them." :
          "Compilation failed. The console shows why.", "error", 6000);
      }
      loadOutline();
      nextGitRefresh = 0;
      runQueuedCompile();
    }).catch(function (error) {
      state.compiling = false;
      updateCompileUi("Preview unavailable", "is-error");
      toast("Could not refresh the compile result: " + (error.message || error), "error", 6000);
      runQueuedCompile();
    });
  }

  function runQueuedCompile() {
    if (!state.compileQueued) { updateCompileUi(); return; }
    state.compileQueued = false;
    setTimeout(function () { recompile(); }, 60);
  }

  function stopCompile() {
    if (state.compileRetryTimer) {
      clearTimeout(state.compileRetryTimer);
      state.compileRetryTimer = 0;
      state.compileQueued = false;
      state.compiling = false;
      updateCompileUi("Stopped", "is-error");
      return;
    }
    if (!state.compiling || !state.compileSession) return;
    state.compileQueued = false;
    stopConsoleSession(state.compileSession.id);
  }

  function loadLogs() {
    return api.compileLog().then(function (data) {
      if (!data.success) return;
      state.logs = {
        errors: data.errors || [],
        warnings: data.warnings || [],
        bad_boxes: data.bad_boxes || [],
        raw: data.raw || "",
      };
      var counts = [state.logs.errors.length, state.logs.warnings.length, state.logs.bad_boxes.length];
      dom.badgeErrors.textContent = counts[0];
      dom.badgeWarnings.textContent = counts[1];
      dom.badgeBoxes.textContent = counts[2];
      $("pill-errors").textContent = counts[0];
      $("pill-warnings").textContent = counts[1];
      $("pill-boxes").textContent = counts[2];
      dom.badgeErrors.parentNode.classList.toggle("hot", counts[0] > 0);
      dom.badgeWarnings.parentNode.classList.toggle("hot", counts[1] > 0);
      dom.badgeBoxes.parentNode.classList.toggle("hot", counts[2] > 0);
      dom.rawLog.textContent = state.logs.raw;
      renderIssues();
    }).catch(function () { /* logs are informative only */ });
  }

  function setLogFilter(filter) {
    state.logFilter = filter;
    Array.prototype.forEach.call(document.querySelectorAll(".pill"), function (pill) {
      pill.classList.toggle("active", pill.dataset.filter === filter);
    });
    renderIssues();
  }

  function renderIssues() {
    var list = [];
    var filter = state.logFilter;
    if (filter === "all" || filter === "errors") {
      state.logs.errors.forEach(function (item) {
        list.push({
          kind: "error", icon: "fa-circle-exclamation", title: item.message,
          detail: item.context || "", file: item.file, line: item.line,
        });
      });
    }
    if (filter === "all" || filter === "warnings") {
      state.logs.warnings.forEach(function (item) {
        list.push({
          kind: "warning", icon: "fa-triangle-exclamation",
          title: item.pkg ? item.pkg + ": " + item.message : item.message,
          detail: "", file: item.file || "", line: item.line || 0,
        });
      });
    }
    if (filter === "all" || filter === "boxes") {
      state.logs.bad_boxes.forEach(function (item) {
        list.push({
          kind: "badbox", icon: "fa-ruler-combined",
          title: item.type + " (" + item.dim + ")",
          detail: "paragraph at lines " + item.start_line + "–" + item.end_line,
          file: item.file || "", line: item.start_line,
        });
      });
    }

    dom.issuesList.innerHTML = "";
    if (!list.length) {
      dom.issuesList.innerHTML =
        '<div class="issues-empty"><i class="fa-solid fa-circle-check"></i>' +
        "<span>Nothing to report for this filter.</span></div>";
      return;
    }
    list.slice(0, 400).forEach(function (issue) {
      var card = document.createElement("div");
      card.className = "issue " + issue.kind;
      card.innerHTML =
        '<div class="issue-head"><i class="fa-solid ' + issue.icon + '"></i><span>' +
          escapeHtml(issue.title) + "</span></div>" +
        (issue.detail ? '<div class="issue-detail">' + escapeHtml(issue.detail) + "</div>" : "") +
        (issue.file || issue.line
          ? '<span class="issue-loc">' + escapeHtml(issue.file || "") +
            (issue.line ? ":" + issue.line : "") + "</span>"
          : "");
      if (issue.file && issue.line) {
        card.addEventListener("click", function () {
          openFile(issue.file, { line: issue.line, flash: true });
        });
      }
      dom.issuesList.appendChild(card);
    });
  }

  function switchView(view) {
    if (state.workspaceMode !== "latex") setWorkspaceMode("latex", { keepFile: true });
    var pdf = view === "pdf";
    $("view-pdf").classList.toggle("active", pdf);
    $("view-logs").classList.toggle("active", !pdf);
    dom.viewNumerics.classList.remove("active");
    $("btn-view-pdf").classList.toggle("active", pdf);
    $("btn-view-logs").classList.toggle("active", !pdf);
    dom.pdfTools.style.display = pdf ? "" : "none";
  }

  /* ====================================================================== */
  /* 13. Markdown preview                                                    */
  /* ====================================================================== */

  function renderMarkdown(source) {
    var blocks = [];
    var text = source.replace(/```[\w+-]*\n([\s\S]*?)```/g, function (match, code) {
      blocks.push("<pre><code>" + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });

    var inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, function (match, code) {
      inlineCodes.push("<code>" + escapeHtml(code) + "</code>");
      return "\u0000C" + (inlineCodes.length - 1) + "\u0000";
    });

    text = escapeHtml(text);

    function inline(value) {
      return value
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    }

    var lines = text.split("\n");
    var html = [];
    var listStack = [];
    var inTable = false;

    function closeLists() {
      while (listStack.length) html.push(listStack.pop() === "ul" ? "</ul>" : "</ol>");
    }
    function closeTable() {
      if (inTable) { html.push("</tbody></table>"); inTable = false; }
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var trimmed = line.trim();

      if (!trimmed) { closeLists(); closeTable(); continue; }

      var heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        closeLists(); closeTable();
        html.push("<h" + heading[1].length + ">" + inline(heading[2]) + "</h" + heading[1].length + ">");
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        closeLists(); closeTable();
        html.push("<hr>");
        continue;
      }
      if (/^&gt;\s?/.test(trimmed)) {
        closeLists(); closeTable();
        html.push("<blockquote>" + inline(trimmed.replace(/^&gt;\s?/, "")) + "</blockquote>");
        continue;
      }
      if (/^\|(.+)\|$/.test(trimmed)) {
        var cells = trimmed.slice(1, -1).split("|").map(function (c) { return c.trim(); });
        if (/^[\s|:-]+$/.test(trimmed)) continue;
        if (!inTable) {
          closeLists();
          html.push("<table><thead><tr>" + cells.map(function (c) {
            return "<th>" + inline(c) + "</th>";
          }).join("") + "</tr></thead><tbody>");
          inTable = true;
        } else {
          html.push("<tr>" + cells.map(function (c) {
            return "<td>" + inline(c) + "</td>";
          }).join("") + "</tr>");
        }
        continue;
      }
      var unordered = /^[-*+]\s+(.*)$/.exec(trimmed);
      var ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
      if (unordered || ordered) {
        closeTable();
        var wanted = unordered ? "ul" : "ol";
        if (!listStack.length || listStack[listStack.length - 1] !== wanted) {
          closeLists();
          listStack.push(wanted);
          html.push("<" + wanted + ">");
        }
        html.push("<li>" + inline((unordered || ordered)[1]) + "</li>");
        continue;
      }
      if (/^\u0000B\d+\u0000$/.test(trimmed)) {
        closeLists(); closeTable();
        html.push(trimmed);
        continue;
      }
      closeTable();
      if (listStack.length) html.push("<li>" + inline(trimmed) + "</li>");
      else html.push("<p>" + inline(trimmed) + "</p>");
    }
    closeLists();
    closeTable();

    var out = html.join("\n");
    out = out.replace(/\u0000C(\d+)\u0000/g, function (m, index) { return inlineCodes[Number(index)]; });
    out = out.replace(/\u0000B(\d+)\u0000/g, function (m, index) { return blocks[Number(index)]; });
    return out;
  }

  function renderMarkdownPreview() {
    if (!state.active || !state.docs[state.active]) return;
    dom.mdPreview.innerHTML = renderMarkdown(state.docs[state.active].model.getValue());
  }

  /* ---- Split editor: a second view onto the same document ---------------- */
  function toggleSplitEditor(force) {
    var on = force === undefined ? !state.splitEditor : force;
    if (on && !state.splitEditor) {
      state.splitEditor = monaco.editor.create(dom.monacoSplit, {
        model: state.editor.getModel(),
        theme: window.LatexMonarch.THEME_ID,
        automaticLayout: true,
        fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
        fontSize: state.editor.getOption(monaco.editor.EditorOption.fontSize),
        lineHeight: 22,
        wordWrap: "on",
        minimap: { enabled: false },
        scrollBeyondLastLine: true,
        padding: { top: 12, bottom: 60 },
        glyphMargin: true,
      });
      window.BlueMarkup.attach(monaco, state.splitEditor, blueMarkupOptions());
    } else if (!on && state.splitEditor) {
      /* Detach the shared model first so disposing the view never disposes it. */
      state.splitEditor.setModel(null);
      state.splitEditor.dispose();
      state.splitEditor = null;
    }
    dom.monacoSplit.hidden = !on;
    dom.btnSplit.classList.toggle("active", on);
    if (state.editor) state.editor.layout();
    if (state.splitEditor) state.splitEditor.layout();
  }

  function syncSplitModel() {
    if (state.splitEditor) state.splitEditor.setModel(state.editor.getModel());
  }

  function toggleMarkdownPreview(force) {
    state.mdPreview = force === undefined ? !state.mdPreview : force;
    dom.mdPreview.hidden = !state.mdPreview;
    dom.btnMdPreview.classList.toggle("active", state.mdPreview);
    if (state.mdPreview) renderMarkdownPreview();
    if (state.editor) state.editor.layout();
  }

  /* ====================================================================== */
  /* 14. Settings, drawer, shortcuts, boot                                   */
  /* ====================================================================== */

  function loadSettings() {
    return api.settings().then(function (data) {
      state.settings = data.success ? data.settings : {};
      applySettings();
    });
  }

  function applySettings() {
    var settings = state.settings || {};
    var editorCfg = settings.editor || {};
    if (state.editor) {
      state.editor.updateOptions({
        fontSize: editorCfg.fontSize || 14,
        tabSize: editorCfg.tabSize || 2,
        wordWrap: editorCfg.wordWrap || "on",
        minimap: { enabled: !!editorCfg.minimap },
      });
      dom.btnWrap.classList.toggle("active", (editorCfg.wordWrap || "on") === "on");
    }
    var viewerCfg = settings.viewer || {};
    if (viewerCfg.defaultZoom) {
      dom.pdfZoom.value = viewerCfg.defaultZoom;
      if (state.pdf) state.pdf.setZoom(viewerCfg.defaultZoom);
    }
    /* Autosave may just have been switched on: pick up pending edits. */
    allOpenPaths().forEach(scheduleAutosave);
    refreshDirty();
  }

  function fillSettingsForm() {
    var settings = state.settings || {};
    var compiler = settings.compiler || {};
    var editorCfg = settings.editor || {};
    $("cfg-autosave").checked = editorCfg.autosave !== false;
    var delay = String(editorCfg.autosaveDelay || 1200);
    var delaySelect = $("cfg-autosave-delay");
    if (!Array.prototype.some.call(delaySelect.options, function (option) { return option.value === delay; })) {
      var custom = document.createElement("option");
      custom.value = delay;
      custom.textContent = (Number(delay) / 1000).toFixed(1) + " s";
      delaySelect.appendChild(custom);
    }
    delaySelect.value = delay;
    $("cfg-engine").value = compiler.engine || "lualatex";
    $("cfg-command").value = compiler.command || (state.project && state.project.compileCommand) || "";
    $("cfg-progressive").checked = compiler.progressivePreview !== false;
    $("cfg-auto-compile").checked = !!compiler.autoCompileOnSave;
    $("cfg-font-size").value = editorCfg.fontSize || 14;
    $("cfg-tab-size").value = editorCfg.tabSize || 2;
    $("cfg-word-wrap").checked = (editorCfg.wordWrap || "on") === "on";
    $("cfg-minimap").checked = !!editorCfg.minimap;
    $("cfg-zoom").value = (settings.viewer || {}).defaultZoom || "page-width";
    var info = state.project || {};
    var rows = [
      ["Name", info.name], ["Folder", info.root], ["Main file", info.main],
      ["PDF", info.pdf], ["Engine", info.engine],
      ["Configuration", info.configFile || "none (defaults)"], ["Runner data", info.dataDir],
      ["Version", (info.app || "LaTeX Runner") + " " + (info.version || "")],
    ];
    $("project-info").innerHTML = rows.map(function (row) {
      return "<dt>" + escapeHtml(row[0]) + "</dt><dd>" + escapeHtml(row[1] || "–") + "</dd>";
    }).join("");
  }

  function saveSettingsForm() {
    var settings = JSON.parse(JSON.stringify(state.settings || {}));
    settings.compiler = settings.compiler || {};
    settings.editor = settings.editor || {};
    settings.viewer = settings.viewer || {};
    settings.editor.autosave = $("cfg-autosave").checked;
    settings.editor.autosaveDelay = Number($("cfg-autosave-delay").value) || 1200;
    settings.compiler.engine = $("cfg-engine").value;
    settings.compiler.command = $("cfg-command").value.trim();
    settings.compiler.progressivePreview = $("cfg-progressive").checked;
    settings.compiler.autoCompileOnSave = $("cfg-auto-compile").checked;
    settings.editor.fontSize = Number($("cfg-font-size").value) || 14;
    settings.editor.tabSize = Number($("cfg-tab-size").value) || 2;
    settings.editor.wordWrap = $("cfg-word-wrap").checked ? "on" : "off";
    settings.editor.minimap = $("cfg-minimap").checked;
    settings.viewer.defaultZoom = $("cfg-zoom").value;

    api.saveSettings(settings).then(function (data) {
      if (!data.success) { toast(data.error || "Could not save settings", "error"); return; }
      state.settings = data.settings;
      applySettings();
      closeModal("modal-settings");
      toast("Settings saved", "success");
    });
  }

  function openDrawer(tabId) {
    if (state.workspaceMode === "numerics" && (!tabId || tabId === "drawer-console")) {
      syncConsoleHome();
      closeDrawer();
      return;
    }
    dom.drawer.classList.remove("collapsed");
    dom.btnToggleDrawer.classList.add("active");
    if (tabId) selectDrawerTab(tabId);
    if (state.editor) state.editor.layout();
  }
  function closeDrawer() {
    dom.drawer.classList.add("collapsed");
    dom.btnToggleDrawer.classList.remove("active");
    if (state.editor) state.editor.layout();
  }
  function toggleDrawer() {
    if (dom.drawer.classList.contains("collapsed")) openDrawer(state.workspaceMode === "numerics" ? "drawer-diff" : null);
    else closeDrawer();
  }
  function selectDrawerTab(tabId) {
    if (state.workspaceMode === "numerics" && tabId === "drawer-console") {
      syncConsoleHome();
      closeDrawer();
      return;
    }
    Array.prototype.forEach.call(document.querySelectorAll(".drawer-tab"), function (tab) {
      tab.classList.toggle("active", tab.dataset.tab === tabId);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".drawer-panel"), function (panel) {
      panel.classList.toggle("active", panel.id === tabId);
    });
    if (tabId === "drawer-diff" && state.diffEditor) state.diffEditor.layout();
  }

  function initLayout() {
    Split(["#pane-sidebar", "#pane-editor", "#pane-viewer"], {
      sizes: [23, 42, 35],
      minSize: [260, 320, 300],
      gutterSize: 5,
      snapOffset: 0,
      onDrag: function () { if (state.editor) state.editor.layout(); },
      onDragEnd: function () {
        if (state.editor) state.editor.layout();
        if (state.pdf) state.pdf.setZoom(state.pdf.zoomMode);
      },
    });

    /* Explorer / outline splitter inside the sidebar. */
    var stackDragging = false;
    var savedSplit = null;
    try { savedSplit = localStorage.getItem("faraday.sidebarSplit"); } catch (err) { /* private mode */ }
    if (savedSplit) dom.stackExplorer.style.flex = "0 0 " + savedSplit + "px";

    dom.stackSplit.addEventListener("mousedown", function (event) {
      stackDragging = true;
      event.preventDefault();
      document.body.style.cursor = "row-resize";
    });
    window.addEventListener("mousemove", function (event) {
      if (!stackDragging) return;
      var stack = dom.stackSplit.parentNode.getBoundingClientRect();
      var height = Math.min(Math.max(event.clientY - stack.top, 90), stack.height - 110);
      dom.stackExplorer.style.flex = "0 0 " + Math.round(height) + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!stackDragging) return;
      stackDragging = false;
      document.body.style.cursor = "";
      try {
        localStorage.setItem("faraday.sidebarSplit", String(dom.stackExplorer.getBoundingClientRect().height));
      } catch (err) { /* private mode */ }
    });

    var dragging = false;
    try {
      var savedDrawerHeight = localStorage.getItem("faraday.drawerHeight");
      if (savedDrawerHeight) dom.drawer.style.setProperty("--drawer-height", savedDrawerHeight + "px");
    } catch (err) { /* private mode */ }
    dom.drawerResize.addEventListener("mousedown", function (event) {
      dragging = true;
      event.preventDefault();
      document.body.style.cursor = "row-resize";
    });
    window.addEventListener("mousemove", function (event) {
      if (!dragging) return;
      var height = Math.min(Math.max(window.innerHeight - event.clientY, 90), window.innerHeight - 220);
      dom.drawer.style.setProperty("--drawer-height", height + "px");
      if (state.editor) state.editor.layout();
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      if (state.diffEditor) state.diffEditor.layout();
      try {
        localStorage.setItem("faraday.drawerHeight", String(dom.drawer.getBoundingClientRect().height));
      } catch (err) { /* private mode */ }
    });
  }

  function initEvents() {
    window.addEventListener('calculation-map:source', function (event) {
      var ref = event.detail;
      if (!ref || typeof ref.path !== 'string' || !ref.path.startsWith('Notes/')) return;
      document.querySelector('.rail-btn[data-panel="panel-workspace"]').click();
      openFile(ref.path, { line: ref.line || 1, flash: true });
    });
    /* Rail / panels */
    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn"), function (button) {
      button.addEventListener("click", function () {
        if (button.dataset.panel !== "panel-review") CommentDictation.cancel(dom.commentsList);
        Array.prototype.forEach.call(document.querySelectorAll(".rail-btn"), function (other) {
          other.classList.remove("active");
        });
        Array.prototype.forEach.call(document.querySelectorAll(".panel"), function (panel) {
          panel.classList.remove("active");
        });
        button.classList.add("active");
        $(button.dataset.panel).classList.add("active");
        window.CalculationMap.setVisible(button.dataset.panel === "panel-calculation-map");
      });
    });
    dom.branchBadge.addEventListener("click", function () {
      document.querySelector('.rail-btn[data-panel="panel-git"]').click();
    });

    /* Explorer */
    dom.fileFilter.addEventListener("input", renderTree);
    $("btn-refresh-files").addEventListener("click", function () {
      Promise.all([loadTree(), loadNumericsWorkspace({ quiet: true })]).then(function () {
        toast("Workspace refreshed", "info", 1600);
      });
    });
    $("btn-new-file").addEventListener("click", function () { createEntry("", false); });
    $("btn-new-folder").addEventListener("click", function () { createEntry("", true); });
    dom.btnToggleFullRepo.addEventListener("click", toggleFullRepository);
    Array.prototype.forEach.call(document.querySelectorAll("[data-workspace-mode]"), function (button) {
      button.addEventListener("click", function () { setWorkspaceMode(button.dataset.workspaceMode); });
    });
    /* Outline */
    dom.outlineFilter.addEventListener("input", renderOutline);
    $("btn-refresh-outline").addEventListener("click", function () {
      var refresh = state.workspaceMode === "numerics" ? loadNumericsWorkspace() : loadOutline();
      refresh.then(function () { toast(state.workspaceMode === "numerics" ? "Pipelines refreshed" : "Outline rebuilt", "info", 1600); });
    });

    /* Comments */
    CommentDictation.attach($("comment-text"));
    $("comments-filter").addEventListener("click", function (event) {
      var button = event.target.closest("[data-filter]");
      if (button) setCommentFilter(button.dataset.filter);
    });
    $("btn-conflict-compare").addEventListener("click", compareConflict);
    $("btn-conflict-theirs").addEventListener("click", function () { resolveConflict(false); });
    $("btn-conflict-mine").addEventListener("click", function () { resolveConflict(true); });
    $("btn-submit-comment").addEventListener("click", submitComment);
    $("btn-add-comment").addEventListener("click", startComment);
    $("btn-mark-blue").addEventListener("click", function () {
      if (!state.blueMarkup || !state.active) return;
      state.blueMarkup.markSelection();
      state.editor.focus();
    });

    /* Git */
    $("btn-git-refresh").addEventListener("click", loadGitStatus);
    $("btn-git-commit").addEventListener("click", function () {
      publishGit(true);
    });
    $("btn-git-pull").addEventListener("click", function () {
      api.gitPull().then(function (data) {
        recordOperation("Git pull", data, true);
        toast(data.success ? "Pull complete" : (data.stderr || "Pull failed"), data.success ? "success" : "error", 5000);
        loadGitStatus();
        loadTree();
      });
    });
    $("btn-git-push").addEventListener("click", function () {
      publishGit(false);
    });
    $("btn-git-stage-all").addEventListener("click", function () {
      api.gitStageAll().then(function (data) {
        if (!data.success) {
          recordOperation("Stage all", data, false);
          toast(data.stderr || "Stage all failed", "error", 6000);
        } else {
          toast("All changes staged", "success", 1800);
        }
        loadGitStatus();
      });
    });
    $("btn-git-unstage-all").addEventListener("click", function () {
      api.gitUnstageAll().then(function (data) {
        if (!data.success) {
          recordOperation("Unstage all", data, false);
          toast(data.stderr || "Unstage all failed", "error", 6000);
        } else {
          toast("All changes unstaged", "success", 1800);
        }
        loadGitStatus();
      });
    });

    /* AI workspace */
    $("btn-refresh-ai").addEventListener("click", function () {
      loadAiOverview().then(function () { toast("AI workspace rescanned", "info", 1600); });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".ai-block-head"), function (head) {
      head.setAttribute("aria-expanded", String(!head.parentNode.classList.contains("collapsed")));
      head.addEventListener("click", function () {
        var collapsed = head.parentNode.classList.toggle("collapsed");
        head.setAttribute("aria-expanded", String(!collapsed));
      });
    });
    /* Outline search toggle */
    $("btn-outline-search").addEventListener("click", function () {
      var show = dom.outlineSearchRow.hidden;
      dom.outlineSearchRow.hidden = !show;
      $("btn-outline-search").classList.toggle("active", show);
      if (show) dom.outlineFilter.focus();
      else { dom.outlineFilter.value = ""; renderOutline(); }
    });

    /* Top bar */
    $("btn-save").addEventListener("click", saveActive);
    $("btn-sync-forward").addEventListener("click", forwardSync);
    dom.btnToggleDrawer.addEventListener("click", toggleDrawer);
    $("btn-settings").addEventListener("click", function () {
      fillSettingsForm();
      openModal("modal-settings");
    });
    $("btn-save-settings").addEventListener("click", saveSettingsForm);

    /* Editor subbar */
    dom.btnMdPreview.addEventListener("click", function () { toggleMarkdownPreview(); });
    dom.btnSplit.addEventListener("click", function () { toggleSplitEditor(); });
    dom.btnWrap.addEventListener("click", function () {
      var on = !dom.btnWrap.classList.contains("active");
      dom.btnWrap.classList.toggle("active", on);
      state.editor.updateOptions({ wordWrap: on ? "on" : "off" });
    });

    /* Viewer */
    dom.btnRecompile.addEventListener("click", function () { recompile(); });
    dom.btnStopCompile.addEventListener("click", stopCompile);
    dom.btnRunActive.addEventListener("click", runActiveNumerics);
    dom.btnStopNumerics.addEventListener("click", stopStream);
    dom.btnRefreshArtifacts.addEventListener("click", function () {
      loadNumericsWorkspace({ refreshArtifacts: true }).then(function () { toast("Figures and measurements refreshed", "info", 1600); });
    });
    dom.btnOpenArtifact.addEventListener("click", function () {
      if (state.numericsResultMode === "measurements" && state.selectedMeasurement) openFile(state.selectedMeasurement);
      else if (state.selectedArtifact) window.open("/api/numerics/figure?label=" + encodeURIComponent(state.selectedArtifact), "_blank");
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-result-mode]"), function (button) {
      button.addEventListener("click", function () { setNumericsResultMode(button.dataset.resultMode); });
    });
    $("btn-empty-compile").addEventListener("click", function () { recompile(); });
    $("btn-view-pdf").addEventListener("click", function () { switchView("pdf"); });
    $("btn-view-logs").addEventListener("click", function () { switchView("logs"); loadLogs(); });
    $("btn-back-to-pdf").addEventListener("click", function () { switchView("pdf"); });
    $("btn-raw-log").addEventListener("click", function () {
      var showRaw = dom.rawLog.hidden;
      dom.rawLog.hidden = !showRaw;
      dom.issuesList.hidden = showRaw;
      $("btn-raw-log").classList.toggle("active", showRaw);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".pill"), function (pill) {
      pill.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll(".pill"), function (other) {
          other.classList.remove("active");
        });
        pill.classList.add("active");
        state.logFilter = pill.dataset.filter;
        renderIssues();
      });
    });

    dom.pdfBack.addEventListener("click", function () { state.pdf.back(); });
    $("pdf-prev").addEventListener("click", function () {
      state.pdf.scrollToPage(state.pdf.currentPage - 1, { smooth: true });
    });
    $("pdf-next").addEventListener("click", function () {
      state.pdf.scrollToPage(state.pdf.currentPage + 1, { smooth: true });
    });
    dom.pdfPageInput.addEventListener("change", function () {
      state.pdf.scrollToPage(Number(dom.pdfPageInput.value) || 1, { smooth: true });
    });
    dom.pdfZoom.addEventListener("change", function () { state.pdf.setZoom(dom.pdfZoom.value); });
    $("pdf-zoom-in").addEventListener("click", function () {
      state.pdf.setZoom(Math.min(6, state.pdf.scale / window.PDF_CSS_UNITS * 1.2));
      dom.pdfZoom.value = "";
    });
    $("pdf-zoom-out").addEventListener("click", function () {
      state.pdf.setZoom(Math.max(0.25, state.pdf.scale / window.PDF_CSS_UNITS / 1.2));
      dom.pdfZoom.value = "";
    });
    $("pdf-open-external").addEventListener("click", function () {
      window.open("/api/pdf?t=" + Date.now(), "_blank");
    });

    /* Drawer */
    Array.prototype.forEach.call(document.querySelectorAll(".drawer-tab"), function (tab) {
      tab.addEventListener("click", function () { selectDrawerTab(tab.dataset.tab); });
    });
    $("btn-stop-console").addEventListener("click", stopStream);
    $("btn-clear-console").addEventListener("click", clearActiveConsole);
    dom.btnNumericsStop.addEventListener("click", stopStream);
    dom.btnNumericsClear.addEventListener("click", clearActiveConsole);
    $("btn-close-drawer").addEventListener("click", closeDrawer);

    /* Modals */
    Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (button) {
      button.addEventListener("click", function () { closeModal(button.dataset.close); });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".modal"), function (modal) {
      modal.addEventListener("mousedown", function (event) {
        if (event.target === modal) closeModal(modal.id);
      });
    });

    document.addEventListener("click", hideContextMenu);
    window.addEventListener("blur", hideContextMenu);
    window.addEventListener("resize", hideContextMenu);

    /* Global shortcuts (outside Monaco) */
    window.addEventListener("keydown", function (event) {
      var ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key === "s" && !event.altKey) { event.preventDefault(); saveActive(); }
      else if (ctrl && event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); saveAll(true); }
      else if (ctrl && event.key === "Enter") { event.preventDefault(); primaryAction(); }
      else if (ctrl && event.key === "`") { event.preventDefault(); toggleDrawer(); }
      else if (ctrl && event.key === "p" && !event.shiftKey) {
        event.preventDefault();
        document.querySelector('.rail-btn[data-panel="panel-workspace"]').click();
        dom.fileFilter.focus();
        dom.fileFilter.select();
      } else if (event.altKey && event.key === "ArrowLeft") {
        if (state.pdf && state.pdf.history.length) { event.preventDefault(); state.pdf.back(); }
      } else if (event.key === "Escape") {
        CommentDictation.cancel();
        hideContextMenu();
        Array.prototype.forEach.call(document.querySelectorAll(".modal.open"), function (modal) {
          closeModal(modal.id);
        });
      }
    });

    window.addEventListener("beforeunload", function (event) {
      rememberSession();
      if (dirtyPaths().length) {
        event.preventDefault();
        event.returnValue = "";
      }
    });

    /* Live Markdown preview */
    var previewTimer = 0;
    document.addEventListener("faraday:model-changed", function () {
      if (!state.mdPreview) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(renderMarkdownPreview, 180);
    });
  }

  /* ====================================================================== */
  /* Boot                                                                    */
  /* ====================================================================== */

  function cacheDom() {
    dom = {
      toasts: $("toasts"),
      contextMenu: $("context-menu"),
      monacoHost: $("monaco-host"),
      tabbar: $("editor-tabs"),
      breadcrumb: $("breadcrumb"),
      fileTree: $("file-tree"),
      fileFilter: $("file-filter"),
      workspaceModeSwitch: $("workspace-mode-switch"),
      workspaceFilesTitle: $("workspace-files-title"),
      workspaceOutlineTitle: $("workspace-outline-title"),
      btnToggleFullRepo: $("btn-toggle-full-repo"),
      btnNewFile: $("btn-new-file"),
      btnNewFolder: $("btn-new-folder"),
      outlineList: $("outline-list"),
      outlineFilter: $("outline-filter"),
      commentsList: $("comments-list"),
      commentsCount: $("comments-count"),
      conflictBar: $("conflict-bar"),
      gitChangeGroups: $("git-change-groups"),
      gitGraph: $("git-graph"),
      gitGraphCount: $("git-graph-count"),
      gitCount: $("git-count"),
      gitRemoteSummary: $("git-remote-summary"),
      runnerGroups: $("runner-groups"),
      customCmd: $("custom-cmd"),
      outlineSearchRow: $("outline-search-row"),
      stackSplit: $("stack-split"),
      stackExplorer: $("stack-explorer"),
      stackOutline: $("stack-outline"),
      aiCount: $("ai-count"),
      aiSummary: $("ai-summary"),
      aiHandoff: $("ai-handoff"),
      aiActions: $("ai-actions"),
      aiComments: $("ai-open-comments"),
      aiPipeline: $("ai-pipeline"),
      aiResearch: $("ai-research"),
      aiLive: $("ai-live"),
      aiPrompts: $("ai-prompts"),
      aiActive: $("ai-active"),
      aiActivity: $("ai-activity"),
      aiArchive: $("ai-archive"),
      aiDossiers: $("ai-dossiers"),
      aiGovernance: $("ai-governance"),
      currentBranch: $("current-branch"),
      branchBadge: $("branch-badge"),
      dirtyChip: $("dirty-chip"),
      dirtyCount: $("dirty-count"),
      statusPosition: $("status-position"),
      statusLanguage: $("status-language"),
      statusFileState: $("status-file-state"),
      statusMessage: $("status-message"),
      mdPreview: $("md-preview"),
      monacoSplit: $("monaco-split"),
      btnMdPreview: $("btn-md-preview"),
      btnSplit: $("btn-split-editor"),
      btnWrap: $("btn-wrap-toggle"),
      btnRecompile: $("btn-recompile"),
      recompileLabel: $("recompile-label"),
      btnStopCompile: $("btn-stop-compile"),
      btnSyncForward: $("btn-sync-forward"),
      latexViewerHead: $("latex-viewer-head"),
      numericsViewerHead: $("numerics-viewer-head"),
      numericsActions: $("numerics-actions"),
      numericsStatus: $("numerics-status"),
      numericsContext: $("numerics-context"),
      btnRunActive: $("btn-run-active"),
      btnStopNumerics: $("btn-stop-numerics"),
      btnRefreshArtifacts: $("btn-refresh-artifacts"),
      viewPdf: $("view-pdf"),
      viewLogs: $("view-logs"),
      viewNumerics: $("view-numerics"),
      artifactTitle: $("artifact-title"),
      artifactPath: $("artifact-path"),
      artifactImage: $("artifact-image"),
      artifactPdf: $("artifact-pdf"),
      artifactEmpty: $("artifact-empty"),
      artifactFilmstrip: $("artifact-filmstrip"),
      measurementTableWrap: $("measurement-table-wrap"),
      measurementMeta: $("measurement-meta"),
      measurementTable: $("measurement-table"),
      resultFigureCount: $("result-figure-count"),
      resultDataCount: $("result-data-count"),
      btnOpenArtifact: $("btn-open-artifact"),
      compileProgress: $("compile-progress"),
      btnToggleDrawer: $("btn-toggle-drawer"),
      saveIndicator: $("save-indicator"),
      saveIndicatorText: $("save-indicator-text"),
      compileStatus: $("compile-status"),
      badgeErrors: $("badge-errors"),
      badgeWarnings: $("badge-warnings"),
      badgeBoxes: $("badge-boxes"),
      issuesList: $("issues-list"),
      rawLog: $("raw-log"),
      pdfScroll: $("pdf-scroll"),
      pdfPages: $("pdf-pages"),
      pdfPageInput: $("pdf-page-input"),
      pdfPageCount: $("pdf-page-count"),
      pdfZoom: $("pdf-zoom"),
      pdfEmpty: $("pdf-empty"),
      pdfTools: $("pdf-tools"),
      pdfBack: $("pdf-back"),
      drawer: $("drawer"),
      drawerResize: $("drawer-resize"),
      drawerContext: $("drawer-context"),
      drawerConsoleHome: $("drawer-console-home"),
      numericsConsoleHome: $("numerics-console-home"),
      numericsConsoleContext: $("numerics-console-context"),
      consoleTabs: $("console-tabs"),
      consoleSessions: $("console-sessions"),
      consoleEmpty: $("console-empty"),
      btnStopConsole: $("btn-stop-console"),
      btnNumericsStop: $("btn-numerics-stop"),
      btnNumericsClear: $("btn-numerics-clear"),
      boot: $("boot-overlay"),
    };
  }

  function chooseEntryFile() {
    var preferred = (state.project && state.project.entryFiles) || ["main.tex"];
    for (var i = 0; i < preferred.length; i += 1) {
      if (state.treeIndex.indexOf(preferred[i]) !== -1) return preferred[i];
    }
    return state.treeIndex.filter(function (p) { return /\.tex$/.test(p); })[0] || null;
  }

  function sessionKey() {
    return "latex-runner.session:" + ((state.project || {}).root || location.origin);
  }

  function rememberSession() {
    if (!state.project || state.restoringSession) return;
    saveWorkspaceTabs();
    try {
      localStorage.setItem(sessionKey(), JSON.stringify({
        workspaceMode: state.workspaceMode,
        workspaces: state.workspaceTabs,
      }));
    } catch (error) { /* Browser storage is optional. Unsaved text stays in the editor. */ }
  }

  async function restoreSession() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(sessionKey())); } catch (error) { /* optional */ }
    state.restoringSession = true;
    try {
      var stored = saved && saved.workspaces ? saved.workspaces : null;
      if (!stored && saved && Array.isArray(saved.paths)) {
        stored = { latex: { order: [], active: null }, numerics: { order: [], active: null } };
        saved.paths.forEach(function (path) { stored[modeForPath(path)].order.push(path); });
        if (saved.active) stored[modeForPath(saved.active)].active = saved.active;
      }
      stored = stored || { latex: { order: [], active: null }, numerics: { order: [], active: null } };
      for (var mode of ["latex", "numerics"]) {
        setWorkspaceMode(mode, { keepFile: true });
        var workspace = stored[mode] || { order: [], active: null };
        var paths = Array.isArray(workspace.order) ? workspace.order.slice(0, 30) : [];
        for (var path of paths) {
          if (modeForPath(path) === mode && state.treeIndex.indexOf(path) !== -1 && !BINARY_EXT.test(path))
            await openFile(path, { focus: false });
        }
        if (workspace.active && state.docs[workspace.active]) activate(workspace.active, { focus: false });
        saveWorkspaceTabs(mode);
      }
      setWorkspaceMode("latex", { keepFile: true });
      if (!state.workspaceTabs.latex.order.length) {
        var entry = chooseEntryFile();
        if (entry) await openFile(entry, { focus: false });
      }
    } finally { state.restoringSession = false; }
    setWorkspaceMode(saved && saved.workspaceMode === "numerics" ? "numerics" : "latex", { keepFile: false });
    rememberSession();
  }

  function loadProject() {
    return api.project().then(function (data) {
      if (!data.success) throw new Error(data.error || "Project configuration unavailable");
      state.project = data;
      document.title = data.name + " · LaTeX Runner";
      $("project-chip").textContent = data.name;
      $("project-chip").title = data.root;
      $("rail-ai").hidden = !data.features.aiWorkspace;
      $("rail-calculation-map").hidden = !data.features.calculationMap;
      dom.workspaceModeSwitch.hidden = !data.features.numericsWorkspace;
      if (data.features.applications) {
        // Application repositories can contain private documents. Keep
        // publication in a reviewed external Git workflow.
        $("btn-git-push").hidden = true;
        $("btn-git-commit").hidden = true;
        $("git-commit-msg").hidden = true;
      }
    });
  }

  function boot() {
    cacheDom();
    initLayout();
    initEvents();
    window.FaradayStatistics.init({
      openSource: function (item) { return openFile(item.file, { line: item.line, flash: true }); },
      openPage: function (page) {
        if (state.pdf) { switchView("pdf"); state.pdf.scrollToPage(page, { smooth: true }); }
      },
      getOverrides: function () {
        var overrides = {};
        dirtyPaths().filter(function (path) { return /\.tex$/i.test(path); }).forEach(function (path) {
          overrides[path] = state.docs[path].model.getValue();
        });
        return overrides;
      }
    });

    Promise.all([bootMonaco(), loadProject()]).then(function () {
      /* Mirror Monaco content changes onto a DOM event for the preview. */
      state.editor.onDidChangeModelContent(function () {
        document.dispatchEvent(new CustomEvent("faraday:model-changed"));
      });

      /* A large dirty worktree can make a fully live `git status` noticeably
         slower than the rest of the workspace bootstrap.  Start it now, but
         do not keep the boot overlay in front of an otherwise usable editor. */
      loadGitStatus();
      return Promise.all([
        loadSettings(), loadTree(), loadOutline(), loadComments(),
        loadAiOverview(), loadNumericsWorkspace({ quiet: true }),
      ]);
    }).then(function () {
      return restoreSession();
    }).then(function () {
      return initPdf();
    }).then(function () {
      return loadLogs();
    }).then(function () {
      startLiveRefresh();
      dom.boot.classList.add("hidden");
      if (location.hash === '#calculation-map' && state.project.features.calculationMap) document.querySelector('[data-panel="panel-calculation-map"]').click();
      setTimeout(function () { dom.boot.style.display = "none"; }, 320);
    }).catch(function (err) {
      console.error(err);
      dom.boot.classList.add("hidden");
      toast("Startup problem: " + (err && err.message ? err.message : err), "error", 8000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
