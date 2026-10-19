import { defined } from '../support/fixture-assertions.mts';
import { observedRecord } from '../support/service-fixtures.mts';
import { operationError } from '../../src/runtime/errors.mts';
import type { TranscriptionSpawn } from '../../src/voice/audio-transcription.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from '../../src/files/attachments.mts';
import { AudioTranscriber } from '../../src/voice/audio-transcription.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const wav = Buffer.alloc(44);
wav.write('RIFF');
wav.write('WAVE', 8);
const result = { text: 'Open my work computer.', language: 'en', duration: 3.2 };
class Child extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kills: Array<NodeJS.Signals | undefined>;
  closeOnKill: boolean;
  constructor({ closeOnKill = true } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
    this.closeOnKill = closeOnKill;
  }
  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
  complete(value: unknown = result, code = 0, error = '') {
    if (value !== undefined)
      this.stdout.write(
        typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
      );
    if (error) this.stderr.write(error);
    this.emit('close', code);
  }
}
function fixture(
  t: NodeTestContext,
  options: NonNullable<ConstructorParameters<typeof AudioTranscriber>[0]> = {},
) {
  const home = fs.mkdtempSync(path.join(base, 'audio-transcription-')),
    attachments = new AttachmentStore(path.join(home, 'attachments')),
    calls: Array<{ args: Parameters<TranscriptionSpawn>; child: Child }> = [];
  const attachment = attachments.put({ name: 'message.wav', type: 'audio/wav', data: wav });
  const service = new AudioTranscriber({
    attachments,
    home,
    platform: 'linux',
    spawnImpl: (...args) => {
      const child = new Child();
      calls.push({ args, child });
      return child;
    },
    ...options,
  });
  t.after(() => {
    assert.ok(path.relative(base, home) && !path.relative(base, home).startsWith('..'));
    assert.equal(fs.lstatSync(home).isSymbolicLink(), false);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, attachments, attachment, service, calls };
}

test('recognition runs in an isolated local process and feeds original bytes, preserving English and Chinese', async (t) => {
  for (const expected of [result, { text: '请打开工作电脑。', language: 'zh', duration: 2 }]) {
    let invocation:
      | { command: string; args: readonly string[]; options: Parameters<TranscriptionSpawn>[2] }
      | undefined;
    const f = fixture(t, {
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        const script = `const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{const b=Buffer.concat(chunks);if(b.length!==44||b.toString('ascii',0,4)!=='RIFF')process.exit(2);process.stdout.write(${JSON.stringify(JSON.stringify(expected))});});`;
        return spawn(process.execPath, ['-e', script], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: options.env,
          windowsHide: true,
        });
      },
    });
    assert.deepEqual(
      await f.service.transcribe({
        ...f.attachment,
        guestPath: 'untrusted;$(path)',
        path: 'untrusted',
      }),
      expected,
    );
    assert.equal(
      defined(invocation).command,
      path.join(f.home, 'dant/runtime/transcription/venv/bin/python'),
    );
    assert.deepEqual(defined(invocation).args, [
      path.join(f.home, 'dant/vm/transcribe_audio.py'),
      '--model-dir',
      path.join(f.home, 'dant/runtime/transcription/model'),
    ]);
    assert.equal(defined(invocation).options.shell, false);
    assert.equal(defined(invocation).options.windowsHide, true);
    assert.equal(defined(defined(invocation).options.env).HF_HUB_OFFLINE, '1');
    assert.equal(defined(defined(invocation).options.env).OMP_NUM_THREADS, '2');
    assert.equal(defined(defined(invocation).options.env).CUDA_VISIBLE_DEVICES, '');
    assert.equal(defined(defined(invocation).options.env).CODEX_HOME, undefined);
    assert.equal(defined(defined(invocation).options.env).OPENAI_API_KEY, undefined);
    assert.equal(defined(defined(invocation).options.env).DANT_CREDENTIAL_BRIDGE_TOKEN, undefined);
    assert.deepEqual(f.attachments.read(f.attachment.id).data, wav);
  }
});

