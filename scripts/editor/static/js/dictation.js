/* Browser speech input for review text. No audio is stored by the editor. */
(function () {
  "use strict";

  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var active = null;
  var controls = new WeakMap();
  var languageKey = "faraday-dictation-language";
  var fallback = "Alternativ: ins Textfeld klicken und Windows + H drücken.";

  function language() {
    try { return localStorage.getItem(languageKey) === "en-GB" ? "en-GB" : "de-DE"; }
    catch (_) { return "de-DE"; }
  }

  function join(left, right) {
    if (!left || !right) return left + right;
    return left + (/\s$/.test(left) || /^[\s.,!?;:)}\]]/.test(right) ? "" : " ") + right;
  }

  function message(ui, text, error) {
    ui.status.textContent = text;
    ui.status.classList.toggle("dictation-error", !!error);
  }

  function update(session, stopping) {
    session.ui.button.innerHTML = '<i class="fa-solid fa-stop" aria-hidden="true"></i> ' +
      (stopping ? "Wird beendet…" : "Diktat stoppen");
    session.ui.button.disabled = !!stopping;
  }

  function complete(session, text, error) {
    if (active !== session) return;
    active = null; // Ignore queued results from a closed or replaced session.
    clearTimeout(session.timer);
    session.field.readOnly = session.wasReadOnly;
    session.ui.select.disabled = false;
    session.ui.button.disabled = false;
    session.ui.button.classList.remove("is-listening");
    session.ui.button.setAttribute("aria-pressed", "false");
    session.ui.button.innerHTML = '<i class="fa-solid fa-microphone" aria-hidden="true"></i> Diktieren';
    message(session.ui, text || "Diktat beendet. Text prüfen und bei Bedarf bearbeiten.", error);
    session.resolve();
  }

  function cancel(container) {
    var session = active;
    if (!session || (container && !container.contains(session.field))) return;
    complete(session);
    try { session.recognition.abort(); } catch (_) { /* Already ended. */ }
  }

  function finish(field) {
    var session = active;
    if (!session || session.field !== field) return Promise.resolve();
    if (session.stopping) return session.done;
    session.stopping = true;
    update(session, true);
    message(session.ui, "Letzte Wörter werden übernommen…");
    // Some engines fail to emit end after stop. Keep the visible draft usable.
    clearTimeout(session.timer);
    session.timer = setTimeout(function () {
      if (active !== session) return;
      complete(session, "Zeitüberschreitung. Der sichtbare Text bleibt erhalten, bitte prüfen.", true);
      try { session.recognition.abort(); } catch (_) { /* Already ended. */ }
    }, 4000);
    try { session.recognition.stop(); }
    catch (_) { cancel(); }
    return session.done;
  }

  function start(field, ui) {
    if (field.disabled || field.readOnly) return;
    cancel();
    var recognition;
    try { recognition = new Recognition(); }
    catch (_) {
      message(ui, "Spracherkennung konnte nicht starten. " + fallback, true);
      return;
    }
    var session = {
      field: field, ui: ui, recognition: recognition,
      before: field.value.slice(0, field.selectionStart),
      after: field.value.slice(field.selectionEnd),
      wasReadOnly: field.readOnly, stopping: false, timer: null,
    };
    session.done = new Promise(function (resolve) { session.resolve = resolve; });
    active = session;
    field.readOnly = true; // Stable insertion range while interim hypotheses change.
    ui.select.disabled = true;
    ui.button.classList.add("is-listening");
    ui.button.setAttribute("aria-pressed", "true");
    update(session, false);
    message(ui, "Mikrofon wird gestartet. Gegebenenfalls Zugriff im Browser erlauben.");
    recognition.lang = ui.select.value;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = function () {
      if (active !== session || session.stopping) return;
      clearTimeout(session.timer);
      message(ui, "Mikrofon an · Zum Bearbeiten Diktat stoppen.");
    };
    recognition.onresult = function (event) {
      if (active !== session) return;
      if (!field.isConnected) { cancel(); return; }
      var transcript = "";
      // The event carries the complete result list for this session. Rebuild
      // it so interim revisions and repeated final events cannot duplicate text.
      for (var i = 0; i < event.results.length; i++) {
        transcript = join(transcript, event.results[i][0].transcript.trim());
      }
      if (!transcript) return; // Silence must not erase selected existing text.
      var prefix = join(session.before, transcript);
      field.value = join(prefix, session.after);
      field.setSelectionRange(prefix.length, prefix.length);
      field.scrollTop = field.scrollHeight;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    recognition.onerror = function (event) {
      if (active !== session) return;
      var errors = {
        "not-allowed": "Mikrofonzugriff blockiert. Mikrofon in den Website-Einstellungen erlauben und erneut starten.",
        "service-not-allowed": "Der Browser erlaubt den Sprachdienst nicht. Editor in Chrome öffnen oder Windows + H verwenden.",
        "audio-capture": "Kein Mikrofon verfügbar. Anschluss und Windows-Mikrofoneinstellungen prüfen.",
        "network": "Sprachdienst nicht erreichbar. Internetverbindung prüfen oder Windows + H verwenden.",
        "no-speech": "Keine Sprache erkannt. Mikrofon prüfen und Diktat erneut starten.",
        "language-not-supported": "Diese Sprache wird vom Sprachdienst nicht unterstützt. Andere Sprache wählen.",
        "aborted": "Diktat unterbrochen. Der sichtbare Text bleibt erhalten.",
      };
      complete(session, errors[event.error] || "Spracherkennung fehlgeschlagen. " + fallback, true);
      try { recognition.abort(); } catch (_) { /* Already ended. */ }
    };
    recognition.onend = function () {
      complete(session, session.stopping ? null : "Mikrofon aus. Für weitere Sätze erneut auf Diktieren klicken.");
    };
    session.timer = setTimeout(function () {
      if (active !== session) return;
      complete(session, "Mikrofonstart hat nicht geantwortet. Browser-Berechtigung prüfen. " + fallback, true);
      try { recognition.abort(); } catch (_) { /* Already ended. */ }
    }, 20000);
    try { recognition.start(); }
    catch (_) {
      complete(session, "Spracherkennung konnte nicht starten. " + fallback, true);
      try { recognition.abort(); } catch (_) { /* Not started. */ }
    }
  }

  function attach(field) {
    if (controls.has(field)) return;
    var toolbar = document.createElement("div");
    toolbar.className = "dictation-controls";
    toolbar.innerHTML = '<div class="dictation-actions">' +
      '<button type="button" class="dictation-toggle" aria-pressed="false">' +
      '<i class="fa-solid fa-microphone" aria-hidden="true"></i> Diktieren</button>' +
      '<select class="mini-select" aria-label="Diktiersprache">' +
      '<option value="de-DE">Deutsch</option><option value="en-GB">English</option></select></div>' +
      '<div class="dictation-status" role="status" aria-live="polite"></div>' +
      '<div class="dictation-note">Spracherkennung ggf. über den Online-Dienst des Browsers. ' +
      'Der Editor speichert nur Text.</div>';
    field.insertAdjacentElement("afterend", toolbar);
    var ui = {
      button: toolbar.querySelector("button"), select: toolbar.querySelector("select"),
      status: toolbar.querySelector(".dictation-status"),
    };
    controls.set(field, ui);
    ui.select.value = language();
    ui.select.addEventListener("change", function () {
      try { localStorage.setItem(languageKey, ui.select.value); } catch (_) { /* Optional preference. */ }
    });
    if (!Recognition || !window.isSecureContext) {
      ui.button.disabled = true;
      ui.select.disabled = true;
      message(ui, !window.isSecureContext ?
        "Diktieren benötigt localhost oder HTTPS. " + fallback :
        "Hier ist keine Browser-Spracherkennung verfügbar. In Chrome öffnen. " + fallback);
      return;
    }
    message(ui, "Am Cursor diktieren, stoppen, Text prüfen.");
    ui.button.addEventListener("click", function () {
      if (active && active.field === field) finish(field);
      else start(field, ui);
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) cancel();
  });
  window.addEventListener("pagehide", function () { cancel(); });
  window.CommentDictation = {
    attach: attach, finish: finish, cancel: cancel,
    isActive: function (container) { return !!active && container.contains(active.field); },
  };
}());
