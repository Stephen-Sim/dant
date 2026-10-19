import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection, sourceEventListener } from '../../support/source-fixtures.mts';
import { en, zh } from '../../../ui/i18n/interface-copy.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createMemorySettings } from '../../../ui/settings/memory-settings.mts';
import { managedMemoryFixture } from '../../support/memory-management-fixtures.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
const section = (start: string, end: string) => sourceSection(source, start, end);

test('main memory navigation uses SQLite management and keeps schedules only in its first-class navigation', async () => {
  const { document } = parseHTML('<html><body><main></main></body></html>'),
    requests: string[] = [],
    state = {
      conversationId: 'conversation',
      mode: 'vm-controller' as const,
      controller: { status: 'online', cached: false },
      settings: { vm: { host: '192.0.2.1', user: 'dant' } },
    };
  let memorySettings: ReturnType<typeof createMemorySettings>;
  const context = uiEntrypointFixture({
    memorySettings: null as ReturnType<typeof createMemorySettings> | null,
  });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    stripTypeScriptTypes(section('function renderMemory(){', 'function renderSchedules(){')),
    context,
  );
  function render() {
    defined(document.querySelector<HTMLElement>('main')).innerHTML = context.renderMemory();
    memorySettings.bind();
  }
  memorySettings = createMemorySettings({
    document,
    getState: () => state,
    onChange: render,
    request: async (route) => {
      requests.push(route);
      return managedMemoryFixture(state.conversationId, 'Actual saved notes');
    },
  });
  context.memorySettings = memorySettings;
  memorySettings.setVisible(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(document.body.textContent, /Actual shared personality/);
  assert.match(document.body.textContent, /Actual saved notes/);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea,[contenteditable]'), null);
  document.querySelector<HTMLButtonElement>('[data-memory-action="refresh"]')?.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['/memory/manage?q=&offset=0', '/memory/manage?q=&offset=0']);
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
    /if\s*\(document\.querySelector<HTMLElement>(?:<[^>]+>)?\('\.memory-page'\)\)\s*memorySettings\.bind\(\)/,
  );
  assert.match(
    sourceEventListener(source, 'window', 'beforeunload'),
    /memorySettings\.dispose\(\)/,
  );
  assert.equal(zh.memory, '记忆与人格');
  assert.equal(en.memory, 'Memory & personality');
  memorySettings.dispose();
});
