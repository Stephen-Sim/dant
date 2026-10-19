import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Diagnostics, DiagnosticLogger } from '../../src/diagnostics/diagnostics.mts';
import type { DiagnosticsOptions } from '../../src/diagnostics/diagnostics.mts';
import { observeHttp, observeBridge } from '../../src/diagnostics/diagnostic-events.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const DAY = 86400000,
  MiB = 1024 * 1024,
  epoch = Date.parse('2026-10-17T00:00:00.000Z');
const files = (logger: Pick<Diagnostics, 'directory'>) =>
  fs
    .readdirSync(defined(logger.directory))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(defined(logger.directory), name));
function setup(t: NodeTestContext, options: DiagnosticsOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(root, 'diagnostics-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const clock = { now: epoch };
  const logger = new Diagnostics({ dataDir, role: 'vm-worker', now: () => clock.now, ...options });
  t.after(() => logger.close());
  return { dataDir, logger, clock };
}
function owned(directory: string, { at = epoch, body = '', id = randomUUID() } = {}) {
  const createdAt = new Date(at).toISOString(),
    file = path.join(directory, `dant-diagnostics-v1-${createdAt.slice(0, 10)}-${id}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ schema: 'dant.diagnostics.v1', id, createdAt }) + '\n' + body,
  );
  return file;
}

test('diagnostics defaults to private daily JSONL, three-day retention, bounded sizes and an unreferenced cleanup timer', (t) => {
  const { logger } = setup(t);
  assert.equal(DiagnosticLogger, Diagnostics);
  const status = logger.status();
  assert.equal(status.retentionDays, 3);
  assert.equal(status.maxFileBytes, 5 * MiB);
  assert.equal(status.maxTotalBytes, 50 * MiB);
  assert.equal(status.cleanupIntervalMs, 3600000);
  assert.equal(status.startupLogMaxBytes, MiB);
  assert.equal(status.lastError, null);
  assert.equal(defined(logger.timer).hasRef(), false);
  assert.equal(logger.log('service.started', { status: 'online', provider: 'vmware' }), true);
  assert.equal(logger.log('worker.status', { status: 'offline', code: 'worker_stopped' }), true);
  assert.equal(files(logger).length, 1);
  const records = logger.recent();
  assert.equal(records.length, 2);
  assert.equal(defined(records[0]).role, 'vm-worker');
  assert.equal(defined(records[1]).code, 'worker_stopped');
  assert.equal(status.closed, false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(defined(logger.directory)).mode & 0o077, 0);
    assert.equal(fs.statSync(defined(files(logger)[0])).mode & 0o077, 0);
  }
});

test('fixed metadata schema retains useful scalar fields and excludes all content, secrets, raw errors and nested values', (t) => {
  const { logger } = setup(t),
    fields = JSON.parse(
      '{"__proto__":{"secret":"proto-secret"},"constructor":"constructor-secret","prototype":"prototype-secret"}',
    );
  Object.assign(fields, {
    code: 'voice_shutdown',
    status: 502,
    method: 'thread/realtime/stop',
    route: '/api/call/stop',
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: 'call-1',
    requestId: 7,
    messageId: 'message-1',
    taskId: 'task-1',
    reason: 'notification-buffer',
    bytes: 120,
    queuedBytes: 4096,
    queuedEvents: 2,
    eventBytes: 900,
    durationMs: 4.5,
    executorStopped: true,
    confirmed: false,
    exitCode: -1,
    prompt: 'prompt-secret',
    payload: { token: 'nested-secret' },
    image: 'image-secret',
    content: 'content-secret',
    headers: { Authorization: 'Bearer header-secret' },
    token: 'token-secret',
    secret: 'secret-secret',
    error: Error('raw-error-secret'),
    message: 'raw-message-secret',
  });
  Object.defineProperty(fields, 'operation', {
    get() {
      assert.fail('The logger must not execute metadata getters');
    },
  });
  assert.equal(logger.log('voice.shutdown', fields), true);
  const record = defined(logger.recent()[0]);
  assert.equal(defined(record).status, 502);
  assert.equal(defined(record).requestId, 7);
  assert.equal(defined(record).durationMs, 4.5);
  assert.equal(defined(record).method, 'thread/realtime/stop');
  assert.equal(defined(record).route, '/api/call/stop');
  assert.equal(defined(record).confirmed, false);
  assert.equal(defined(record).executorStopped, true);
  assert.equal(defined(record).eventBytes, 900);
  const serialized = fs.readFileSync(defined(files(logger)[0]), 'utf8');
  assert.doesNotMatch(
    serialized,
    /proto-secret|constructor-secret|prototype-secret|prompt-secret|nested-secret|image-secret|content-secret|header-secret|token-secret|secret-secret|raw-error-secret|raw-message-secret/,
  );
  for (const key of [
    'prompt',
    'payload',
    'image',
    'content',
    'headers',
    'token',
    'secret',
    'error',
    'message',
    'operation',
    'constructor',
    '__proto__',
  ])
    assert.equal(Object.hasOwn(record, key), false);
});

test('events, IDs, route templates, value types and lengths reject accidental raw diagnostics', (t) => {
  const { logger } = setup(t);
  for (const event of ['bad event', 'newline\nsecret', 'sk-live-secret', 'x'.repeat(81), {}, null])
    assert.equal(logger.log(event, { secret: 'never' }), false);
  assert.equal(
    logger.log('http.error', {
      route: '/api/messages/private-user-id?token=never',
      method: 'https://token.example',
      reason: 'Raw exception containing a secret',
      status: { secret: 'nested' },
      code: 'sk-live-secret',
      threadId: 'a'.repeat(129),
      turnId: 'Bearer-private',
      callId: ['call'],
      requestId: -1,
      bytes: -1,
      queuedBytes: Infinity,
      queuedEvents: '2',
      durationMs: NaN,
      confirmed: 'true',
    }),
    true,
  );
  assert.deepEqual(Object.keys(defined(logger.recent()[0])).sort(), ['at', 'event', 'role']);
  assert.equal(logger.status().lastError, 'LOG_INVALID_EVENT');
  assert.equal(
    logger.log('http.error', { route: '/api/messages/:id', method: 'PATCH', status: 409 }),
    true,
  );
  assert.equal(defined(logger.recent().at(-1)).route, '/api/messages/:id');
  assert.equal(logger.log('worker.status', Error('not serialized')), true);
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error('private proxy error');
      },
    },
  );
  assert.equal(logger.log('worker.status', proxy), false);
  assert.equal(logger.status().lastError, 'LOG_WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(logger.status()), /private proxy error/);
});

test('feature action route templates survive HTTP observation, persistence and recent reads without sensitive route values', (t) => {
  const { logger } = setup(t),
    middleware = observeHttp(logger, { now: () => 0 }),
    expected = [];
  for (const action of ['accept', 'pause', 'resume', 'cancel', 'priority', 'dismiss', 'context']) {
    const res = Object.assign(new EventEmitter(), { statusCode: 409 });
    middleware(
      {
        method: action === 'context' ? 'GET' : 'POST',
        originalUrl:
          '/api/tasks/private-task-id/' +
          action +
          '?turnId=private-turn&conversationId=private-conversation&token=private-token',
        body: { text: 'private-reply' },
      },
      res,
      () => {},
    );
    res.emit('finish');
    expected.push('/api/tasks/:id/' + action);
  }
  const res = Object.assign(new EventEmitter(), { statusCode: 409 });
  middleware(
    { method: 'POST', originalUrl: '/api/tasks/clear-completed?token=private-token' },
    res,
    () => {},
  );
  res.emit('finish');
  expected.push('/api/tasks/clear-completed');
  const linkRes = Object.assign(new EventEmitter(), { statusCode: 404 });
  middleware(
    {
      method: 'POST',
      originalUrl: '/api/messages/private-message/output-link/resolve?token=private-token',
      body: { href: 'file:///private-path' },
    },
    linkRes,
    () => {},
  );
  linkRes.emit('finish');
  expected.push('/api/messages/:id/output-link/resolve');
  for (const [url, template] of [
    ['/api/skills/private-name/export', '/api/skills/:name/export'],
    ['/api/backups/private-backup/restore', '/api/backups/:id/restore'],
    ['/api/backups/private-backup/export', '/api/backups/:id/export'],
    ['/api/backups/export', '/api/backups/export'],
    ['/api/memory/manage', '/api/memory/manage'],
    ['/api/memory/manage/semantic/private-record', '/api/memory/manage/:kind/:id'],
    ['/api/memory/manage/semantic/private-record/confirm', '/api/memory/manage/:kind/:id/confirm'],
  ]) {
    const featureResponse = Object.assign(new EventEmitter(), { statusCode: 400 });
    middleware(
      { method: 'POST', originalUrl: url + '?query=private-value', body: { text: 'private-text' } },
      featureResponse,
      () => {},
    );
    featureResponse.emit('finish');
    expected.push(defined(template));
  }
  assert.deepEqual(
    logger.recent(100).map((row) => row.route),
    expected,
  );
  assert.doesNotMatch(fs.readFileSync(defined(files(logger)[0]), 'utf8'), /private-/);
  logger.log('http.request', {
    route: '/api/tasks/private-task/context',
    method: 'GET',
    status: 409,
  });
  assert.equal(Object.hasOwn(defined(logger.recent().at(-1)), 'route'), false);
});

test('VM update failure metadata survives persistence with distinct target, running and logger versions', (t) => {
  const { logger } = setup(t, { role: 'controller', version: '0.4.7-beta.7' }),
    bridge = new EventEmitter(),
    detach = observeBridge(logger, bridge);
  t.after(detach);
  bridge.emit('diagnostic', {
    event: 'vm.service-update',
    fields: {
      status: 'failed',
      phase: 'pause',
      reason: 'pause-unconfirmed',
      stage: 'post-pause',
      targetVersion: '0.4.7-beta.7',
      runningVersion: '0.4.7-beta.6',
      unknownOutcome: true,
      stdout: 'PRIVATE command result',
      error: Error('PRIVATE path'),
      task: { text: 'PRIVATE task' },
    },
  });
  assert.deepEqual(logger.recent()[0], {
    at: new Date(epoch).toISOString(),
    event: 'vm.service-update',
    status: 'failed',
    reason: 'pause-unconfirmed',
    phase: 'pause',
    stage: 'post-pause',
    unknownOutcome: true,
    targetVersion: '0.4.7-beta.7',
    runningVersion: '0.4.7-beta.6',
    role: 'controller',
    version: '0.4.7-beta.7',
  });
  logger.log('vm.service-update', {
    targetVersion: 'PRIVATE version',
    runningVersion: '1.2.3\nPRIVATE',
    status: 'failed',
  });
  assert.deepEqual(Object.keys(defined(logger.recent().at(-1))).sort(), [
    'at',
    'event',
    'role',
    'status',
    'version',
  ]);
  assert.doesNotMatch(
    fs.readFileSync(defined(files(logger)[0]), 'utf8'),
    /PRIVATE|stdout|command result|task/,
  );
});

test('observer diagnostics retain only fixed item schema metadata and safe IDs', (t) => {
  const { logger } = setup(t);
  assert.equal(
    logger.log('voice_observer_payload_omitted', {
      itemType: 'mcpToolCall',
      itemStatus: 'completed',
      itemId: 'screenshot-1',
      eventBytes: 1049077,
      bytes: 240,
      output: 'private-result',
      arguments: { secret: 'private-argument' },
    }),
    true,
  );
  assert.deepEqual(logger.recent()[0], {
    at: new Date(epoch).toISOString(),
    event: 'voice_observer_payload_omitted',
    role: 'vm-worker',
    itemId: 'screenshot-1',
    eventBytes: 1049077,
    bytes: 240,
    itemType: 'mcpToolCall',
    itemStatus: 'completed',
  });
  for (const fields of [
    { itemType: 'private-tool-name', itemStatus: 'private-status', itemId: 'private id' },
    { itemType: 'sk-live-secret', itemStatus: 'Bearer-secret', itemId: 'sk-live-secret' },
  ]) {
    assert.equal(logger.log('voice_observer_payload_omitted', fields), true);
    assert.deepEqual(Object.keys(defined(logger.recent().at(-1))).sort(), ['at', 'event', 'role']);
  }
  assert.doesNotMatch(
    fs.readFileSync(defined(files(logger)[0]), 'utf8'),
    /private-|sk-live-secret|Bearer-secret/,
  );
});

test('daily and size-based rotation keep actual file sizes below the configured maximum', (t) => {
  const { logger, clock } = setup(t, { maxFileBytes: 350, maxTotalBytes: 5000 });
  for (let index = 0; index < 8; index++) {
    clock.now++;
    assert.equal(
      logger.log('worker.status', { code: 'event_' + index, status: 'online', requestId: index }),
      true,
    );
  }
  assert.ok(files(logger).length > 1);
  assert.ok(files(logger).every((file) => fs.statSync(file).size <= 350));
  const before = files(logger).length;
  clock.now += DAY;
  assert.equal(logger.log('service.started'), true);
  assert.equal(files(logger).length, before + 1);
  assert.ok(files(logger).some((file) => file.includes('2026-10-18')));
  assert.equal(defined(logger.recent(2).at(-1)).event, 'service.started');
});

test('total byte cap evicts old owned logs and preserves newest diagnostics', (t) => {
  const { logger, clock } = setup(t, { maxFileBytes: 300, maxTotalBytes: 650 });
  for (let index = 0; index < 18; index++) {
    clock.now++;
    assert.equal(logger.log('worker.status', { code: 'event_' + index, requestId: index }), true);
    const total = files(logger).reduce((sum, file) => sum + fs.statSync(file).size, 0);
    assert.ok(total <= 650);
    assert.equal(logger.status().totalBytes, total);
  }
  assert.equal(defined(logger.recent().at(-1)).requestId, 17);
  assert.equal(
    logger.recent().some((item) => item.requestId === 0),
    false,
  );
});

test('timer expires logs without new events and close cancels the timer and blocks future writes', (t) => {
  let callback: (() => void) | undefined,
    unreferenced = false,
    cancelled: ReturnType<typeof setInterval> | null = null;
  const handle = setInterval(() => {}, 3_600_000);
  t.after(() => clearInterval(handle));
  const unref = handle.unref.bind(handle);
  handle.unref = () => {
    unreferenced = true;
    return unref();
  };
  const { logger, clock } = setup(t, {
    schedule: (fn, interval) => {
      callback = fn;
      assert.equal(interval, 3600000);
      return handle;
    },
    cancel: (timer) => {
      cancelled = timer;
      clearInterval(timer);
    },
  });
  assert.equal(unreferenced, true);
  assert.equal(logger.log('service.started'), true);
  clock.now += 3 * DAY;
  defined(callback)();
  assert.deepEqual(files(logger), []);
  assert.equal(logger.status().totalBytes, 0);
  logger.close();
  assert.equal(cancelled, handle);
  assert.equal(logger.timer, null);
  assert.equal(logger.status().closed, true);
  assert.equal(logger.log('service.stopped'), false);
  assert.equal(logger.cleanup(), false);
  logger.close();
});

test('startup cleanup expires recognized files only and never deletes unrelated or malformed files', (t) => {
  const { dataDir, logger, clock } = setup(t);
  logger.close();
  const directory = defined(logger.directory);
  const old = owned(directory, { at: epoch - 4 * DAY }),
    fresh = owned(directory, {
      at: epoch - DAY,
      body:
        JSON.stringify({
          at: new Date(epoch - DAY).toISOString(),
          event: 'service.started',
          role: 'vm-worker',
        }) + '\n',
    });
  const unrelated = path.join(directory, 'user-notes.jsonl'),
    mismatched = path.join(directory, `dant-diagnostics-v1-2026-10-13-${randomUUID()}.jsonl`),
    headerless = path.join(directory, `dant-diagnostics-v1-2026-10-13-${randomUUID()}.jsonl`);
  fs.writeFileSync(unrelated, 'user data');
  fs.writeFileSync(
    mismatched,
    JSON.stringify({
      schema: 'dant.diagnostics.v1',
      id: randomUUID(),
      createdAt: '2026-10-13T00:00:00.000Z',
    }) + '\n',
  );
  fs.writeFileSync(headerless, 'arbitrary data');
  const reopened = new Diagnostics({ dataDir, now: () => clock.now });
  t.after(() => reopened.close());
  assert.equal(fs.existsSync(old), false);
  for (const file of [fresh, unrelated, mismatched, headerless])
    assert.equal(fs.existsSync(file), true);
  assert.equal(defined(reopened.recent()[0]).event, 'service.started');
});

test('recent reads only a bounded safe tail, limits results and re-sanitizes records read from disk', (t) => {
  const { logger, clock } = setup(t);
  for (let index = 0; index < 8; index++) {
    clock.now++;
    logger.log('worker.status', { requestId: index });
  }
  assert.deepEqual(
    logger.recent(3).map((item) => item.requestId),
    [5, 6, 7],
  );
  assert.deepEqual(logger.recent(0), []);
  assert.equal(logger.recent(Infinity).length, 8);
  const file = defined(files(logger)[0]);
  fs.appendFileSync(
    file,
    'not JSON\n' +
      JSON.stringify({
        at: new Date(clock.now).toISOString(),
        event: 'http.error',
        route: '/api/state',
        status: 500,
        content: 'PRIVATE',
        token: 'PRIVATE',
      }) +
      '\n' +
      'x'.repeat(5000) +
      '\n',
  );
  const recent = logger.recent(200);
  assert.equal(defined(recent.at(-1)).status, 500);
  assert.equal(Object.hasOwn(defined(recent.at(-1)), 'content'), false);
  assert.doesNotMatch(JSON.stringify(recent), /PRIVATE/);
  fs.appendFileSync(
    file,
    'y'.repeat(300000) +
      '\n' +
      JSON.stringify({ at: new Date(clock.now + 1).toISOString(), event: 'service.started' }) +
      '\n',
  );
  assert.equal(defined(logger.recent(1)[0]).event, 'service.started');
  assert.equal(logger.recent(10000).length <= 200, true);
});

test('constructor, status, cleanup and recent contain filesystem failures without exposing exception text', (t) => {
  const { logger } = setup(t);
  logger.log('service.started');
  const original = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', () => {
    throw Error('PRIVATE filesystem information');
  });
  assert.equal(logger.cleanup(), false);
  assert.equal(logger.log('worker.status'), false);
  assert.deepEqual(logger.recent(), []);
  assert.equal(logger.status().lastError, 'LOG_READ_FAILED');
  assert.doesNotMatch(JSON.stringify(logger.status()), /PRIVATE/);
  t.mock.restoreAll();
  assert.equal(fs.opendirSync, original);
  t.mock.method(fs, 'writeFileSync', () => {
    throw Error('PRIVATE write information');
  });
  assert.equal(logger.log('worker.status'), false);
  assert.equal(logger.status().lastError, 'LOG_WRITE_FAILED');
  t.mock.restoreAll();
  assert.equal(logger.log('worker.status'), true);
  const invalid = new Diagnostics({ dataDir: 'relative/path' });
  t.after(() => invalid.close());
  assert.equal(invalid.status().directory, null);
  assert.equal(invalid.status().lastError, 'LOG_UNSAFE_PATH');
  assert.deepEqual(invalid.recent(), []);
  assert.equal(invalid.log('worker.status'), false);
});

test('log directory and ancestor junctions refuse writes and cleanup without touching their targets', (t) => {
  const { dataDir, logger } = setup(t);
  logger.close();
  fs.rmdirSync(defined(logger.directory));
  const outside = path.join(dataDir, 'outside');
  fs.mkdirSync(outside);
  const target = owned(outside, { at: epoch - 5 * DAY });
  fs.symlinkSync(
    outside,
    defined(logger.directory),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const blocked = new Diagnostics({ dataDir, now: () => epoch });
  t.after(() => blocked.close());
  assert.equal(blocked.status().lastError, 'LOG_UNSAFE_PATH');
  assert.equal(blocked.log('service.started'), false);
  assert.deepEqual(blocked.recent(), []);
  assert.equal(fs.existsSync(target), true);
  const linkedData = path.join(dataDir, 'redirected-data');
  fs.symlinkSync(outside, linkedData, process.platform === 'win32' ? 'junction' : 'dir');
  const ancestor = new Diagnostics({ dataDir: path.join(linkedData, 'child'), now: () => epoch });
  t.after(() => ancestor.close());
  assert.equal(ancestor.status().lastError, 'LOG_UNSAFE_PATH');
  assert.equal(fs.existsSync(path.join(outside, 'child')), false);
  assert.equal(fs.existsSync(target), true);
});

test('matching-name directory junctions and hard-linked log files are never followed or deleted', (t) => {
  const { dataDir, logger } = setup(t),
    outside = path.join(dataDir, 'outside');
  fs.mkdirSync(outside);
  const note = path.join(outside, 'keep.txt');
  fs.writeFileSync(note, 'outside');
  const linkedName = `dant-diagnostics-v1-2026-10-10-${randomUUID()}.jsonl`;
  fs.symlinkSync(
    outside,
    path.join(defined(logger.directory), linkedName),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const original = owned(outside, { at: epoch - 7 * DAY }),
    linked = path.join(defined(logger.directory), path.basename(original));
  fs.linkSync(original, linked);
  assert.equal(logger.cleanup(), true);
  assert.equal(fs.readFileSync(note, 'utf8'), 'outside');
  assert.equal(fs.existsSync(original), true);
  assert.equal(fs.existsSync(linked), true);
  assert.equal(logger.status().lastError, 'LOG_UNSAFE_FILE');
  assert.deepEqual(logger.recent(), []);
});

test('startup.log is truncated at its size/TTL boundary, retains its inode and an existing append handle remains valid', (t) => {
  const { dataDir, logger, clock } = setup(t, { startupLogMaxBytes: 128 }),
    file = path.join(dataDir, 'startup.log');
  fs.writeFileSync(file, 'initial contents exceeding limit'.repeat(10));
  const before = fs.statSync(file),
    fd = fs.openSync(file, 'a');
  t.after(() => fs.closeSync(fd));
  assert.equal(logger.cleanup(), true);
  const header = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(header), {
    schema: 'dant.startup.v1',
    createdAt: new Date(epoch).toISOString(),
  });
  assert.equal(fs.statSync(file).ino, before.ino);
  fs.writeSync(fd, 'next');
  assert.equal(fs.readFileSync(file, 'utf8'), header + 'next');
  clock.now += 3 * DAY;
  fs.utimesSync(file, new Date(clock.now), new Date(clock.now));
  assert.equal(logger.cleanup(), true);
  const nextHeader = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(nextHeader), {
    schema: 'dant.startup.v1',
    createdAt: new Date(clock.now).toISOString(),
  });
  fs.writeSync(fd, 'again');
  assert.equal(fs.readFileSync(file, 'utf8'), nextHeader + 'again');
  assert.equal(logger.cleanup(), true);
  assert.equal(fs.readFileSync(file, 'utf8'), nextHeader + 'again');
  const unrelated = path.join(dataDir, 'other.log');
  fs.writeFileSync(unrelated, 'unrelated log content');
  logger.cleanup();
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated log content');
});

test('ordinary appends never enumerate retained files, even with a hundred archived volumes', (t) => {
  const { logger, clock } = setup(t);
  for (let index = 0; index < 100; index++)
    owned(defined(logger.directory), { at: epoch - index - 1 });
  assert.equal(logger.cleanup(), true);
  assert.equal(logger.log('service.started'), true);
  const current = logger.current;
  let scans = 0;
  const original = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', (...args: Parameters<typeof fs.opendirSync>) => {
    scans++;
    return original(...args);
  });
  for (let index = 0; index < 80; index++) {
    clock.now++;
    assert.equal(logger.log('worker.status', { requestId: index }), true);
  }
  assert.equal(scans, 0);
  assert.equal(logger.current, current);
  assert.equal(logger.status().fileCount, 101);
  assert.equal(
    logger.status().totalBytes,
    files(logger).reduce((sum, file) => sum + fs.statSync(file).size, 0),
  );
  assert.equal(defined(logger.recent(1)[0]).requestId, 79);
  assert.equal(scans, 1);
});

test('an append quota boundary reconciles once and evicts old volumes before writing', (t) => {
  const { logger, clock } = setup(t, { maxFileBytes: 1000, maxTotalBytes: 1100 }),
    old = owned(defined(logger.directory), { at: epoch - 1, body: 'x'.repeat(350) + '\n' });
  assert.equal(logger.cleanup(), true);
  assert.equal(logger.log('service.started'), true);
  const current = logger.current;
  let scans = 0;
  const original = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', (...args: Parameters<typeof fs.opendirSync>) => {
    scans++;
    return original(...args);
  });
  for (let index = 0; index < 8; index++) {
    clock.now++;
    assert.equal(logger.log('worker.status', { requestId: index }), true);
    assert.ok(files(logger).reduce((sum, file) => sum + fs.statSync(file).size, 0) <= 1100);
  }
  assert.equal(fs.existsSync(old), false);
  assert.equal(logger.current, current);
  assert.equal(scans, 1);
  assert.equal(defined(logger.recent(1)[0]).requestId, 7);
});

test('deleted current files recover into a new validated volume and writes still enforce expiry without the timer', (t) => {
  const { logger, clock } = setup(t);
  logger.log('service.started');
  const original = path.join(defined(logger.directory), defined(logger.current));
  fs.unlinkSync(original);
  assert.equal(logger.log('worker.status', { status: 'online' }), true);
  assert.notEqual(path.join(defined(logger.directory), defined(logger.current)), original);
  assert.equal(logger.status().fileCount, 1);
  assert.equal(logger.recent().length, 1);
  clock.now += 3 * DAY;
  assert.equal(logger.log('service.started'), true);
  assert.equal(files(logger).length, 1);
  assert.equal(logger.recent().length, 1);
  assert.equal(defined(logger.recent()[0]).at, new Date(clock.now).toISOString());
});

test('partial append failures keep completed records, invalidate accounting and recover without a corrupt continuation', (t) => {
  const { logger, clock } = setup(t);
  logger.log('service.started');
  const original = path.join(defined(logger.directory), defined(logger.current)),
    write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    const [fd, bytes, ...rest] = args;
    if (typeof fd === 'number') {
      assert.ok(Buffer.isBuffer(bytes));
      write(fd, bytes.subarray(0, 12), ...rest);
      throw Error('PRIVATE append failure');
    }
    return write(fd, bytes, ...rest);
  });
  assert.equal(logger.log('worker.status'), false);
  assert.equal(logger.cacheReady, false);
  assert.equal(logger.current, null);
  assert.equal(logger.status().lastError, 'LOG_WRITE_FAILED');
  t.mock.restoreAll();
  clock.now++;
  assert.equal(logger.log('service.recovered'), true);
  assert.notEqual(path.join(defined(logger.directory), defined(logger.current)), original);
  assert.deepEqual(
    logger.recent().map((item) => item.event),
    ['service.started', 'service.recovered'],
  );
  assert.doesNotMatch(JSON.stringify(logger.status()), /PRIVATE/);
  assert.equal(
    logger.status().totalBytes,
    files(logger).reduce((sum, file) => sum + fs.statSync(file).size, 0),
  );
});

test('failed new-volume writes remove only their exclusive partial file and later recover', (t) => {
  const { logger } = setup(t),
    write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    const [fd, bytes, ...rest] = args;
    if (typeof fd === 'number') {
      assert.ok(Buffer.isBuffer(bytes));
      write(fd, bytes.subarray(0, 12), ...rest);
      throw Error('PRIVATE initial write failure');
    }
    return write(fd, bytes, ...rest);
  });
  assert.equal(logger.log('service.started'), false);
  assert.deepEqual(files(logger), []);
  assert.equal(logger.cacheReady, false);
  t.mock.restoreAll();
  assert.equal(logger.log('service.recovered'), true);
  assert.equal(defined(logger.recent()[0]).event, 'service.recovered');
});

test('cached append still rejects linked replacements and safely resumes in a different owned file', (t) => {
  const { logger, dataDir } = setup(t);
  logger.log('service.started');
  const current = path.join(defined(logger.directory), defined(logger.current)),
    outside = path.join(dataDir, 'outside.txt');
  fs.writeFileSync(outside, 'do not append');
  fs.unlinkSync(current);
  fs.linkSync(outside, current);
  assert.equal(logger.log('worker.status'), false);
  assert.equal(logger.status().lastError, 'LOG_UNSAFE_FILE');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not append');
  assert.equal(logger.log('service.recovered'), true);
  assert.notEqual(path.join(defined(logger.directory), defined(logger.current)), current);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not append');
});

test('startup retention marker survives append-refreshed mtime and repeated process restarts without truncating fresh contents', (t) => {
  const { dataDir, logger, clock } = setup(t),
    file = path.join(dataDir, 'startup.log');
  logger.close();
  fs.writeFileSync(file, 'old unmarked launcher stderr\n');
  fs.utimesSync(file, new Date(epoch - 10 * DAY), new Date(epoch - 10 * DAY));
  fs.appendFileSync(file, 'new launcher append refreshes mtime\n');
  const first = new Diagnostics({ dataDir, now: () => clock.now });
  t.after(() => first.close());
  const initial = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(initial).schema, 'dant.startup.v1');
  assert.doesNotMatch(initial, /old unmarked|new launcher/);
  first.close();
  clock.now += 2 * DAY;
  fs.appendFileSync(file, 'fresh retained stderr\n');
  fs.utimesSync(file, new Date(clock.now), new Date(clock.now));
  const second = new Diagnostics({ dataDir, now: () => clock.now });
  t.after(() => second.close());
  assert.equal(fs.readFileSync(file, 'utf8'), initial + 'fresh retained stderr\n');
  clock.now += DAY;
  fs.appendFileSync(file, 'launch refresh before expiry cleanup\n');
  fs.utimesSync(file, new Date(clock.now), new Date(clock.now));
  assert.equal(second.cleanup(), true);
  const renewed = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(renewed), {
    schema: 'dant.startup.v1',
    createdAt: new Date(clock.now).toISOString(),
  });
  second.close();
  clock.now += DAY;
  fs.appendFileSync(file, 'preserve after reset despite original birthtime\n');
  const third = new Diagnostics({ dataDir, now: () => clock.now });
  t.after(() => third.close());
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    renewed + 'preserve after reset despite original birthtime\n',
  );
});

test('startup.log junctions and hard links refuse truncation of any target', (t) => {
  const { dataDir, logger } = setup(t, { startupLogMaxBytes: 1 }),
    outside = path.join(dataDir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'do not change');
  fs.symlinkSync(
    outside,
    path.join(dataDir, 'startup.log'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(logger.cleanup(), false);
  assert.equal(logger.status().lastError, 'LOG_UNSAFE_FILE');
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'do not change');
  fs.unlinkSync(path.join(dataDir, 'startup.log'));
  const original = path.join(dataDir, 'original.log');
  fs.writeFileSync(original, 'do not truncate');
  fs.linkSync(original, path.join(dataDir, 'startup.log'));
  assert.equal(logger.cleanup(), false);
  assert.equal(fs.readFileSync(original, 'utf8'), 'do not truncate');
});

test('configuration cannot expand retention or storage above defaults, and oversized records fail safely', (t) => {
  const { logger } = setup(t, {
    maxTotalBytes: 100 * MiB,
    maxFileBytes: 20 * MiB,
    retentionDays: 30,
    startupLogMaxBytes: 5 * MiB,
    cleanupIntervalMs: 10 * DAY,
  });
  assert.equal(logger.status().maxTotalBytes, 50 * MiB);
  assert.equal(logger.status().maxFileBytes, 5 * MiB);
  assert.equal(logger.status().retentionDays, 3);
  assert.equal(logger.status().startupLogMaxBytes, MiB);
  assert.equal(logger.status().cleanupIntervalMs, DAY);
  const small = setup(t, { maxFileBytes: 256, maxTotalBytes: 256 }).logger;
  assert.equal(
    small.log('worker.status', { threadId: 't'.repeat(128), turnId: 't'.repeat(128) }),
    false,
  );
  assert.equal(small.status().lastError, 'LOG_RECORD_TOO_LARGE');
  assert.deepEqual(files(small), []);
});

test('timer creation/cancellation and clock failures never escape into the application', (t) => {
  const dataDir = fs.mkdtempSync(path.join(root, 'diagnostics-timer-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logger = new Diagnostics({
    dataDir,
    now: () => {
      throw Error('PRIVATE clock');
    },
    schedule: () => {
      throw Error('PRIVATE timer');
    },
  });
  assert.equal(logger.status().lastError, 'LOG_TIMER_FAILED');
  assert.equal(logger.log('service.started'), true);
  logger.close();
  const cancel = new Diagnostics({
    dataDir,
    cancel: () => {
      throw Error('PRIVATE cancel');
    },
  });
  cancel.close();
  assert.equal(cancel.status().lastError, 'LOG_TIMER_FAILED');
  assert.equal(cancel.status().closed, true);
  assert.doesNotMatch(JSON.stringify(cancel.status()), /PRIVATE/);
});

test('service versions accept bounded semantic versions only and unknown routes use the fixed template', (t) => {
  const { logger } = setup(t, { version: '0.4.4' });
  assert.equal(logger.status().version, '0.4.4');
  assert.equal(logger.log('service.started', { version: '0.0.1' }), true);
  assert.equal(defined(logger.recent()[0]).version, '0.4.4');
  for (const version of [
    '0.4',
    'v0.4.4',
    '00.4.4',
    '0.4.4-01',
    '0.4.4 secret',
    'sk-test-secret',
    '0.4.4+' + 'x'.repeat(70),
  ]) {
    const other = setup(t, { version }).logger;
    assert.equal(other.status().version, null);
    other.log('service.started', { version });
    assert.equal(Object.hasOwn(defined(other.recent()[0]), 'version'), false);
  }
  const prerelease = setup(t, { version: '1.2.3-beta.1+build.5' }).logger;
  assert.equal(prerelease.status().version, '1.2.3-beta.1+build.5');
  assert.equal(
    prerelease.log('http.error', { route: '/api/:unknown', method: 'GET', status: 404 }),
    true,
  );
  assert.equal(defined(prerelease.recent()[0]).route, '/api/:unknown');
});
