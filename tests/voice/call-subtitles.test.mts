import { WorkerServiceFixture } from '../support/service-fixtures.mts';
import { readRpcEvent } from '../../src/runtime/rpc-values.mts';
import type { RpcParams, RpcResult, RpcEvent } from '../../src/runtime/protocol.ts';
type SubtitleEvent = Parameters<
  NonNullable<Parameters<typeof createSpokenSubtitles>[0]['emit']>
>[0];
import { defined } from '../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSpokenSubtitles } from '../../src/voice/call-subtitles.mts';
import {
  redactCredentialText,
  CredentialVault,
  CredentialRequests,
} from '../../src/security/credentials.mts';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { Voice } from '../../src/voice/voice.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const delta = (response = 'response-a', text = 'Hello', extra = {}) => ({
  type: 'response.output_audio_transcript.delta',
  response_id: response,
  item_id: 'assistant-a',
  output_index: 0,
  content_index: 0,
  delta: text,
  ...extra,
});
const created = (id: string) => ({ type: 'response.created', response: { id } });
function pure(options: Partial<Parameters<typeof createSpokenSubtitles>[0]> = {}) {
  const events: SubtitleEvent[] = [],
    captions = createSpokenSubtitles({
      callId: 'call-a',
      provider: 'api',
      emit: (event) => events.push(event),
      ...options,
    });
  return { captions, events };
}

test('native captions retain one assistant utterance, replace final text, and never publish user or reference data', () => {
  const { captions, events } = pure({ provider: 'subscription' });
  captions.native('thread/realtime/transcript/delta', { role: 'assistant', delta: '你好，' });
  captions.native('thread/realtime/transcript/delta', { role: 'assistant', delta: '我在检查。' });
  assert.equal(captions.snapshot.text, '你好，我在检查。');
  captions.native('thread/realtime/transcript/done', {
    role: 'assistant',
    text: '你好，我已经检查好了。',
  });
  assert.equal(captions.snapshot.final, true);
  captions.native('thread/realtime/transcript/delta', { role: 'assistant', delta: '接下来' });
  assert.equal(captions.snapshot.text, '接下来');
  captions.native('thread/realtime/itemAdded', { role: 'assistant', text: 'Private history' });
  captions.native('thread/realtime/transcript/done', {
    role: 'system',
    text: 'Private system context',
  });
  captions.native('thread/realtime/transcript/done', { role: 'user', text: 'Private user speech' });
  assert.equal(captions.snapshot.text, '');
  assert.doesNotMatch(JSON.stringify(events), /Private/);
  assert.ok(
    events.every(
      (event) =>
        Object.keys(event.params).sort().join(',') === 'callId,final,provider,sequence,text',
    ),
  );
});

test('API captions ignore missing, cancelled, retired and out-of-order response parts', () => {
  const { captions, events } = pure();
  captions.api(delta());
  captions.api({
    type: 'response.created',
    response: { id: 'private-oob', conversation_id: null },
  });
  captions.api(delta('private-oob', 'Private hidden response'));
  assert.equal(events.length, 0);
  captions.api(created('response-a'));
  captions.api(delta());
  assert.equal(captions.snapshot.text, 'Hello');
  captions.api({
    type: 'conversation.item.done',
    item: { role: 'assistant', content: [{ transcript: 'Private historical speech' }] },
  });
  captions.api({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Private user speech',
  });
  captions.api({
    type: 'response.output_audio_transcript.done',
    response_id: 'response-a',
    item_id: 'assistant-a',
    transcript: 'Hello there',
  });
  captions.api(delta('response-a', ' late'));
  assert.equal(captions.snapshot.text, 'Hello there');
  captions.api(created('response-b'));
  captions.api(delta('response-a', 'stale'));
  assert.equal(captions.snapshot.text, '');
  captions.api(delta('response-b', 'New second part', { content_index: 1 }));
  captions.api(delta('response-b', 'Old first part', { content_index: 0 }));
  assert.equal(captions.snapshot.text, 'New second part');
  captions.api({ type: 'response.done', response: { id: 'response-a', status: 'cancelled' } });
  assert.equal(captions.snapshot.text, 'New second part');
  captions.api({ type: 'response.done', response: { id: 'response-b', status: 'cancelled' } });
  assert.equal(captions.snapshot.text, '');
  captions.api(created('response-b'));
  captions.api(delta('response-b', 'retired'));
  assert.equal(captions.snapshot.text, '');
  assert.doesNotMatch(JSON.stringify(events), /Private|stale|Old first|retired/);
});