test('Windows and macOS cannot start VM recognition', async (t) => {
  for (const platform of ['win32', 'darwin'] as const) {
    const f = fixture(t, { platform });
    await assert.rejects(f.service.transcribe(f.attachment), /only inside the Linux VM/);
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() => new AudioTranscriber({ timeoutMs: 0 }), /timeout/);
  assert.throws(() => new AudioTranscriber({ timeoutMs: Infinity }), /timeout/);
});

test('managed WAV, WebM, Ogg, and MP3 audio all use the same recognition path', async (t) => {
  const f = fixture(t);
  for (const [type, data] of [
    ['audio/wav', wav],
    ['audio/webm', Buffer.from([26, 69, 223, 163, 0])],
    ['audio/ogg', Buffer.from('OggS fixture')],
    ['audio/mpeg', Buffer.from('ID3 fixture')],
  ]) {
    const attachment = f.attachments.put({ name: 'recording', type, data }),
      pending = f.service.transcribe(attachment);
    await nextTurn();
    const child = defined(f.calls.at(-1)).child;
    const chunks = [];
    for await (const chunk of child.stdin) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), data);
    child.complete();
    assert.deepEqual(await pending, result);
  }
});

test('audio validation rereads managed metadata and rejects missing, forged, changed, or nonaudio content', async (t) => {
  type Fixture = ReturnType<typeof fixture>;
  const mutations: Array<(f: Fixture) => { id: string }> = [
    (_f) => ({ id: '../../private' }),
    (_f) => ({ id: '00000000-0000-0000-0000-000000000000' }),
    (f) => {
      const b = Buffer.from(wav);
      b[20] = 1;
      fs.writeFileSync(f.attachment.guestPath, b);
      return f.attachment;
    },
    (f) => f.attachments.put({ name: 'not-audio.txt', data: Buffer.from('private plain text') }),
    (f) => {
      const name = path.join(f.attachments.dir, f.attachment.id + '.json');
      const meta = observedRecord(JSON.parse(fs.readFileSync(name, 'utf8')));
      meta.type = 'audio/ogg';
      fs.writeFileSync(name, JSON.stringify(meta));
      return f.attachment;
    },
    (f) => {
      fs.writeFileSync(f.attachment.guestPath, Buffer.alloc(45));
      return f.attachment;
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    await assert.rejects(
      f.service.transcribe(mutate(f)),
      /^Error: Audio attachment is missing or invalid\.$/,
    );
    assert.equal(f.calls.length, 0);
  }
});

test('managed reader prevents recognition from following symbolic links or multiply linked audio', async (t) => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = fixture(t),
      outside = path.join(f.home, 'outside.wav');
    fs.writeFileSync(outside, wav);
    fs.unlinkSync(f.attachment.guestPath);
    if (kind === 'symlink') fs.symlinkSync(outside, f.attachment.guestPath, 'file');
    else fs.linkSync(outside, f.attachment.guestPath);
    await assert.rejects(f.service.transcribe(f.attachment), /missing or invalid/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readFileSync(outside), wav);
  }
});

test('even a faulty attachment reader cannot bypass audio hash, size, ID, and media validation', async (t) => {
  const good = fixture(t);
  const stored = good.attachments.read(good.attachment.id);
  for (const changed of [
    { ...stored, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) },
    { ...stored, data: Buffer.alloc(0) },
    { ...stored, data: 'not a buffer' },
    { ...stored, meta: { ...stored.meta, id: 'different' } },
    { ...stored, meta: { ...stored.meta, size: 1 } },
    { ...stored, meta: { ...stored.meta, hash: '0'.repeat(64) } },
    { ...stored, meta: { ...stored.meta, type: 'audio/mpeg' } },
  ]) {
    const f = fixture(t, {
      attachments: {
        read() {
          return changed;
        },
      },
    });
    await assert.rejects(f.service.transcribe(good.attachment), /missing or invalid/);
    assert.equal(f.calls.length, 0);
  }
});

