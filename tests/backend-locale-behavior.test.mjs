import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from '../src/work/engine.mjs';
import { NativeRealtimeVoice } from '../src/voice/realtime.mjs';
import { Store } from '../src/conversation/store.mjs';
import { languages } from '../src/i18n/languages.mts';
import { loadSystemLanguage } from '../src/i18n/localization-node.mts';

const phrases = {
  unsubmitted:
    'The call ended before this task was submitted. Send the request again in chat if you still want it done.',
  credential:
    'I need a credential to continue this task. Please complete the secure credential form in chat.',
  input: 'I need your input to continue this task.',
  attachments: 'Please inspect the attached files.',
  stopped: 'The task stopped before completion.',
  archive:
    "The output files could not be added to chat. Check the work computer for the task's files.",
  finished: 'The background task has finished.',
  unfinished:
    'This task is unfinished. Its execution turn has ended; the remaining steps are kept in Work progress.',
};
const chinese = {
  unsubmitted: '通话结束时，这个任务还没有提交。若仍需要执行，请在聊天中重新发送请求。',
  credential: '继续这个任务需要登录凭据，请填写聊天中的安全凭据表单。',
  input: '继续这个任务需要你提供信息。',
  attachments: '请检查附件。',
  stopped: '任务尚未完成就停止了。',
  archive: '任务输出文件未能添加到聊天，请到工作电脑检查。',
  finished: '后台任务已结束。',
  unfinished: '这项任务尚未完成。本轮执行已结束，剩余步骤保留在工作进度中。',
};
const catalogs = new Map();
for (const { code } of languages) {
  loadSystemLanguage(code);
  if (!['en', 'zh'].includes(code)) {
    catalogs.set(
      code,
      JSON.parse(
        fs.readFileSync(new URL(`../src/i18n/locales/${code}.json`, import.meta.url), 'utf8'),
      ),
    );
  }
}
function expected(code, name) {
  return code === 'en'
    ? phrases[name]
    : code === 'zh'
      ? chinese[name]
      : catalogs.get(code)[phrases[name]];
}
function noticesFixture() {
  const sent = [],
    completions = [],
    responses = [];
  const context = {
    store: {
      state: { settings: { language: 'en' } },
      addCompletion: (value) => completions.push(value),
    },
    worker: { rpc: { send: (value) => responses.push(value) } },
    deliverText(text) {
      sent.push(text);
      return { sent: true, messageId: 'notice-' + sent.length };
    },
    task: () => null,
    redact: (value) => value,
  };
  return { context, sent, completions, responses };
}

test('backend notices follow all 16 current preferences and preserve questions, messages and attachment paths', () => {
  const f = noticesFixture();
  const userQuestion = 'The background task has finished. 原始问题 /home/user/文档.txt';
  for (const { code } of languages) {
    f.context.store.state.settings.language = code;
    const active = {
      background: true,
      credentialWaits: 1,
      turnId: 'turn-' + code,
      messageId: 'message-' + code,
    };
    Engine.prototype.backgroundCredentialNotice.call(f.context, active);
    assert.equal(f.sent.at(-1), expected(code, 'credential'), code);
    const count = f.sent.length;
    Engine.prototype.backgroundCredentialNotice.call(f.context, active);
    assert.equal(f.sent.length, count, 'an existing blocker must not be announced twice');
    Engine.prototype.requestChatInput.call(
      f.context,
      { id: 'input-' + code, params: { questions: [{ question: userQuestion }] } },
      active,
    );
    assert.equal(f.sent.at(-1), expected(code, 'input') + '\n\n' + userQuestion, code);
    assert.equal(f.responses.at(-1).id, 'input-' + code);
    assert.equal(active.awaitingChatInput, true);
    const file = { type: 'application/json', path: '/home/user/原始 report.json' };
    assert.equal(
      Engine.prototype.input.call(f.context, { attachments: [file] })[0].text,
      expected(code, 'attachments') + '\nAttached file in VM: ' + file.path,
      code,
    );
    assert.equal(
      Engine.prototype.input.call(f.context, { text: phrases.finished })[0].text,
      phrases.finished,
      'user text matching an application phrase stays unchanged',
    );
  }
  assert.equal(f.completions.length, languages.length * 2);
  assert.equal(
    expected('fr', 'input'),
    'J’ai besoin de votre réponse pour poursuivre cette tâche.',
  );
  assert.equal(expected('ja', 'attachments'), '添付ファイルを確認してください。');
});