test('speech interruption and truncation clear the current API caption without reopening a response', () => {
  const { captions } = pure();
  captions.api(created('a'));
  captions.api(delta('a', 'Speaking'));
  captions.api({ type: 'input_audio_buffer.speech_started' });
  captions.api(delta('a', ' late'));
  assert.equal(captions.snapshot.text, '');
  captions.api(created('b'));
  captions.api({ ...delta('b', 'Current'), type: 'response.audio_transcript.delta' });
  assert.equal(captions.snapshot.text, 'Current');
  captions.api({ type: 'conversation.item.truncated', item_id: 'other' });
  assert.equal(captions.snapshot.text, 'Current');
  captions.api({ type: 'conversation.item.truncated', item_id: 'assistant-a' });
  captions.api(delta('b', ' late'));
  assert.equal(captions.snapshot.text, '');
});

test('current subtitles stay bounded and fail closed if credential redaction is unavailable', () => {
  const { captions } = pure();
  captions.native('thread/realtime/transcript/delta', {
    role: 'assistant',
    delta: 'x'.repeat(100000) + 'TAIL',
  });
  assert.equal(captions.snapshot.text.length, 4000);
  assert.ok(captions.snapshot.text.endsWith('TAIL'));
  const failed = pure({
    redact: () => {
      throw Error('Vault unavailable');
    },
  });
  failed.captions.native('thread/realtime/transcript/done', {
    role: 'assistant',
    text: 'secret speech',
  });
  assert.equal(failed.captions.snapshot.text, '');
  assert.doesNotMatch(JSON.stringify(failed.events), /secret speech|Vault unavailable/);
});

test('credential streaming redaction hides full values and matching partial prefixes while preserving ordinary redaction', () => {
  const secret = 'synthetic-subtitle-secret-123';
  assert.equal(redactCredentialText('Value: ' + secret, [secret]), 'Value: [credential redacted]');
  assert.equal(
    redactCredentialText('Value: synthetic-subtitle', [secret]),
    'Value: synthetic-subtitle',
  );
  assert.equal(
    redactCredentialText('Value: synthetic-subtitle', [secret], { partial: true }),
    'Value: [credential redacted]',
  );
  assert.equal(redactCredentialText('hello world', [secret], { partial: true }), 'hello world');
  assert.equal(
    redactCredentialText('abcd '.repeat(30000) + 'synthetic-subtitle', [secret], {
      partial: true,
    }).endsWith('[credential redacted]'),
    true,
  );
  const { captions, events } = pure({
    redact: (text) => redactCredentialText(text, [secret], { partial: true }),
  });
  captions.api(created('a'));
  captions.api(delta('a', 'Value: synthetic-subtitle'));
  captions.api(delta('a', '-secret-123'));
  assert.ok(events.every((event) => !event.params.text.includes('synthetic-subtitle')));
});

test('native subtitle events stay call scoped and sanitized without saving chat or transcript history', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'subtitle-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  class Worker extends WorkerServiceFixture {
    calls: Array<{ method: string; params: RpcParams }> = [];
    constructor() {
      super();
      this.status = 'online';
      this.calls = [];
    }
    override async request(method: string, params: RpcParams = {}): Promise<RpcResult> {
      this.calls.push({ method, params });
      const emit = (method: string, params: Record<string, unknown> = {}) =>
        this.emit('event', { method, params: { threadId: 'thread', ...params } });
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'thread/realtime/start')
        queueMicrotask(() => {
          emit('thread/realtime/started', {
            version: 'v3',
            realtimeSessionId: 'rt-' + String(params.voiceSessionId),
          });
          emit('thread/realtime/sdp', { sdp });
        });
      if (method === 'thread/realtime/stop') queueMicrotask(() => emit('thread/realtime/closed'));
      if (method === 'thread/read')
        return { thread: { id: 'thread', status: { type: 'idle' }, turns: [] } };
      return {};
    }
    async terminateConfirmed(): Promise<never> {
      assert.fail('Subtitles cannot stop the executor');
    }
  }
  const store = new Store(dir),
    worker = new Worker(),
    vault = new CredentialVault({ dataDir: dir }),
    credentials = new CredentialRequests({ vault });
  credentials.upsert({ name: 'Test value', secret: 'synthetic-private-subtitle' });
  const engine = new Engine(store, worker, { credentials }),
    voice = new NativeRealtimeVoice({
      worker,
      engine,
      connectTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    }),
    events: RpcEvent[] = [];
  engine.on('realtime', (value) => {
    const event = readRpcEvent(value);
    assert.ok(event);
    events.push(event);
  });
  const before = JSON.stringify(store.state.messages),
    call = await engine.startCall(sdp),
    send = (method: string, params: Record<string, unknown>) =>
      engine.handle({ method, params: { threadId: 'thread', ...params } });
  await send('thread/realtime/transcript/delta', {
    role: 'assistant',
    delta: 'Value: synthetic-private',
  });
  await send('thread/realtime/transcript/delta', { role: 'assistant', delta: '-subtitle' });
  assert.ok(events.some((event) => event.params.text === 'Value: [credential redacted]'));
  await send('thread/realtime/transcript/done', { role: 'user', text: 'Private user transcript' });
  await send('thread/realtime/transcript/done', {
    role: 'assistant',
    text: 'Foreign call speech',
    callId: 'old-call',
  });
  await send('thread/realtime/transcript/done', {
    threadId: 'foreign',
    role: 'assistant',
    text: 'Foreign thread speech',
  });
  assert.doesNotMatch(JSON.stringify(events), /synthetic-private|Private user|Foreign/);
  const saved = events.filter((event) => event.method === 'dant/call/subtitle');
  assert.ok(saved.length);
  assert.ok(saved.every((event) => event.params.callId === call.callId));
  assert.equal(JSON.stringify(store.state.messages), before);
  assert.equal((store.state.voiceHistory || []).length, 0);
  assert.doesNotMatch(JSON.stringify(voice.state), /subtitle|Private user/);
  await engine.stopCall(call.callId);
  const length = events.length;
  await send('thread/realtime/transcript/done', { role: 'assistant', text: 'Late speech' });
  assert.equal(events.length, length);
  assert.equal(
    worker.calls.some((call) => ['turn/start', 'turn/steer'].includes(call.method)),
    false,
  );
});

