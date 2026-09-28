/* Run with: node --test Scripts/editor/tests/dictation.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/js/dictation.js'), 'utf8');

// A small DOM/recognizer harness: tests drive browser events, never a microphone.
function element() {
  const classes = new Set();
  return {
    value: '', selectionStart: 0, selectionEnd: 0, readOnly: false,
    disabled: false, isConnected: true, listeners: {}, attributes: {},
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    dispatchEvent(event) { this.listeners[event.type]?.(event); },
    setAttribute(name, value) { this.attributes[name] = value; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    insertAdjacentElement(_, toolbar) { this.toolbar = toolbar; },
    contains(field) { return field === this; },
  };
}

function setup(options = {}) {
  const instances = [], timers = new Map(), stored = new Map();
  let timerId = 0;
  class Recognition {
    constructor() { instances.push(this); }
    start() { if (options.startThrows) throw Error('start failed'); }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    result(...texts) {
      this.onresult({ results: texts.map(([transcript, isFinal = false]) =>
        Object.assign([{ transcript }], { isFinal })) });
    }
  }
  const document = element();
  document.createElement = () => {
    const toolbar = element();
    const children = { button: element(), select: element(), '.dictation-status': element() };
    toolbar.querySelector = selector => children[selector];
    return toolbar;
  };
  const window = Object.assign(element(), { isSecureContext: options.secure !== false });
  if (options.support !== false) window[options.prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition'] = Recognition;
  vm.runInNewContext(source, {
    window, document, Event: class { constructor(type) { this.type = type; } },
    localStorage: {
      getItem: key => { if (options.storageThrows) throw Error('blocked'); return stored.get(key); },
      setItem: (key, value) => stored.set(key, value),
    },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  function field(text = '', start = text.length, end = start) {
    const result = Object.assign(element(), { value: text, selectionStart: start, selectionEnd: end });
    window.CommentDictation.attach(result);
    result.button = result.toolbar.querySelector('button');
    result.select = result.toolbar.querySelector('select');
    result.status = result.toolbar.querySelector('.dictation-status');
    result.click = () => result.button.listeners.click();
    return result;
  }
  return { api: window.CommentDictation, field, instances, timers, document, window };
}

test('starts only on click, defaults to German, and supports prefixed Chrome API', () => {
  const h = setup({ prefixed: true, storageThrows: true });
  const f = h.field();
  assert.equal(h.instances.length, 0);
  f.click();
  const r = h.instances[0];
  assert.equal(r.lang, 'de-DE');
  assert.equal(r.continuous, true);
  assert.equal(r.interimResults, true);
  assert.equal(f.readOnly, true);
  assert.equal(f.button.attributes['aria-pressed'], 'true');
  r.onstart();
  assert.match(f.status.textContent, /Mikrofon an/);
});

test('revises interim words without duplication, preserves surrounding text and punctuation', () => {
  const h = setup(), f = h.field('Vorher danach.', 6);
  f.click();
  const r = h.instances[0];
  r.result(['ein']);
  r.result(['ein Satz', true]);
  r.result(['ein Satz', true], [', noch etwas', true]);
  r.result(['ein Satz', true], [', noch etwas', true]);
  assert.equal(f.value, 'Vorher ein Satz, noch etwas danach.');
  r.onend();
  assert.equal(f.readOnly, false);
  assert.equal(f.button.attributes['aria-pressed'], 'false');
});

test('silence preserves selected text; speech replaces only the selection', () => {
  const h = setup(), f = h.field('Links alt rechts', 6, 9);
  f.click();
  const r = h.instances[0];
  r.result(['']);
  assert.equal(f.value, 'Links alt rechts');
  r.result(['neu', true]);
  assert.equal(f.value, 'Links neu rechts');
});

test('finish waits for the final result before a caller can submit', async () => {
  const h = setup(), f = h.field();
  f.click();
  const r = h.instances[0];
  r.result(['Vorläu']);
  let saved;
  const finished = h.api.finish(f).then(() => { saved = f.value; });
  assert.equal(r.stopped, true);
  assert.equal(f.button.disabled, true);
  await Promise.resolve();
  assert.equal(saved, undefined);
  r.result(['Vollständiger Satz.', true]);
  r.onend();
  await finished;
  assert.equal(saved, 'Vollständiger Satz.');
});

test('stop timeout retains visible text and ignores late results', async () => {
  const h = setup(), f = h.field();
  f.click();
  const r = h.instances[0];
  r.result(['Entwurf']);
  const finished = h.api.finish(f);
  [...h.timers.values()].find(t => t.ms === 4000).fn();
  await finished;
  r.result(['Zu spät']);
  assert.equal(f.value, 'Entwurf');
  assert.equal(r.aborted, true);
  assert.equal(f.readOnly, false);
  assert.match(f.status.textContent, /Zeitüberschreitung/);
});

test('closing or switching fields aborts and isolates old sessions', () => {
  const h = setup(), a = h.field(), b = h.field('Antwort');
  a.click();
  const old = h.instances[0];
  old.result(['Kommentar']);
  b.click();
  assert.equal(old.aborted, true);
  old.result(['Veraltet']);
  old.onend();
  assert.equal(a.value, 'Kommentar');
  assert.equal(h.api.isActive(b), true);
  h.api.cancel(b);
  assert.equal(h.instances[1].aborted, true);
  assert.equal(h.api.isActive(b), false);
});

test('permission, network and microphone errors preserve the draft and allow retry', () => {
  for (const error of ['not-allowed', 'network', 'audio-capture', 'no-speech', 'service-not-allowed']) {
    const h = setup(), f = h.field('Bleibt');
    f.click();
    const r = h.instances[0];
    r.onerror({ error });
    const status = f.status.textContent;
    r.onend();
    assert.equal(f.status.textContent, status);
    assert.equal(f.value, 'Bleibt');
    assert.equal(f.readOnly, false);
    assert.equal(f.button.disabled, false);
    assert.equal(f.status.classList.contains('dictation-error'), true);
    f.click();
    assert.equal(h.instances.length, 2);
  }
});

test('tab hiding and page exit abort the microphone', () => {
  const h = setup(), f = h.field();
  f.click();
  h.document.hidden = true;
  h.document.listeners.visibilitychange();
  assert.equal(h.instances[0].aborted, true);
  f.click();
  h.window.listeners.pagehide();
  assert.equal(h.instances[1].aborted, true);
});

test('unsupported browsers and insecure origins expose fallback without recording', () => {
  for (const options of [{ support: false }, { secure: false }]) {
    const h = setup(options), f = h.field('Text');
    assert.equal(f.button.disabled, true);
    assert.match(f.status.textContent, /Windows \+ H/);
    assert.equal(f.readOnly, false);
    assert.equal(h.instances.length, 0);
  }
});

test('remembers English selection for new controls', () => {
  const h = setup(), f = h.field();
  f.select.value = 'en-GB';
  f.select.listeners.change();
  const next = h.field();
  next.click();
  assert.equal(h.instances[0].lang, 'en-GB');
});

test('start failure and permission timeout release the input', () => {
  const h = setup({ startThrows: true }), f = h.field('Text');
  f.click();
  assert.equal(f.readOnly, false);
  assert.equal(h.api.isActive(f), false);
  const timed = setup(), tf = timed.field();
  tf.click();
  [...timed.timers.values()].find(t => t.ms === 20000).fn();
  assert.equal(timed.instances[0].aborted, true);
  assert.equal(tf.readOnly, false);
});

test('manual correction survives a second dictation and detached fields stop capture', () => {
  const h = setup(), f = h.field();
  f.click();
  h.instances[0].result(['Falsch', true]);
  h.instances[0].onend();
  f.value = 'Korrigiert.';
  f.setSelectionRange(11, 11);
  f.click();
  h.instances[1].result(['Weiter.', true]);
  assert.equal(f.value, 'Korrigiert. Weiter.');
  f.isConnected = false;
  h.instances[1].result(['Nicht einfügen']);
  assert.equal(h.instances[1].aborted, true);
});