test('unsubmitted voice work uses the selected language without submitting or retrying it', () => {
  for (const { code } of languages) {
    const f = noticesFixture();
    f.context.store.state.settings.language = code;
    let rejected;
    f.context.voiceTasks = new Map([
      ['not-submitted', { callId: 'ended-call', reject: (error) => (rejected = error) }],
    ]);
    f.context.queue = [{ id: 'not-submitted', text: 'Original task' }];
    Engine.prototype.continueVoiceTasks.call(f.context, 'ended-call');
    assert.deepEqual(f.sent, [expected(code, 'unsubmitted')]);
    assert.equal(f.context.queue.length, 0);
    assert.equal(f.context.voiceTasks.size, 0);
    assert.match(rejected.message, /before task submission/);
    assert.equal(f.completions[0].turnId, 'not-submitted:unsubmitted');
  }
});

test('observed task fallback labels support all languages while actual task titles remain unchanged', () => {
  for (const { code } of languages) {
    for (const source of ['chat', 'voice']) {
      const f = noticesFixture();
      let stored;
      f.context.store.state.settings.language = code;
      f.context.store.registerWork = (value) => (stored = value);
      f.context.markWorkMessages = () => {};
      const task = { turnId: 'owned-turn', source };
      Engine.prototype.observeRegisteredExecution.call(f.context, task);
      const english = source === 'chat' ? 'Chat task' : 'Task from a call';
      const label =
        code === 'en'
          ? english
          : code === 'zh'
            ? source === 'chat'
              ? '聊天任务'
              : '通话中交办的任务'
            : catalogs.get(code)[english];
      assert.equal(stored.title, label, code + ':' + source);
      f.context.task = () => ({ id: 'original-message', role: 'user', text: phrases.finished });
      Engine.prototype.observeRegisteredExecution.call(f.context, { turnId: 'user-turn', source });
      assert.equal(stored.title, phrases.finished);
    }
  }
});