test('API voice exposes only sanitized live audio captions and stops publishing after call closure', async (t) => {
  const sockets: Socket[] = [],
    events: SubtitleEvent[] = [],
    key = 'sk-proj-fake-subtitle-key';
  class Socket extends EventEmitter {
    readyState: number;
    constructor() {
      super();
      this.readyState = 1;
      sockets.push(this);
      queueMicrotask(() => this.emit('open'));
    }
    terminate(): never {
      throw Error('Unexpected socket termination');
    }
    send(_value: string, callback?: (error?: Error) => void) {
      callback?.();
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }
  }
  const voice = new Voice({
    getKey: () => key,
    runTask: async () => assert.fail('Captions cannot start tasks'),
    tool: async () => assert.fail('Captions cannot execute tools'),
    context: 'Private historical context',
    redactSubtitle: (text, additionalSecrets) =>
      redactCredentialText(text, ['synthetic-vault-secret', ...additionalSecrets], {
        partial: true,
      }),
    WebSocketImpl: Socket,
    fetchImpl: async (url) =>
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : new Response(sdp, {
            status: 201,
            headers: { Location: '/v1/realtime/calls/rtc_subtitles' },
          }),
  });
  t.after(() => voice.close());
  voice.on('subtitle', (event) => events.push(event));
  await voice.start({ sdp, callId: 'api-call' });
  const send = (event: unknown) =>
    defined(sockets[0]).emit('message', Buffer.from(JSON.stringify(event)));
  send(created('a'));
  send(delta('a', 'Invalid caption output order', { output_index: 'invalid' }));
  send(delta('a', 'Invalid caption content order', { content_index: -1 }));
  assert.equal(
    events.length,
    0,
    'invalid external ordering must never default to an accepted caption',
  );
  send(delta('a', 'Known synthetic-vault'));
  send(delta('a', '-secret; ' + key));
  send({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Private user transcript',
  });
  assert.ok(events.length);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-vault|sk-proj-fake|Private/);
  assert.ok(
    events.every((event) => event.params.callId === 'api-call' && event.params.provider === 'api'),
  );
  await voice.stop();
  const count = events.length;
  send(created('b'));
  send(delta('b', 'Late speech'));
  assert.equal(events.length, count);
  assert.doesNotMatch(JSON.stringify(voice.state), /Known|subtitle|Private/);
});

test('vault and call credentials are redacted together longest first for full and partial overlaps in either direction', () => {
  for (const [stored, scoped] of [
    ['sk-proj', 'sk-proj-api-long-private-tail'],
    ['sk-proj-vault-long-private-tail', 'sk-proj'],
    ['private-middle', 'sk-proj-private-middle-private-tail'],
  ] as const) {
    const vault = new CredentialVault({ dataDir: base });
    Reflect.set(vault, 'read', () => [{ secret: stored }]);
    const credentials = new CredentialRequests({ vault }),
      longest = [stored, scoped].sort((a, b) => defined(b).length - defined(a).length)[0];
    assert.equal(
      credentials.redact(longest, { partial: true, additionalSecrets: [scoped] }),
      '[credential redacted]',
    );
    assert.equal(
      credentials.redact(defined(longest).slice(0, -5), {
        partial: true,
        additionalSecrets: [scoped],
      }),
      '[credential redacted]',
    );
    assert.equal(
      credentials.redact('Value: ' + longest + '; done', {
        partial: true,
        additionalSecrets: [scoped],
      }),
      'Value: [credential redacted]; done',
    );
  }
});

