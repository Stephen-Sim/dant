import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createMemorySettings } from '../../../ui/settings/memory-settings.mts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const value = (conversationId = 'one', memory = 'Actual durable notes') => ({
  conversationId,
  readOnly: true,
  identity: { text: 'Actual shared identity' },
  memory: { text: memory },
});
interface MemoryState {
  conversationId: string;
  mode: 'vm-controller';
  controller: { status: string; cached: boolean };
  settings: { vm: { host: string; user: string; port: number } };
  memory?: string;
}
type MemoryRequest = (route: string) => Promise<unknown>;
function fixture() {
  const { document } = parseHTML('<!doctype html><html><body><main></main></body></html>');
  let state: MemoryState = {
      conversationId: 'one',
      mode: 'vm-controller',
      controller: { status: 'online', cached: false },
      settings: { vm: { host: 'one', user: 'dant', port: 22 } },
    },
    request: MemoryRequest = async () => value();
  const calls: string[] = [],
    ui = createMemorySettings({
      document,
      getState: () => state,
      request: async (route) => {
        calls.push(route);
        return request(route);
      },
      onChange: render,
    });
  function render() {
    defined(document.querySelector<HTMLElement>('main')).innerHTML = ui.render();
    ui.bind();
  }
  render();
  return {
    ui,
    document,
    calls,
    render,
    set state(next) {
      state = next;
    },
    get state() {
      return state;
    },
    set request(next: MemoryRequest) {
      request = next;
    },
  };
}

test('memory page reads only effective persona and notes and offers no editor or mutation action', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  f.ui.setVisible(true);
  await tick();
  assert.deepEqual(f.calls, ['/memory/view']);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-identity]')).textContent,
    'Actual shared identity',
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-references]')).textContent,
    'Actual durable notes',
  );
  assert.equal(
    f.document.querySelector<HTMLTextAreaElement>('textarea,input,[contenteditable]'),
    null,
  );
  f.request = async () => value('one', '<script>private injected script</script>');
  await f.ui.load();
  assert.equal(f.document.querySelector<HTMLElement>('script'), null);
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-references]')).textContent,
    /injected script/,
  );
});

test('different conversation or computer never receives a stale memory response', async () => {
  const f = fixture();
  let finish: ((result: ReturnType<typeof value>) => void) | undefined;
  f.request = () => new Promise<ReturnType<typeof value>>((resolve) => (finish = resolve));
  f.ui.setVisible(true);
  await tick();
  f.state = {
    ...f.state,
    conversationId: 'two',
    settings: { vm: { host: 'two', user: 'dant', port: 22 } },
  };
  f.request = async () => value('two', 'New computer notes');
  f.ui.setVisible(true);
  await tick();
  defined(finish)(value('one', 'Old computer notes'));
  await tick();
  assert.match(f.document.body.textContent, /New computer notes/);
  assert.doesNotMatch(f.document.body.textContent, /Old computer/);
  f.request = async () => value('other', 'Forged scope');
  await f.ui.load();
  assert.doesNotMatch(f.document.body.textContent, /Forged scope/);
});

test('offline view labels its last read copy and reconnect refreshes without invented fallback notes', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  f.state.controller = { status: 'offline', cached: true };
  f.ui.setVisible(true);
  f.render();
  assert.match(f.document.body.textContent, /Last loaded copy/);
  assert.match(f.document.body.textContent, /Actual durable notes/);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-refresh]')).disabled,
    true,
  );
  f.request = async () => value('one', 'Reconnected current notes');
  f.state.controller = { status: 'online', cached: false };
  f.ui.setVisible(true);
  await tick();
  assert.match(f.document.body.textContent, /Reconnected current notes/);
  f.state = {
    ...f.state,
    conversationId: 'three',
    controller: { status: 'offline', cached: true },
  };
  f.ui.setVisible(true);
  f.render();
  assert.doesNotMatch(f.document.body.textContent, /Reconnected current notes/);
  assert.match(f.document.body.textContent, /Connect the work computer/);
});

test('memory revisions refresh a visible page and leaving it ignores late failures', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  f.state.memory = 'Updated snapshot';
  f.request = async () => value('one', 'Updated durable notes');
  f.ui.setVisible(true);
  await tick();
  assert.match(f.document.body.textContent, /Updated durable notes/);
  let reject: ((cause: unknown) => void) | undefined;
  f.request = () => new Promise<never>((_resolve, no) => (reject = no));
  const pending = f.ui.load();
  f.ui.setVisible(false);
  defined(reject)(Error('PRIVATE_TRANSPORT_BODY'));
  await pending;
  f.render();
  assert.doesNotMatch(f.document.body.textContent, /PRIVATE_TRANSPORT_BODY/);
});

test('refresh keeps the current notes visible, announces loading and ignores repeated activation until the read finishes', async () => {
  const f = fixture();
  f.ui.setVisible(true);
  await tick();
  let finish: ((result: ReturnType<typeof value>) => void) | undefined;
  f.request = () => new Promise<ReturnType<typeof value>>((resolve) => (finish = resolve));
  defined(f.document.querySelector<HTMLButtonElement>('[data-memory-refresh]')).click();
  const busy = f.document.querySelector<HTMLButtonElement>('[data-memory-refresh]');
  assert.equal(defined(busy).disabled, true);
  assert.equal(defined(busy).getAttribute('aria-busy'), 'true');
  assert.match(defined(busy).textContent, /Refreshing/);
  assert.ok(defined(busy).querySelector<HTMLElement>('svg[aria-hidden="true"]'));
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /Reading current memory/,
  );
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-references]')).textContent,
    /Actual durable notes/,
  );
  defined(busy).dispatchEvent(new (defined(f.document.defaultView).Event)('click'));
  assert.equal(f.calls.length, 2);
  defined(finish)(value('one', 'Refreshed notes'));
  await tick();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-refresh]')).disabled,
    false,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-refresh]')).getAttribute(
      'aria-busy',
    ),
    'false',
  );
  assert.equal(defined(f.document.querySelector<HTMLElement>('[role="status"]')).hidden, true);
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-memory-references]')).textContent,
    /Refreshed notes/,
  );
  f.ui.dispose();
});