test('invalid recognition output fails safely instead of becoming model input', async (t) => {
  for (const value of [
    'not JSON',
    '[]',
    'null',
    {},
    { ...result, text: 1 },
    { ...result, text: '\u0000private' },
    { ...result, language: '' },
    { ...result, language: 'English / private' },
    { ...result, language: 'zh-' + 'a'.repeat(40) },
    { ...result, duration: null },
    { ...result, duration: 0 },
    { ...result, duration: -1 },
    { ...result, duration: 601 },
    Buffer.from([0xff, 0xfe]),
  ]) {
    const f = fixture(t),
      pending = f.service.transcribe(f.attachment);
    await nextTurn();
    defined(f.calls[0]).child.complete(value);
    await assert.rejects(pending, /returned an invalid result/);
  }
  const f = fixture(t),
    pending = f.service.transcribe(f.attachment);
  await nextTurn();
  defined(f.calls[0]).child.complete({ ...result, text: ' \n ' });
  await assert.rejects(pending, /No speech was detected/);
});

test('fixed Python failure codes are translated without exposing stderr or arbitrary error text', async (t) => {
  const reasons = {
    no_speech: /No speech/,
    invalid_audio: /could not be decoded/,
    too_long: /at most 10 minutes/,
    unavailable: /unavailable/,
    failed: /failed/,
  };
  for (const [error, pattern] of Object.entries(reasons)) {
    const f = fixture(t),
      pending = f.service.transcribe(f.attachment);
    await nextTurn();
    defined(f.calls[0]).child.complete(
      undefined,
      1,
      JSON.stringify({ error, private: 'never surface' }),
    );
    await assert.rejects(pending, pattern);
  }
  for (const stderr of [
    'personal transcript and secret',
    { error: '__proto__', private: 'secret' },
    { error: 'constructor' },
    { error: 'unknown private words' },
  ]) {
    const f = fixture(t),
      pending = f.service.transcribe(f.attachment);
    await nextTurn();
    defined(f.calls[0]).child.complete(
      undefined,
      1,
      typeof stderr === 'string' ? stderr : JSON.stringify(stderr),
    );
    await assert.rejects(
      pending,
      (error) => operationError(error).message === 'Audio recognition failed in the VM.',
    );
  }
});

test('large stderr is drained and discarded, while split UTF-8 stdout remains valid', async (t) => {
  const f = fixture(t),
    pending = f.service.transcribe(f.attachment);
  await nextTurn();
  const child = defined(f.calls[0]).child;
  child.stderr.write(Buffer.alloc(100000, 65));
  const data = Buffer.from(JSON.stringify({ ...result, text: '你好，dant。', language: 'zh' }));
  for (const byte of data) child.stdout.write(Buffer.from([byte]));
  child.emit('close', 0);
  assert.deepEqual(await pending, { ...result, text: '你好，dant。', language: 'zh' });
  const f2 = fixture(t),
    failed = f2.service.transcribe(f2.attachment);
  await nextTurn();
  defined(f2.calls[0]).child.complete(undefined, 1, 'x'.repeat(10000));
  await assert.rejects(failed, /recognition failed/);
});

test('requests serialize and only start the next child after the previous close', async (t) => {
  const f = fixture(t),
    one = f.service.transcribe(f.attachment),
    two = f.service.transcribe(f.attachment);
  await nextTurn();
  assert.equal(f.calls.length, 1);
  defined(f.calls[0]).child.complete();
  await one;
  await nextTurn();
  assert.equal(f.calls.length, 2);
  defined(f.calls[1]).child.complete({ ...result, text: 'Second' });
  assert.equal((await two).text, 'Second');
});

