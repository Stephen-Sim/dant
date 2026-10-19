import { defined } from '../../support/fixture-assertions.mts';
import { managedMemoryFixture } from '../../support/memory-management-fixtures.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createMemorySettings } from '../../../ui/settings/memory-settings.mts';
import { memoryManagementCopy } from '../../../ui/settings/memory-management-copy.mts';
import { languages } from '../../../src/i18n/languages.mts';
import type { ApiOptions, ApiRequest } from '../../../ui/shared/contracts.mts';
import { ServiceUpdateStatus } from '../../../src/contracts/states.mts';
import type { UiServiceUpdate } from '../../../ui/shared/contracts.mts';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const { document } = parseHTML('<html><body><main></main></body></html>');
  let state = {
      conversationId: 'one',
      mode: 'vm-controller' as const,
      controller: {
        status: 'online',
        cached: false,
        serviceUpdate: {
          status: ServiceUpdateStatus.Current,
          confirmed: true,
          targetVersion: '0.4.7-beta.9',
          runningVersion: '0.4.7-beta.9',
          reason: 'source-current',
        } satisfies UiServiceUpdate,
      },
      settings: { vm: { host: 'one', user: 'dant', port: 22 } },
    },
    request: ApiRequest = async () => managedMemoryFixture();
  const calls: { route: string; options?: ApiOptions }[] = [],
    ui = createMemorySettings({
      document,
      getState: () => state,
      request: async (route, options) => {
        calls.push({ route, ...(options ? { options } : {}) });
        return request(route, options);
      },
      onChange: render,
    });
  function render() {
    defined(document.querySelector<HTMLElement>('main')).innerHTML = ui.render();
    ui.bind();
  }
  const button = (action: string, id?: string) =>
    defined(
      document.querySelector<HTMLButtonElement>(
        `[data-memory-action="${action}"]${id ? `[data-id="${id}"]` : ''}`,
      ),
    );
  const edit = (id: string, text: string) => {
    button('edit', id).click();
    const input = defined(document.querySelector<HTMLTextAreaElement>('[data-memory-editor]'));
    input.value = text;
    input.dispatchEvent(new (defined(document.defaultView).Event)('input'));
  };
  render();
  return {
    ui,
    document,
    calls,
    render,
    button,
    edit,
    get state() {
      return state;
    },
    set state(next) {
      state = next;
    },
    set request(next: ApiRequest) {
      request = next;
    },
  };
}
test('SQLite records have logical labels, scoped provenance, controls and a separate collapsed read-only personality', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/memory/manage?q=&offset=0'],
  );
  assert.match(f.document.body.textContent, /SQLite/);
  assert.match(f.document.body.textContent, /Actual durable notes/);
  assert.match(f.document.body.textContent, /Inference/);
  assert.match(f.document.body.textContent, /work-one/);
  assert.doesNotMatch(f.document.body.textContent, /working-memory\.md/);
  assert.equal(f.document.querySelector('details')?.hasAttribute('open'), false);
  assert.equal(f.document.querySelector('textarea'), null);
  f.request = async () => managedMemoryFixture('one', '<script>untrusted note</script>');
  await f.ui.load();
  assert.equal(f.document.querySelector('script'), null);
  assert.match(f.document.body.textContent, /untrusted note/);
});
test('editing and deleting send exact identity and revision once, then refresh authoritative records', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  let wrote = false;
  f.request = async (_route, options) => {
    if (options?.method) {
      wrote = true;
      return { saved: true, conversationId: 'one', revision: '1:5' };
    }
    return managedMemoryFixture('one', 'Saved changed notes');
  };
  f.edit('working-memory.md', 'Changed notes');
  f.button('save').click();
  await tick();
  const mutation = f.calls.find((call) => call.options?.method === 'PATCH');
  assert.deepEqual(mutation?.options?.body, {
    conversationId: 'one',
    revision: '1:4',
    text: 'Changed notes',
  });
  assert.equal(wrote, true);
  assert.match(f.document.body.textContent, /Saved changed notes/);
  f.button('delete', 'entry-one').click();
  assert.equal(f.calls.filter((call) => call.options?.method === 'DELETE').length, 0);
  f.button('delete-confirm').click();
  await tick();
  assert.equal(f.calls.filter((call) => call.options?.method === 'DELETE').length, 1);
});
test('unconfirmed writes are never resent and require a fresh read before further mutations', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  f.request = async (_route, options) => {
    if (options?.method) throw Error('PRIVATE_TRANSPORT_BODY');
    return managedMemoryFixture();
  };
  f.edit('working-memory.md', 'Possibly saved');
  f.button('save').click();
  await tick();
  assert.match(f.document.body.textContent, /outcome is unconfirmed/);
  assert.doesNotMatch(f.document.body.textContent, /PRIVATE_TRANSPORT_BODY/);
  f.button('save').dispatchEvent(new (defined(f.document.defaultView).Event)('click'));
  assert.equal(f.calls.filter((call) => call.options?.method).length, 1);
  f.button('refresh').click();
  await tick();
  assert.equal(f.button('edit', 'entry-one').disabled, false);
});
test('late reads and mutation results cannot cross conversations, computers or page lifetimes', async () => {
  const f = fixture();
  let finish: ((value: unknown) => void) | undefined;
  f.request = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.ui.setVisible(true);
  await tick();
  f.state = {
    ...f.state,
    conversationId: 'two',
    settings: { vm: { host: 'two', user: 'dant', port: 22 } },
  };
  f.request = async () => managedMemoryFixture('two', 'New computer memory');
  f.ui.setVisible(true);
  await tick();
  defined(finish)(managedMemoryFixture('one', 'Stale confidential notes'));
  await tick();
  assert.match(f.document.body.textContent, /New computer memory/);
  assert.doesNotMatch(f.document.body.textContent, /Stale confidential/);
  f.request = async () => managedMemoryFixture('forged', 'Wrong scope');
  await f.ui.load();
  assert.doesNotMatch(f.document.body.textContent, /Wrong scope/);
  f.request = async () => managedMemoryFixture('two');
  await f.ui.load();
  let finishWrite: ((value: unknown) => void) | undefined;
  f.request = () =>
    new Promise((resolve) => {
      finishWrite = resolve;
    });
  f.edit('working-memory.md', 'Pending write');
  f.button('save').click();
  f.ui.setVisible(false);
  defined(finishWrite)({ saved: true, conversationId: 'two', revision: '1:8' });
  await tick();
  f.request = async () => managedMemoryFixture('two', 'Reconciled actual value');
  f.ui.setVisible(true);
  await tick();
  assert.match(f.document.body.textContent, /Reconciled actual value/);
  assert.equal(f.button('edit', 'entry-one').disabled, false);
});
test('offline and redacted records cannot edit, keyword search is explicit and pagination is bounded', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  f.state.controller = { ...f.state.controller, status: 'offline', cached: true };
  f.ui.setVisible(true);
  f.render();
  assert.match(f.document.body.textContent, /Last loaded copy/);
  assert.equal(f.button('edit', 'entry-one').disabled, true);
  f.state.controller = { ...f.state.controller, status: 'online', cached: false };
  f.request = async (route) => {
    const view = managedMemoryFixture(),
      q = new URL('http://fixture' + route).searchParams.get('q') ?? '';
    view.query = q;
    view.records[0]!.redacted = true;
    return view;
  };
  f.ui.setVisible(true);
  await tick();
  assert.equal(f.button('edit', 'working-memory.md').disabled, true);
  const input = defined(f.document.querySelector<HTMLInputElement>('[name=q]'));
  input.value = 'SQLite & FTS';
  defined(f.document.querySelector<HTMLFormElement>('[data-memory-search]')).dispatchEvent(
    new (defined(f.document.defaultView).Event)('submit', { cancelable: true }),
  );
  await tick();
  assert.match(f.calls.at(-1)?.route ?? '', /q=SQLite%20%26%20FTS&offset=0/);
});
test('all supported languages provide memory copy without translating stored user content', () => {
  const translated = new Set(
    languages.map((language) => memoryManagementCopy(language.code).word('description')),
  );
  assert.equal(translated.size, languages.length);
  for (const language of languages) {
    const copy = memoryManagementCopy(language.code);
    assert.ok(copy.word('identityDoc'));
    assert.ok(copy.word('unknown'));
    assert.ok(copy.word('confirm'));
  }
});

