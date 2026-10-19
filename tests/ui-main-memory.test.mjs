import { sourceIndex, sourceSection, sourceEventListener } from './source-fixtures.mjs';
import { languageContext } from './language-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createMemorySettings } from '../ui/settings/memory-settings.js';

const source = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
const section = (start, end) => sourceSection(source, start, end);

test('main memory navigation uses the shared read-only module and keeps schedules only in its first-class navigation', async () => {
  const { document } = parseHTML('<html><body><main></main></body></html>'),
    requests = [],
    state = {
      conversationId: 'conversation',
      mode: 'vm-controller',
      controller: { status: 'online', cached: false },
      settings: { vm: { host: '192.0.2.1', user: 'dant' } },
    };
  let memorySettings;
  const context = { memorySettings: null };
  vm.createContext(Object.assign(context, languageContext));
  vm.runInContext(section('function renderMemory(){', 'function renderSchedules(){'), context);
  function render() {
    document.querySelector('main').innerHTML = context.renderMemory();
    memorySettings.bind();
  }
  memorySettings = createMemorySettings({
    document,
    getState: () => state,
    onChange: render,
    request: async (route) => {
      requests.push(route);
      return {
        conversationId: state.conversationId,
        readOnly: true,
        identity: { text: 'Actual personality' },
        memory: { text: 'Actual saved notes' },
      };
    },
  });
  context.memorySettings = memorySettings;
  memorySettings.setVisible(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(document.body.textContent, /Actual personality/);
  assert.match(document.body.textContent, /Actual saved notes/);
  assert.equal(document.querySelector('textarea,input,[contenteditable]'), null);
  await document.querySelector('[data-memory-refresh]').onclick();
  assert.deepEqual(requests, ['/memory/view', '/memory/view']);
  const settings = section('function renderSettings(){', 'function renderMemory(){');
  assert.doesNotMatch(settings, /button\('schedules'/);
  assert.match(
    source,
    /data-action="schedules"|button\('schedules'/,
    'scheduled tasks remain available outside Chat & data',
  );
  assert.match(source, /memorySettings\.setVisible\(page\s*===\s*'memory'\)/);
  assert.match(
    source,
    /if\s*\(document\.querySelector\('\.memory-page'\)\)\s*memorySettings\.bind\(\)/,
  );
  assert.match(
    sourceEventListener(source, 'window', 'beforeunload'),
    /memorySettings\.dispose\(\)/,
  );
  assert.match(source, /memory:\s*'记忆与人格'/);
  assert.match(source, /memory:\s*'Memory & personality'/);
  memorySettings.dispose();
});