test('queued cancellation rejects promptly and never starts a recognizer for that job', async (t) => {
  const f = fixture(t),
    one = f.service.transcribe(f.attachment),
    controller = new AbortController(),
    two = f.service.transcribe(f.attachment, { signal: controller.signal });
  await nextTurn();
  controller.abort('private reason');
  await assert.rejects(
    two,
    (error) =>
      operationError(error).name === 'AbortError' &&
      !operationError(error).message.includes('private'),
  );
  assert.equal(f.calls.length, 1);
  defined(f.calls[0]).child.complete();
  await one;
  await nextTurn();
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.transcribe(f.attachment, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(f.calls.length, 1);
});

test('active cancellation waits for confirmed process close before allowing the next job', async (t) => {
  const child = new Child({ closeOnKill: false }),
    children: Child[] = [];
  const f = fixture(t, {
      spawnImpl: () => {
        const value = children.length ? new Child() : child;
        children.push(value);
        return value;
      },
    }),
    controller = new AbortController();
  let settled = false;
  const one = f.service.transcribe(f.attachment, { signal: controller.signal }).finally(() => {
      settled = true;
    }),
    failure = assert.rejects(one, { name: 'AbortError' }),
    two = f.service.transcribe(f.attachment);
  await nextTurn();
  controller.abort();
  await nextTurn();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(settled, false);
  assert.equal(children.length, 1);
  child.emit('close', null, 'SIGTERM');
  await failure;
  await nextTurn();
  assert.equal(children.length, 2);
  defined(children[1]).complete();
  await two;
});

test('timeout escalates to SIGKILL and still waits for close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new Child({ closeOnKill: false });
  const f = fixture(t, { spawnImpl: () => child, timeoutMs: 10 }),
    pending = f.service.transcribe(f.attachment),
    failure = assert.rejects(pending, /timed out/);
  await nextTurn();
  t.mock.timers.tick(10);
  assert.deepEqual(child.kills, ['SIGTERM']);
  t.mock.timers.tick(1000);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null, 'SIGKILL');
  await failure;
});

test('unconfirmed shutdown blocks later jobs instead of starting overlapping model processes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  const child = new Child({ closeOnKill: false });
  const f = fixture(t, {
      spawnImpl: () => {
        starts++;
        return child;
      },
      timeoutMs: 10,
    }),
    pending = f.service.transcribe(f.attachment),
    failure = assert.rejects(pending, /did not confirm shutdown/);
  await nextTurn();
  t.mock.timers.tick(10);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await failure;
  await assert.rejects(f.service.transcribe(f.attachment), /did not confirm shutdown/);
  assert.equal(starts, 1);
  child.emit('close', null, 'SIGKILL');
});

test('oversized stdout terminates the owned recognizer without returning partial speech', async (t) => {
  const f = fixture(t),
    pending = f.service.transcribe(f.attachment),
    failure = assert.rejects(pending, /invalid result/);
  await nextTurn();
  const child = defined(f.calls[0]).child;
  child.stdout.write(Buffer.alloc(128 * 1024 + 1, 65));
  await failure;
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('service shutdown cancels queued and active recognition, waits for close, and refuses new jobs', async (t) => {
  const child = new Child({ closeOnKill: false }),
    f = fixture(t, { spawnImpl: () => child });
  const one = f.service.transcribe(f.attachment),
    oneFailure = assert.rejects(one, { name: 'AbortError' }),
    two = f.service.transcribe(f.attachment),
    twoFailure = assert.rejects(two, { name: 'AbortError' });
  await nextTurn();
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await twoFailure;
  await nextTurn();
  assert.equal(closed, false);
  assert.deepEqual(child.kills, ['SIGTERM']);
  await assert.rejects(f.service.transcribe(f.attachment), /has stopped/);
  child.emit('close', null, 'SIGTERM');
  await oneFailure;
  await closing;
  assert.equal(closed, true);
  await f.service.close();
});

test('missing runtime and stdin failures expose only safe errors and leave the queue usable', async (t) => {
  const f = fixture(t, {
    spawnImpl: () => {
      throw Error('secret path');
    },
  });
  await assert.rejects(
    f.service.transcribe(f.attachment),
    (error) =>
      operationError(error).message.includes('unavailable') &&
      !operationError(error).message.includes('secret'),
  );
  const second = fixture(t),
    pending = second.service.transcribe(second.attachment),
    failure = assert.rejects(pending, /unavailable/);
  await nextTurn();
  defined(second.calls[0]).child.emit(
    'error',
    Object.assign(Error('secret path'), { code: 'ENOENT' }),
  );
  await failure;
  const broken = second.service.transcribe(second.attachment),
    brokenFailure = assert.rejects(broken, /recognition failed/);
  await nextTurn();
  defined(second.calls[1]).child.stdin.emit('error', Error('private'));
  await brokenFailure;
  const next = second.service.transcribe(second.attachment);
  await nextTurn();
  defined(second.calls[2]).child.complete();
  assert.deepEqual(await next, result);
});
