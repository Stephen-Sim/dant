import { WorkerServiceFixture, observedRecord } from '../support/service-fixtures.mts';
import type { RpcEvent, RpcResult } from '../../src/runtime/protocol.ts';
import type { TaskProgressTask } from '../../src/contracts/contracts.ts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepareObserverEvent,
  getObserverProjectionKind,
  observerEventMetadata,
} from '../../src/runtime/observer-event.mts';
import {
  isTaskExecutionEvent,
  observeTaskProgress,
  startTaskProgress,
} from '../../src/work/task-progress.mts';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';

const large = 'private-tool-payload-' + 'x'.repeat(70000);
const event = (method: string, params: Record<string, unknown> = {}): RpcEvent => ({
  method,
  params: { threadId: 'thread', ...params },
});
const toolItem = (tool: string, type = 'mcpToolCall') => ({
  id: 'tool-item',
  type,
  server: 'dant_desktop',
  tool,
  status: 'completed',
  arguments: { text: large },
  result: { content: [{ type: 'text', text: large }] },
});

test('oversized tool projections preserve only the original execution category across starts and completions', () => {
  for (const method of ['item/started', 'item/completed'])
    for (const type of ['mcpToolCall', 'dynamicToolCall'])
      for (const tool of [
        'type_text',
        'screenshot',
        'send_file',
        'skill_save',
        'memory_write',
        'task_list',
        'task_plan',
        'task_cancel',
        'send_message',
        'schedule_save',
        'credential_find',
      ]) {
        const original = event(method, { turnId: 'owned', item: toolItem(tool, type) }),
          before = JSON.stringify(original),
          projected = prepareObserverEvent(original),
          expected = isTaskExecutionEvent(original),
          task: TaskProgressTask = {};
        assert.notEqual(projected, original);
        assert.equal(getObserverProjectionKind(projected), 'payload');
        assert.equal(isTaskExecutionEvent(projected), expected, `${method} ${type} ${tool}`);
        startTaskProgress(task);
        assert.equal(observeTaskProgress(task, projected), true);
        assert.equal(task.workObserved === true, expected);
        assert.deepEqual(projected.params.item, { id: 'tool-item', type, status: 'completed' });
        assert.equal(JSON.stringify(original), before);
        assert.equal(prepareObserverEvent(projected), projected);
        assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 1024);
        assert.doesNotMatch(
          JSON.stringify(projected),
          /private-tool-payload|arguments|result|tool"|server/,
        );
        assert.deepEqual(observerEventMetadata(projected), {
          itemType: type,
          itemStatus: 'completed',
          itemId: 'tool-item',
        });
      }
});

test('image removal followed by bulk projection carries the category without publishing a forgeable marker', () => {
  const original = event('item/completed', {
      turnId: 'owned',
      item: {
        ...toolItem('screenshot'),
        result: {
          content: [
            { type: 'image', mimeType: 'image/png', data: large },
            { type: 'text', text: large },
          ],
        },
      },
    }),
    projected = prepareObserverEvent(original);
  assert.equal(isTaskExecutionEvent(projected), true);
  assert.equal(getObserverProjectionKind(projected), 'payload');
  assert.equal(isTaskExecutionEvent(JSON.parse(JSON.stringify(projected))), false);
  assert.equal(isTaskExecutionEvent({ ...projected }), false);
  for (const marker of [
    { workObserved: true },
    { observedExecution: true },
    { taskExecution: true },
  ])
    assert.equal(
      isTaskExecutionEvent({
        ...projected,
        ...marker,
        params: {
          ...projected.params,
          ...marker,
          item: { ...observedRecord(projected.params.item), ...marker },
        },
      }),
      false,
    );
  assert.equal(isTaskExecutionEvent(null), false);
  assert.equal(isTaskExecutionEvent(undefined), false);
});

class Worker extends WorkerServiceFixture {
  constructor() {
    super();
    this.status = 'online';
    this.rpc = { send() {}, reply() {} };
  }
  override async request(method: string): Promise<RpcResult> {
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'thread/realtime/start')
      queueMicrotask(() => {
        this.emit('event', event('thread/realtime/started', { version: 'v3' }));
        this.emit(
          'event',
          event('thread/realtime/sdp', { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }),
        );
      });
    return {};
  }
}
async function fixture(t: NodeTestContext) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'observer-task-execution-')),
    store = new Store(dir),
    worker = new Worker(),
    engine = new Engine(store, worker),
    voice = new NativeRealtimeVoice({ engine, worker, connectTimeoutMs: 1000 });
  t.after(() => {
    voice.session = null;
    engine.call = null;
    engine.pauseQueue();
    if (engine.streamingSaveTimer) clearTimeout(engine.streamingSaveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.startCall('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
  await engine.handle(event('turn/started', { turn: { id: 'owned', status: 'inProgress' } }));
  return { store, engine, voice, dir };
}

test('native work with oversized tool input and output receives one durable planless record after observer projection', async (t) => {
  const f = await fixture(t),
    original = event('item/started', { turnId: 'owned', item: toolItem('type_text') }),
    before = JSON.stringify(original);
  await f.engine.handle(event('item/started', { turnId: 'foreign', item: toolItem('type_text') }));
  assert.equal(f.store.state.workTasks.length, 0);
  await f.engine.handle(original);
  const record = f.store.state.workTasks[0];
  assert.ok(record?.id);
  assert.equal(record.plan, null);
  assert.equal(record.provisional, true);
  assert.equal(defined(f.voice.progress).workId, record.id);
  assert.equal(Object.hasOwn(defined(f.voice.progress), 'plan'), false);
  assert.equal(JSON.stringify(original), before);
  assert.doesNotMatch(JSON.stringify(record), /private-tool-payload|type_text|tool-item/);
  await f.engine.handle(event('item/completed', { turnId: 'owned', item: toolItem('type_text') }));
  assert.equal(f.store.state.workTasks.length, 1);
  await f.engine.handle(event('turn/completed', { turn: { id: 'owned', status: 'completed' } }));
  assert.equal(defined(f.store.state.workTasks[0]).status, 'continuing');
  assert.equal(defined(new Store(f.dir).state.workTasks[0]).id, record.id);
});

test('oversized native conversation controls and notes do not manufacture entrusted tasks', async (t) => {
  const f = await fixture(t);
  for (const tool of [
    'memory_write',
    'task_list',
    'task_plan',
    'task_cancel',
    'send_message',
    'schedule_save',
  ])
    for (const method of ['item/started', 'item/completed'])
      await f.engine.handle(event(method, { turnId: 'owned', item: toolItem(tool) }));
  assert.equal(f.store.state.workTasks.length, 0);
  assert.equal(defined(f.voice.progress).visible, false);
  await f.engine.handle(event('turn/completed', { turn: { id: 'owned', status: 'completed' } }));
  assert.equal(f.store.state.workTasks.length, 0);
});