test('actual API caption events cannot leak overlapping vault or API key suffixes after full or partial frames', async (t) => {
  for (const [stored, key] of [
    ['sk-proj', 'sk-proj-api-long-private-tail'],
    ['sk-proj-vault-long-private-tail', 'sk-proj'],
    ['private-middle', 'sk-proj-private-middle-private-tail'],
  ] as const) {
    const vault = new CredentialVault({ dataDir: base });
    Reflect.set(vault, 'read', () => [{ secret: stored }]);
    const credentials = new CredentialRequests({ vault }),
      sockets: Socket[] = [],
      events: RpcEvent[] = [];
    class Socket extends EventEmitter {
      readyState: number;
      constructor() {
        super();
        this.readyState = 1;
        sockets.push(this);
        queueMicrotask(() => this.emit('open'));
      }
      terminate(): never {
        throw Error('Unexpected socket termination');
      }
      send(_value: string, callback?: (error?: Error) => void) {
        callback?.();
      }
      close() {
        this.readyState = 3;
        queueMicrotask(() => this.emit('close'));
      }
    }
    const voice = new Voice({
      getKey: () => key,
      runTask: async () => assert.fail('Caption started a task'),
      tool: async () => assert.fail('Caption called a tool'),
      redactSubtitle: (text, additionalSecrets) =>
        credentials.redact(text, { partial: true, additionalSecrets }),
      WebSocketImpl: Socket,
      fetchImpl: async (url) =>
        String(url).endsWith('/hangup')
          ? new Response(null, { status: 204 })
          : new Response(sdp, {
              status: 201,
              headers: { Location: '/v1/realtime/calls/rtc_overlap' },
            }),
    });
    t.after(() => voice.close());
    voice.on('subtitle', (event) => events.push(event));
    await voice.start({ sdp, callId: 'overlap-call' });
    const send = (event: unknown) =>
        defined(sockets[0]).emit('message', Buffer.from(JSON.stringify(event))),
      longest = [stored, key].sort((a, b) => defined(b).length - defined(a).length)[0];
    send(created('partial'));
    send(delta('partial', defined(longest).slice(0, -5)));
    send(delta('partial', defined(longest).slice(-5)));
    send({
      type: 'response.output_audio_transcript.done',
      response_id: 'partial',
      item_id: 'assistant-a',
      transcript: longest,
    });
    assert.ok(events.length >= 2);
    for (const event of events) {
      assert.equal(event.params.text, '[credential redacted]');
      assert.equal(JSON.stringify(event).includes(defined(longest).slice(-5)), false);
    }
    events.length = 0;
    send(created('full'));
    send(delta('full', longest));
    assert.ok(events.some((event) => event.params.text === '[credential redacted]'));
    assert.ok(
      events.every(
        (event) => event.params.text === '' || event.params.text === '[credential redacted]',
      ),
    );
    await voice.stop();
  }
});

test('API captions redact their scoped key without an injected vault callback', async (t) => {
  const key = 'sk-proj-default-redaction-secret',
    sockets: Socket[] = [],
    events: RpcEvent[] = [];
  class Socket extends EventEmitter {
    readyState: number;
    constructor() {
      super();
      this.readyState = 1;
      sockets.push(this);
      queueMicrotask(() => this.emit('open'));
    }
    terminate(): never {
      throw Error('Unexpected socket termination');
    }
    send(_value: string, callback?: (error?: Error) => void) {
      callback?.();
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }
  }
  const voice = new Voice({
    getKey: () => key,
    runTask: async () => {},
    tool: async () => {},
    WebSocketImpl: Socket,
    fetchImpl: async (url) =>
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : new Response(sdp, {
            status: 201,
            headers: { Location: '/v1/realtime/calls/rtc_default_redaction' },
          }),
  });
  t.after(() => voice.close());
  voice.on('subtitle', (event) => events.push(event));
  await voice.start({ sdp, callId: 'default-call' });
  const send = (event: unknown) =>
    defined(sockets[0]).emit('message', Buffer.from(JSON.stringify(event)));
  send(created('default'));
  send(delta('default', key.slice(0, -5)));
  send(delta('default', key.slice(-5)));
  assert.ok(events.length);
  assert.ok(events.every((event) => event.params.text === '[credential redacted]'));
  await voice.stop();
});
