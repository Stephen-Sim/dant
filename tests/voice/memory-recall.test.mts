import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Voice } from '../../src/voice/voice.mts';
import type { VoiceConversationValue } from '../../src/voice/voice-types.ts';
import { MemoryStore } from '../../src/conversation/memory.mts';
import { Store } from '../../src/conversation/store.mts';
import { retrieveAgentMemory } from '../../src/conversation/agent-memory.mts';
import { isRecord } from '../../src/contracts/json.mts';
import { defined } from '../support/fixture-assertions.mts';

const SDP =
  'v=0\r\ns=voice\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function message(id: string, text = 'Please continue the Python renderer.') {
  return { id, role: 'user', text, attachments: [] };
}
function harness(t: TestContext) {
  const sockets: Socket[] = [];
  const conversation: VoiceConversationValue[] = [];
  class Socket extends EventEmitter {
    readyState = 0;
    readonly sent: Record<string, unknown>[] = [];
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }
    send(data: string, callback: (error?: Error) => void) {
      const value: unknown = JSON.parse(data);
      this.sent.push(record(value));
      callback();
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }
    terminate() {
      this.close();
    }
  }
  const voice = new Voice({
    runTask: () => assert.fail('Recall must not execute a task'),
    tool: () => assert.fail('Recall must not invoke a tool'),
    getKey: () => 'sk-proj-fake-api-memory-test-only',
    WebSocketImpl: Socket,
    context: () => '',
    onConversationItem: (value) => {
      conversation.push(value);
    },
    fetchImpl: async (url) =>
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : new Response(SDP, {
            status: 201,
            headers: {
              Location: '/v1/realtime/calls/rtc_fixture',
              'Content-Type': 'application/sdp',
            },
          }),
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    hangupTimeoutMs: 1000,
    contextTimeoutMs: 5000,
  });
  t.after(() => voice.close().catch(() => {}));
  return { voice, sockets, conversation };
}
function inputs(socket: ReturnType<typeof harness>['sockets'][number]) {
  return socket.sent.flatMap((event) => {
    if (
      event.type !== 'conversation.item.create' ||
      !isRecord(event.item) ||
      event.item.role !== 'user'
    )
      return [];
    const item = event.item;
    assert.ok(typeof item.id === 'string' && Array.isArray(item.content));
    const content = record(item.content[0]);
    assert.ok(typeof content.text === 'string');
    return [{ item, text: content.text }];
  });
}
function added(socket: ReturnType<typeof harness>['sockets'][number], item: unknown) {
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.added', item })));
}
function memoryFixture(t: TestContext) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'voice-recall-'));
  const store = new Store(dir),
    memory = new MemoryStore(dir);
  t.after(() => {
    memory.close();
    const relative = path.relative(base, dir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, memory };
}

test('actual API voice input recalls current references, requires the augmented exact ACK and never persists the prompt as chat', async (t) => {
  const { voice, sockets, conversation } = harness(t);
  const { store, memory } = memoryFixture(t);
  memory.write('working-memory.md', 'Python renderer uses Cairo. password: fixture_note_secret');
  const saved = store.add({ role: 'user', text: 'Continue the Python renderer.', attachments: [] });
  const original = structuredClone(saved);
  const scope = { conversationId: store.state.conversationId };
  await voice.start({ sdp: SDP, callId: 'call' });
  const socket = defined(sockets[0]);
  let reads = 0,
    settled = false,
    reference = '';
  const pending = voice.message({
    message: saved,
    callId: 'call',
    memoryReference: () => {
      reads++;
      reference = retrieveAgentMemory(memory, defined(saved.text), scope, { messageId: saved.id });
      return reference;
    },
  });
  void pending.then(() => {
    settled = true;
  });
  await tick();
  const input = defined(inputs(socket)[0]);
  assert.equal(reads, 1);
  assert.ok(input.text.endsWith(reference));
  assert.match(reference, /Cairo/);
  assert.doesNotMatch(input.text, /fixture_note_secret/);
  const withoutRecall = input.text.slice(0, -('\n\n' + reference).length);
  added(socket, { ...input.item, content: [{ type: 'input_text', text: withoutRecall }] });
  await tick();
  assert.equal(
    settled,
    false,
    'An ACK for the old unaugmented text does not confirm the submitted input.',
  );
  added(socket, input.item);
  const result = await pending;
  assert.equal(result.submission, 'confirmed');
  assert.equal(result.messageId, saved.id);
  assert.equal(socket.sent.filter((event) => event.type === 'response.create').length, 1);
  assert.deepEqual(conversation, []);
  assert.deepEqual(store.state.messages, [original]);
  assert.doesNotMatch(
    fs.readFileSync(store.file, 'utf8'),
    /dant_recalled_memory|Cairo|fixture_note_secret/,
  );
});

test('queued API inputs perform fresh recall only when their original execution slot becomes sendable', async (t) => {
  const { voice, sockets } = harness(t);
  const { store, memory } = memoryFixture(t);
  memory.write('working-memory.md', 'Python renderer old reference');
  await voice.start({ sdp: SDP, callId: 'call' });
  const socket = defined(sockets[0]);
  const first = voice.message({ message: message('first'), callId: 'call' });
  let reads = 0;
  const second = voice.message({
    message: message('second'),
    callId: 'call',
    memoryReference: () => {
      reads++;
      return retrieveAgentMemory(
        memory,
        'Python renderer',
        { conversationId: store.state.conversationId },
        { messageId: 'second' },
      );
    },
  });
  await tick();
  assert.equal(reads, 0);
  assert.equal(inputs(socket).length, 1);
  memory.write('working-memory.md', 'Python renderer fresh reference');
  added(socket, defined(inputs(socket)[0]).item);
  await first;
  await tick();
  assert.equal(reads, 1);
  const input = defined(inputs(socket)[1]);
  assert.match(input.text, /fresh reference/);
  assert.doesNotMatch(input.text, /old reference/);
  added(socket, input.item);
  assert.equal((await second).submission, 'confirmed');
});

test('pending and confirmed duplicate IDs keep the original input and never rerun recall or start a second response', async (t) => {
  const { voice, sockets } = harness(t);
  await voice.start({ sdp: SDP, callId: 'call' });
  const socket = defined(sockets[0]),
    inputMessage = message('same-id');
  let reads = 0;
  const first = voice.message({
    message: inputMessage,
    callId: 'call',
    memoryReference: () => {
      reads++;
      return 'Reference chosen for the admitted input.';
    },
  });
  const duplicate = voice.message({
    message: inputMessage,
    callId: 'call',
    memoryReference: () => {
      throw Error('A duplicate must not recall again.');
    },
  });
  assert.equal(first, duplicate);
  await tick();
  await assert.rejects(
    voice.message({ message: { ...inputMessage, text: 'Changed input' }, callId: 'call' }),
    /different call input/,
  );
  added(socket, defined(inputs(socket)[0]).item);
  const result = await first;
  assert.deepEqual(
    await voice.message({
      message: inputMessage,
      callId: 'call',
      memoryReference: () => {
        throw Error('Confirmed duplicates must not recall.');
      },
    }),
    result,
  );
  assert.equal(reads, 1);
  assert.equal(inputs(socket).length, 1);
  assert.equal(socket.sent.filter((event) => event.type === 'response.create').length, 1);
  assert.deepEqual(inputMessage, message('same-id'));
});

test('no-match recall preserves ordinary API input and a pre-send recall failure never becomes an unknown submission or retry', async (t) => {
  const { voice, sockets } = harness(t);
  await voice.start({ sdp: SDP, callId: 'call' });
  const socket = defined(sockets[0]);
  const failed = voice.message({
    message: message('failed'),
    callId: 'call',
    memoryReference: () => {
      throw Error('Memory lookup unavailable');
    },
  });
  await assert.rejects(
    failed,
    (error) =>
      isRecord(error) && error.submission === 'not-submitted' && error.unknownOutcome !== true,
  );
  assert.equal(inputs(socket).length, 0);
  let retries = 0;
  await assert.rejects(
    voice.message({
      message: message('failed'),
      callId: 'call',
      memoryReference: () => {
        retries++;
        return 'Unexpected retry';
      },
    }),
  );
  assert.equal(retries, 0);
  const pending = voice.message({
    message: message('fresh'),
    callId: 'call',
    memoryReference: () => '',
  });
  await tick();
  const input = defined(inputs(socket)[0]);
  assert.doesNotMatch(input.text, /dant_recalled_memory|Unexpected retry/);
  assert.match(input.text, /Please continue the Python renderer/);
  added(socket, input.item);
  assert.equal((await pending).submission, 'confirmed');
});
