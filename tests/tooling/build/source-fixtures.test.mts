import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  sourceSection,
  sourceDeclaration,
  sourceIndex,
  sourceEventListener,
  compactCss,
} from '../../support/source-fixtures.mts';

test('source sections use declaration identity across whitespace, wrapping, comments and quote formatting', () => {
  for (const source of [
    "const zh={label:'ready'};\nfunction renderCall(){return zh.label;}\nasync function finish(){}",
    'const zh = {\n  label: "ready",\n};\n// declaration comment\nfunction renderCall() {\n  return zh.label;\n}\nasync function finish() {\n}\n',
  ]) {
    const context: vm.Context = {};
    vm.createContext(context);
    vm.runInContext(
      stripTypeScriptTypes(sourceSection(source, 'const zh={', 'async function finish(){')),
      context,
    );
    assert.equal(context.renderCall(), 'ready');
    assert.match(sourceDeclaration(source, 'function renderCall(){'), /^function renderCall/);
    assert.ok(sourceIndex(source, 'async function finish(){') > 0);
  }
});
test('source sections never silently select a missing or ambiguous declaration', () => {
  assert.throws(() => sourceSection('const a=1;', 'const absent=', 'const a='), /exactly one/);
  assert.throws(() => sourceIndex('const a=1;', 'arbitrary source text'), /Unsupported/);
  assert.throws(
    () =>
      sourceIndex(
        'document.addEventListener("keydown",()=>{});document.addEventListener("keydown",()=>{});',
        "document.addEventListener('keydown'",
      ),
    /exactly one/,
  );
  assert.equal(
    sourceDeclaration(
      'document.addEventListener(\n"keydown",\n()=>{},\n);',
      "document.addEventListener('keydown'",
    ),
    'document.addEventListener(\n"keydown",\n()=>{},\n);',
  );
});
test('CSS assertion views normalize formatting without removing selectors or declarations', () => {
  const source = '.card {\n display: flex;\n gap: 8px;\n}\n';
  assert.equal(compactCss(source), '.card{display:flex;gap:8px}\n');
  assert.equal(source.includes('\n display: flex;'), true);
});

test('event fixtures select the intended receiver and event after formatting', () => {
  const source = `document.addEventListener('beforeunload', () => ignored());
    window.addEventListener('resize', () => resized());
    window.addEventListener(\n"beforeunload",\n() => { dispose(); },\n);`;
  const callbacks: [string, () => void][] = [],
    calls: string[] = [],
    context = {
      window: {
        addEventListener: (event: string, callback: () => void) =>
          callbacks.push([event, callback]),
      },
      dispose: () => calls.push('disposed'),
    };
  vm.createContext(context);
  vm.runInContext(
    stripTypeScriptTypes(sourceEventListener(source, 'window', 'beforeunload')),
    context,
  );
  const callback = callbacks[0];
  assert.ok(callback);
  assert.equal(callback[0], 'beforeunload');
  callback[1]();
  assert.deepEqual(calls, ['disposed']);
  assert.throws(() => sourceEventListener(source, 'window', 'missing'), /one exact/);
});