test('continuation failures localize only the fixed prefix and preserve the redacted error detail', async () => {
  for (const { code } of languages) {
    const f = noticesFixture();
    f.context.store.state.settings.language = code;
    f.context.archiveLinkedMessage = async () => {};
    const task = {
      turnId: 'failed-turn',
      outputs: new Map(),
      continuation: { workId: 'original-work' },
    };
    const detail = 'The background task has finished. 原始错误 [credential redacted]';
    assert.equal(
      await Engine.prototype.publishContinuationOutcome.call(f.context, task, 'failed', detail),
      true,
    );
    assert.deepEqual(f.sent, [expected(code, 'stopped') + ' ' + detail]);
  }
});

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
class Worker extends EventEmitter {
  constructor(dir) {
    super();
    this.status = 'online';
    this.workspaceRoot = path.join(dir, 'workspaces');
    this.desktopPath = path.join(dir, 'desktop.py');
    this.calls = [];
    this.nextTurn = 0;
    this.rpc = { send() {}, reply() {} };
  }
  event(method, params = {}) {
    this.emit('event', { method, params: { threadId: 'locale-thread', ...params } });
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'locale-thread' } };
    if (method === 'thread/realtime/start') {
      queueMicrotask(() => {
        this.event('thread/realtime/started', {
          version: 'v3',
          realtimeSessionId: 'rt-' + params.voiceSessionId,
        });
        this.event('thread/realtime/sdp', { sdp });
      });
    }
    if (method === 'thread/realtime/stop')
      queueMicrotask(() => this.event('thread/realtime/closed'));
    if (method === 'thread/read') {
      const turns = [...(this.engine.nativeVoice?.session?.turns.values() || [])].map((turn) => ({
        id: turn.turnId,
        status: turn.done ? 'completed' : 'inProgress',
      }));
      return {
        thread: {
          id: 'locale-thread',
          status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle' },
          turns,
        },
      };
    }
    if (method === 'turn/start') return { turn: { id: 'api-locale-turn-' + ++this.nextTurn } };
    return {};
  }
}
function executionFixture(t, { native = false, archive } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'backend-locale-'));
  const store = new Store(dir),
    worker = new Worker(dir),
    engine = new Engine(store, worker, { deliverables: archive ? { archive } : undefined });
  worker.engine = engine;
  const voice = native
    ? new NativeRealtimeVoice({ worker, engine, connectTimeoutMs: 1000, stopTimeoutMs: 1000 })
    : null;
  t.after(() => {
    engine.call = null;
    engine.pauseQueue();
    clearTimeout(engine.streamingSaveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    worker,
    engine,
    voice,
    event: (method, params) =>
      engine.handle({ method, params: { threadId: 'locale-thread', ...params } }),
  };
}

test('actual API background completion selects the current language after hangup', async (t) => {
  const f = executionFixture(t);
  for (const { code } of languages) {
    f.store.state.settings.language = 'en';
    f.engine.call = { id: 'api-call-' + code, provider: 'api' };
    const task = f.engine.runVoiceTask('Original task request 原文');
    task.catch(() => {});
    await f.engine.active.starting;
    const turnId = f.engine.active.turnId;
    await f.engine.stopCall('api-call-' + code);
    f.store.state.settings.language = code;
    await f.event('turn/completed', { turn: { id: turnId, status: 'completed' } });
    await task;
    assert.equal(f.store.state.messages.at(-1).text, expected(code, 'finished'), code);
  }
});

test('actual API archive and native execution failures localize fixed notices and preserve original details', async (t) => {
  for (const code of ['fr', 'ja', 'ar']) {
    const api = executionFixture(t, {
      archive: async () => {
        throw Error('private archive detail');
      },
    });
    api.store.state.settings.language = code;
    api.engine.call = { id: 'api-archive-call', provider: 'api' };
    const result = api.engine.runVoiceTask('Original archive task');
    result.catch(() => {});
    await api.engine.active.starting;
    const turnId = api.engine.active.turnId;
    await api.engine.stopCall('api-archive-call');
    await api.event('turn/completed', { turn: { id: turnId, status: 'completed' } });
    await result;
    assert.equal(
      api.store.state.messages.find((message) => message.role === 'assistant').text,
      expected(code, 'archive'),
    );
    assert.equal(JSON.stringify(api.store.state).includes('private archive detail'), false);

    const f = executionFixture(t, { native: true });
    f.store.state.settings.language = code;
    const call = await f.engine.startCall(sdp);
    await f.event('turn/started', { turn: { id: 'native-failed-turn', status: 'inProgress' } });
    await f.engine.stopCall(call.callId);
    const detail = 'The background task has finished. 原始错误';
    await f.event('turn/completed', {
      turn: { id: 'native-failed-turn', status: 'failed', error: { message: detail } },
    });
    assert.equal(
      f.store.state.messages.find((message) => message.role === 'assistant').text,
      expected(code, 'stopped') + ' ' + detail,
    );
    assert.equal(
      f.worker.calls.some((call) => call.method === 'turn/start'),
      false,
    );
  }
});

test('actual native background completion supports every language without translating task output', async (t) => {
  for (const { code } of languages) {
    const f = executionFixture(t, { native: true });
    f.store.state.settings.language = 'en';
    const call = await f.engine.startCall(sdp);
    await f.event('turn/started', { turn: { id: 'native-locale-turn', status: 'inProgress' } });
    await f.engine.stopCall(call.callId);
    f.store.state.settings.language = code;
    await f.event('turn/completed', { turn: { id: 'native-locale-turn', status: 'completed' } });
    assert.equal(
      f.store.state.messages.find((message) => message.role === 'assistant').text,
      expected(code, 'finished'),
      code,
    );
    assert.equal(
      f.worker.calls.some((call) => call.method === 'turn/start'),
      false,
    );
    assert.equal(f.voice.session, null);
  }
});

test('native archive errors and unfinished work use translated notices while retaining original output', async (t) => {
  for (const code of ['fr', 'ja', 'ar']) {
    const f = executionFixture(t, {
      native: true,
      archive: async () => {
        throw Error('private archive error');
      },
    });
    f.store.state.settings.language = code;
    const call = await f.engine.startCall(sdp);
    await f.event('turn/started', { turn: { id: 'archive-locale-turn', status: 'inProgress' } });
    await f.engine.stopCall(call.callId);
    await f.event('item/completed', {
      turnId: 'archive-locale-turn',
      item: { id: 'original-output', type: 'agentMessage', text: phrases.finished },
    });
    await f.event('turn/completed', { turn: { id: 'archive-locale-turn', status: 'completed' } });
    const texts = f.store.state.messages.map((message) => message.text);
    assert.ok(texts.includes(phrases.finished));
    assert.ok(texts.includes(expected(code, 'archive')));
    assert.equal(JSON.stringify(f.store.state).includes('private archive error'), false);
  }
  const f = executionFixture(t, { native: true });
  f.store.state.settings.language = 'ja';
  const call = await f.engine.startCall(sdp);
  await f.event('turn/started', { turn: { id: 'unfinished-locale-turn', status: 'inProgress' } });
  await f.event('turn/plan/updated', {
    turnId: 'unfinished-locale-turn',
    plan: [{ step: 'Original unfinished task 原文', status: 'pending' }],
  });
  await f.engine.stopCall(call.callId);
  await f.event('turn/completed', { turn: { id: 'unfinished-locale-turn', status: 'completed' } });
  assert.equal(
    f.store.state.messages.find((message) => message.role === 'assistant').text,
    expected('ja', 'unfinished'),
  );
  assert.equal(f.store.state.workTasks[0].title, 'Original unfinished task 原文');
});
