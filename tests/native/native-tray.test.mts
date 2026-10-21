import { defined } from '../support/fixture-assertions.mts';
import { deferred, observedRecord } from '../support/service-fixtures.mts';
import type { EventModule } from '../../ui/shared/contracts.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trayStatus, createNativeTray } from '../../ui/platform/native-tray.mts';

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
const state = (values: Record<string, unknown> = {}) => ({
  settings: { language: 'en' },
  worker: { status: 'online' },
  queue: [],
  ...values,
});
function fixture(
  options: NonNullable<Parameters<typeof createNativeTray>[0]> & {
    invoke?: (command: string, args?: Record<string, unknown>) => unknown;
  } = {},
) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  let handler: Parameters<EventModule['listen']>[1] | undefined,
    stops = 0,
    opened = 0;
  const tray = createNativeTray({
    desktop: true,
    loadCore: async () => ({
      invoke: async (command, args) => {
        calls.push({ command, args });
        return options.invoke?.(command, args);
      },
    }),
    loadEvents: async () => ({
      listen: async (name, callback) => {
        assert.equal(name, 'dant-tray-progress');
        handler = callback;
        return () => stops++;
      },
    }),
    onProgress: () => opened++,
    ...options,
  });
  return {
    tray,
    calls,
    event: () => handler?.({ payload: 'ignored' }),
    get stops() {
      return stops;
    },
    get opened() {
      return opened;
    },
  };
}
test('tray status projects only bounded public metadata and separates active work from call presence', () => {
  assert.deepEqual(trayStatus(), {
    language: 'zh',
    connection: 'offline',
    task: 'idle',
    queued: 0,
  });
  assert.deepEqual(
    trayStatus(
      state({ call: { id: 'secret-call' }, messages: [{ text: 'private' }], token: 'secret' }),
    ),
    { language: 'en', connection: 'online', task: 'idle', queued: 0 },
  );
  assert.equal(
    trayStatus(state({ active: { status: 'running', source: 'voice', visible: false } })).task,
    'idle',
    'ordinary speech does not advertise a work task',
  );
  assert.equal(
    trayStatus(state({ active: { status: 'running', background: true, text: 'private task' } }))
      .task,
    'background',
  );
  for (const status of ['waiting_user', 'pausing', 'unknown'])
    assert.equal(trayStatus(state({ active: { status, background: true } })).task, status);
  assert.equal(trayStatus(state({ active: { status: 'private exception' } })).task, 'running');
  assert.equal(trayStatus(state({ worker: { status: 'offline' } })).connection, 'offline');
  assert.equal(trayStatus(state({ controller: { status: 'offline' } })).connection, 'offline');
  assert.equal(
    trayStatus(state({ controller: { status: 'connecting' } })).connection,
    'connecting',
  );
  assert.equal(trayStatus(state({ controller: { status: 'error' } })).connection, 'offline');
  assert.equal(trayStatus(state({ worker: { status: 'connecting' } })).connection, 'connecting');
  assert.equal(
    trayStatus(state({ controller: { cached: true }, active: { status: 'running' } })).connection,
    'offline',
  );
  assert.equal(trayStatus(state({ queue: Array(1200).fill('private id') })).queued, 999);
  assert.equal(trayStatus(state({ queue: 'invalid' })).queued, 0);
});
test('browser mode never imports native APIs or emits tray updates', () => {
  let loads = 0;
  const tray = createNativeTray({
    loadCore: async () => {
      loads++;
      throw Error('Unexpected native import');
    },
    loadEvents: async () => {
      loads++;
      throw Error('Unexpected native import');
    },
  });
  tray.sync(state());
  tray.dispose();
  tray.sync(state());
  assert.equal(loads, 0);
});
test('native status deduplicates identical snapshots and the fixed progress event opens work progress', async () => {
  const f = fixture();
  f.tray.sync(state({ messages: [{ text: 'never sent' }] }));
  await settle();
  f.tray.sync(state());
  await settle();
  assert.deepEqual(f.calls, [
    { command: 'tray_status_update', args: { status: trayStatus(state()) } },
  ]);
  assert.doesNotMatch(JSON.stringify(f.calls), /never sent/);
  f.event();
  assert.equal(f.opened, 1);
  f.tray.dispose();
  f.event();
  f.tray.sync(state({ active: {} }));
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.stops, 1);
  assert.equal(f.opened, 1);
  f.tray.dispose();
});
test('native updates coalesce in flight while changed state survives an earlier failure', async () => {
  const wait = deferred(),
    f = fixture({ invoke: () => (f.calls.length === 1 ? wait.promise : undefined) });
  f.tray.sync(state());
  await settle();
  f.tray.sync(state({ active: { background: true } }));
  f.tray.sync(state({ active: { status: 'waiting_user' } }));
  wait.reject(Error('Private OS error'));
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(observedRecord(defined(defined(f.calls[1]).args).status).task, 'waiting_user');
  f.tray.dispose();
  const pending = deferred(),
    g = fixture({ invoke: () => (g.calls.length === 1 ? pending.promise : undefined) });
  g.tray.sync(state());
  await settle();
  g.tray.sync(state({ active: {} }));
  pending.resolve();
  await settle();
  assert.equal(g.calls.length, 2);
  assert.equal(observedRecord(defined(defined(g.calls[1]).args).status).task, 'running');
  g.tray.dispose();
});
test('tray initialization failures are bounded and disposal during initialization releases the listener', async () => {
  let attempts = 0;
  const f = fixture({
    loadCore: async () => {
      attempts++;
      throw Error('Private import error');
    },
  });
  f.tray.sync(state());
  await settle();
  assert.equal(attempts, 1);
  assert.equal(f.calls.length, 0);
  f.tray.sync(state());
  await settle();
  assert.equal(attempts, 2);
  f.tray.dispose();
  const wait = deferred<() => void>();
  let stops = 0;
  const g = fixture({ loadEvents: async () => ({ listen: () => wait.promise }) });
  g.tray.sync(state());
  await settle();
  g.tray.dispose();
  wait.resolve(() => stops++);
  await settle();
  assert.equal(stops, 1);
  assert.equal(g.calls.length, 0);
});
test('native lifecycle installs one instance first, hides only after successful tray setup, and uses graceful exit', () => {
  const main = fs.readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8'),
    backend = fs.readFileSync(new URL('../../src-tauri/src/backend.rs', import.meta.url), 'utf8'),
    tray = fs.readFileSync(new URL('../../src-tauri/src/tray.rs', import.meta.url), 'utf8'),
    overlay = fs.readFileSync(
      new URL('../../src-tauri/src/call_overlay.rs', import.meta.url),
      'utf8',
    ),
    cargo = fs.readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const instance = main.search(/\.plugin\(\s*tauri_plugin_single_instance::init/),
    notification = main.search(/\.plugin\(\s*tauri_plugin_notification::init/);
  assert.ok(instance >= 0);
  assert.ok(notification >= 0);
  assert.ok(instance < notification);
  assert.match(
    main,
    /if !tray::on_window_event\(window,\s*event\)\s*\{\s*call_overlay::on_window_event/,
  );
  assert.match(main, /RunEvent::Exit\s*=\s*event/);
  assert.match(main, /state\.stop\(\)/);
  assert.match(backend, /drop\(child\.stdin\.take\(\)\)/);
  assert.match(tray, /window\.hide\(\)\.is_ok\(\)[\s\S]*api\.prevent_close\(\)/);
  assert.match(tray, /fn install_tray[\s\S]*target\.lock\(\)\.unwrap\(\)[\s\S]*ready\.store\(true/);
  assert.match(tray, /setup_using\(app, \|builder\| builder\.build\(app\)\)/);
  assert.match(
    tray,
    /let icon = create\(builder\)\?;[\s\S]*install_tray\(\s*&state\.ready,\s*&state\.inner,/,
  );
  assert.match(tray, /fn exit(?:<[^>]*>)?\(app:[\s\S]*crate::lifecycle::request_exit\(app\)/);
  assert.match(main, /ExitRequested\s*\{\s*api,\s*\.\.\s*\}[\s\S]*api\.prevent_exit\(\)/);
  assert.match(tray, /update_status_on_main_thread\(\s*&app,\s*window\.label\(\),\s*status\)/);
  assert.match(tray, /if label != "main" \|\| !valid\(&status\)/);
  assert.match(tray, /dant-tray-progress/);
  assert.doesNotMatch(tray, /process::exit|api\/call\/stop|turn\/interrupt/);
  assert.match(overlay, /let background = main\.minimized\(\) \|\| !main\.visible\(true\)/);
  assert.match(
    overlay,
    /fn minimized\(&self\) -> bool\s*\{\s*self\.is_minimized\(\)\.unwrap_or\(false\)/,
  );
  assert.match(
    overlay,
    /fn visible\(&self, fallback: bool\) -> bool\s*\{\s*self\.is_visible\(\)\.unwrap_or\(fallback\)/,
  );
  assert.match(overlay, /if !background \|\| call\.is_none\(\)/);
  assert.match(cargo, /features = \["tray-icon"\]/);
});