test('an older Worker missing management recovers when its confirmed service version changes', async () => {
  const f = fixture();
  f.request = async () => {
    throw Error('404');
  };
  f.ui.setVisible(true);
  await tick();
  assert.match(f.document.body.textContent, /could not be loaded/);
  f.request = async () => managedMemoryFixture('one', 'Worker10 SQLite memory');
  f.state.controller.serviceUpdate = {
    ...f.state.controller.serviceUpdate,
    runningVersion: '0.4.7-beta.10',
    targetVersion: '0.4.7-beta.10',
  };
  f.ui.setVisible(true);
  await tick();
  assert.match(f.document.body.textContent, /Worker10 SQLite memory/);
});

test('explicit confirmation and pagination use the captured record and query without an automatic mutation', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  assert.equal(f.calls.filter((call) => call.options?.method).length, 0);
  f.request = async (route, options) => {
    if (options?.method) return { saved: true, conversationId: 'one', revision: '1:5' };
    const view = managedMemoryFixture(),
      offset = Number(new URL('http://fixture' + route).searchParams.get('offset') ?? '0');
    view.offset = offset;
    view.total = 42;
    view.hasMore = offset === 0;
    return view;
  };
  f.button('confirm', 'entry-one').click();
  await tick();
  assert.ok(
    f.calls.some(
      (call) => call.route.endsWith('/entry-one/confirm') && call.options?.method === 'POST',
    ),
  );
  f.button('next').click();
  await tick();
  assert.match(f.calls.at(-1)?.route ?? '', /offset=40/);
  f.button('previous').click();
  await tick();
  assert.match(f.calls.at(-1)?.route ?? '', /offset=0/);
  f.button('edit', 'entry-one').click();
  f.button('cancel').click();
  assert.equal(f.document.querySelector('textarea'), null);
});
