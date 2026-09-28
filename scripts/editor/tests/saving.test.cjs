const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function controller() {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');
  const context = { window: {}, document: { readyState: 'loading', addEventListener() {} },
    setTimeout() { return 1; }, clearTimeout() {}, clearInterval() {}, console, Set, Promise };
  vm.createContext(context);
  vm.runInContext(source.replace('  if (document.readyState === "loading")', `
    refreshDirty = function () {};
    renderConflictBar = function () {};
    renderSaveIndicatorSoon = function () {};
    setStatusMessage = function () {};
    onAfterSave = function () {};
    updateCompileUi = function () {};
    renderConsoleTabs = function () {};
    window.testController = { state: state, api: api, saveDocument: saveDocument, saveAll: saveAll,
      finishCompile: finishCompile, stopCompile: stopCompile, finishConsoleSession: finishConsoleSession };
    if (document.readyState === "loading")`), context);
  return context.window.testController;
}

function documentModel(c) {
  let text = 'first', version = 1;
  const doc = { model: { getValue: () => text, getAlternativeVersionId: () => version },
    savedVersionId: 0, diskVersion: 'disk-0' };
  c.state.docs['chapter.tex'] = doc;
  c.state.order = ['chapter.tex'];
  return { doc, edit(value) { text = value; version++; } };
}

test('save before compile waits for edits made during an in-flight autosave', async () => {
  const c = controller(), model = documentModel(c), writes = [];
  let completeFirst;
  c.api.write = (file, content, allowProtected, expected) => {
    writes.push({ content, expected });
    if (writes.length === 1) return new Promise(resolve => { completeFirst = resolve; });
    return Promise.resolve({ success: true, version: 'disk-2', stamp: 'stamp-2' });
  };
  const autosave = c.saveDocument('chapter.tex');
  model.edit('latest text');
  const saveBeforeCompile = c.saveAll(false);
  completeFirst({ success: true, version: 'disk-1', stamp: 'stamp-1' });
  await autosave;
  assert.equal(await saveBeforeCompile, true);
  assert.deepEqual(writes, [{ content: 'first', expected: 'disk-0' }, { content: 'latest text', expected: 'disk-1' }]);
  assert.equal(model.doc.savedVersionId, 2);
});

test('save all reports an unresolved conflict even when another file saves', async () => {
  const c = controller();
  documentModel(c);
  c.state.docs['conflict.tex'] = { conflict: true, model: { getAlternativeVersionId: () => 2 }, savedVersionId: 1 };
  c.state.order.push('conflict.tex');
  c.api.write = () => Promise.resolve({ success: true, version: 'saved', stamp: 'saved' });
  assert.equal(await c.saveAll(false), false);
  assert.equal(c.state.docs['conflict.tex'].conflict, true);
});

test('a rejected version check leaves local edits dirty and pauses autosave', async () => {
  const c = controller(), model = documentModel(c);
  c.state.active = 'chapter.tex';
  c.api.write = () => Promise.resolve({ conflict: true, success: false });
  assert.equal(await c.saveDocument('chapter.tex'), false);
  assert.equal(model.doc.savedVersionId, 0);
  assert.equal(model.doc.conflict, true);
});

test('a compile waiting for another tab remains cancellable', () => {
  const c = controller();
  c.state.compiling = true;
  c.state.compileQueued = true;
  c.finishCompile({ busy: true }, null);
  assert.equal(c.state.compiling, true);
  assert.equal(c.state.compileRetryTimer, 1);
  c.stopCompile();
  assert.equal(c.state.compileRetryTimer, 0);
  assert.equal(c.state.compiling, false);
  assert.equal(c.state.compileQueued, false);
});

test('a process exit racing with Stop is reported as interrupted to the compiler', () => {
  const c = controller();
  let result, calls = 0;
  const session = { stopRequested: true, onDone(payload) { result = payload; calls++; } };
  c.finishConsoleSession(session, { exitCode: 1 });
  c.finishConsoleSession(session, { interrupted: true, exitCode: 130 });
  assert.equal(result.interrupted, true);
  assert.equal(session.status, 'interrupted');
  assert.equal(calls, 1);
});
