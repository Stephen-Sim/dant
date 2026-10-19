import type { RecordingDraft } from '../../../ui/app/application-types.ts';
import type { ChatMessage, UiModal, Attachment } from '../../../ui/shared/contracts.mts';
import { errorMessage } from '../../../src/contracts/json.mts';
import { observedRecord, observedString } from '../../support/service-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';
import { bindAttachmentImages } from '../../../ui/files/attachment-images.mts';
import test from 'node:test';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  workProgress,
  renderActiveWork,
  renderVoiceWorkHistory,
} from '../../../ui/work/work-progress.mts';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createMessageSubmissions } from '../../../ui/chat/pending.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  part = (start: string, end: string) => sourceSection(source, start, end),
  settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
function fixture({
  language = 'en',
  deferPermission = false,
  permissionError = null,
  mime = 'audio/webm;codecs=opus',
}: {
  language?: string;
  deferPermission?: boolean;
  permissionError?: unknown;
  mime?: string;
} = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector<HTMLElement>('#app'),
    recorders: Recorder[] = [],
    tracks: { stops: number; stop: () => void }[] = [],
    mediaRequests: MediaStreamConstraints[] = [],
    uploads: { file: File; bytes: Uint8Array }[] = [],
    messages: Record<string, unknown>[] = [],
    toasts: string[] = [],
    speechCalls: string[] = [],
    intervals = new Map<number, () => void>(),
    revoked: string[] = [];
  let resolvePermission: (() => void) | undefined,
    rejectPermission: ((reason: unknown) => void) | undefined,
    clock = 10000,
    sequence = 0,
    urlSequence = 0,
    postImpl: ((body: Record<string, unknown>) => Promise<unknown>) | null = null,
    uploadImpl: ((file: File) => Promise<unknown>) | null = null;
  const bytes = Uint8Array.from([26, 69, 223, 163, 129, 1, 2, 3]);
  class Clock extends Date {
    constructor(...args: [] | [string | number]) {
      super(args.length ? args[0] : clock);
    }
    static now() {
      return clock;
    }
  }
  class ObjectURL extends URL {
    static createObjectURL() {
      return 'blob:voice-' + ++urlSequence;
    }
    static revokeObjectURL(value: string) {
      revoked.push(value);
    }
  }
  class Recorder {
    stream: { getTracks: () => { stop: () => void }[] };
    mimeType: string;
    state: string;
    timeslice: number | undefined;
    ondataavailable: ((event: { data: Blob }) => unknown) | null = null;
    onstop: (() => unknown) | null = null;
    onerror: (() => unknown) | null = null;
    static isTypeSupported(type: string) {
      return type === mime;
    }
    constructor(stream: Recorder['stream'], options: { mimeType: string }) {
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      recorders.push(this);
    }
    start(timeslice: number) {
      this.state = 'recording';
      this.timeslice = timeslice;
    }
    pause() {
      this.state = 'paused';
    }
    resume() {
      this.state = 'recording';
    }
    requestData() {
      queueMicrotask(() =>
        this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) }),
      );
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
        Promise.resolve(this.onstop?.()).catch((error) => toasts.push(errorMessage(error)));
      });
    }
  }
  const c = uiEntrypointFixture({
    progressActions: { bind() {}, renderConfirmation: () => '', onClose() {}, busy: false },
    workDisclosures: { capture() {}, bind() {}, isOpen: () => false },
    bindAttachmentImages,
    textEditor: { renderSettings: () => '', bind() {}, load: async () => {}, dispose() {} },
    workProgress,
    renderActiveWork,
    renderVoiceWorkHistory,
    downloads: { bind() {} },
    filePreview: { bind() {}, syncModal: (value: UiModal | null) => value },
    document,
    Event,
    Blob,
    File,
    FormData,
    Date: Clock,
    URL: ObjectURL,
    MediaRecorder: Recorder,
    window: { MediaRecorder: Recorder, RTCPeerConnection: class {} },
    navigator: {
      mediaDevices: {
        getUserMedia: async (options: MediaStreamConstraints) => {
          mediaRequests.push(options);
          const track = {
              stops: 0,
              stop() {
                this.stops++;
              },
            },
            stream = { getTracks: () => [track] };
          tracks.push(track);
          if (permissionError) throw permissionError;
          if (deferPermission)
            return new Promise<Recorder['stream']>((resolve, reject) => {
              resolvePermission = () => resolve(stream);
              rejectPermission = reject;
            });
          return stream;
        },
      },
    },
    fallbackLanguage: language,
    state: {
      settings: { language },
      worker: { status: 'online' },
      messages: [] as (Partial<ChatMessage> & { id: string })[],
      queue: [],
      call: null as { id: string; provider?: string } | null,
    },
    pc: null,
    callStarting: false,
    callGeneration: 0,
    callConnected: false,
    callId: null,
    callProvider: 'subscription',
    callMini: false,
    callChannel: null,
    callTimeout: null,
    stream: null,
    audio: null,
    callMuted: false,
    callDuration: { reset() {}, stop() {}, snapshot: { callId: null } },
    clearTimeout() {},
    callStops: { pending: false },
    recording: null as Recorder | null,
    recordStarting: false,
    recordGeneration: 0,
    recordDraft: null as RecordingDraft | null,
    recordTimer: null,
    dictating: false,
    speakingId: null as string | null,
    speechGeneration: 0,
    unloading: false,
    recordChunks: [],
    composerDraft: 'Keep my typed draft',
    attachments: [] as (Partial<Attachment> & { id: string; name: string })[],
    replyTo: null as string | null,
    sending: false,
    uploading: 0,
    eventConnected: true,
    attachmentMenu: false,
    pendingActions: new Set(),
    messageSubmissions: createMessageSubmissions(),
    managedSettings: { renderRequests: () => '', bind() {} },
    chatHistory: { bind() {}, bindModal() {} },
    modal: null as UiModal | null,
    speech: {
      dictate: async () => {
        speechCalls.push('dictate');
        return 'Recognized text';
      },
      speak: async () => {},
      stop: async (): Promise<void> => {
        speechCalls.push('stop');
      },
    },
    renderMessages: () => '',
    eyes: () => '',
    ico: (name: string) => '<svg>' + name + '</svg>',
    button: () => '',
    resizeComposer() {},
    bindSteer() {},
    bindProvision() {},
    bindVoiceKey() {},
    bindTelegram() {},
    bindAppearance() {},
    bindVMSettings() {},
    bindComputerInput() {},
    fileURL: (file: { id: string }) => '/api/files/' + file.id,
    toast: (value: string) => toasts.push(value),
    progressExpanded: false,
    subscriptionVoiceUnavailable: () => false,
    apiVoiceUnavailable: () => false,
    openModal(value: UiModal) {
      c.modal = value;
    },
    setInterval: (fn: () => void, ms: number) => {
      assert.equal(ms, 250);
      intervals.set(++sequence, fn);
      return sequence;
    },
    clearInterval: (id: number) => intervals.delete(id),
  });
  c.callSubtitles = createCallSubtitles();
  c.api = async (route, options) => {
    if (route === '/state') return c.state;
    assert.equal(route, '/upload');
    const body = defined(options).body;
    assert.ok(body instanceof FormData);
    const file = body.get('file');
    assert.ok(file instanceof File);
    uploads.push({ file, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (uploadImpl) return uploadImpl(file);
    return { id: 'audio-' + uploads.length, name: file.name, type: file.type, size: file.size };
  };
  c.post = async (route, body) => {
    assert.equal(route, '/messages');
    const value = observedRecord(body);
    messages.push(structuredClone(value));
    return postImpl
      ? postImpl(value)
      : { id: 'sent', clientMessageId: value.clientMessageId, submission: 'confirmed' };
  };
  c.updateInstalling = false;
  c.chatScroll ??= { capture() {}, restore() {}, dispose() {}, navigate: (action) => action() };
  c.memorySettings ??= { setVisible() {}, render: () => '', bind() {}, dispose() {} };
  c.taskReplies ??= createTaskReplyController({ document: c.document, getModel: () => ({}) });
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      [
        part('function currentState(', 'const subscriptionVoiceUnavailable='),
        '',
        part('function unreadAssistant(', 'function revealMessage(){'),
        part('function recordingSeconds(){', 'function renderChat(){'),
        part('function renderChat(){', 'function spokenText('),
        part('function renderUnconfirmedMessage(){', 'function renderProgress(){'),
        part('function bind(){', 'async function taskRequest('),
        part('async function action(a){', 'async function checkUnconfirmedMessage(){'),
        part(
          'async function checkUnconfirmedMessage(){',
          'async function send(confirmResend=false){',
        ),
        part('async function send(confirmResend=false){', 'function screenVisible(){'),
        part('async function startCall(', 'function cancelRecording('),
        part('function cancelRecording(', 'async function requestNotifications('),
      ].join('\n'),
    ),
    c,
  );
  c.render = () => {
    const current = document.querySelector<HTMLTextAreaElement>('#composer');
    if (current) c.composerDraft = current.value;
    const template = document.createElement('template');
    template.innerHTML = c.renderChat() + '<input id="file-input" type="file" hidden>';
    reconcile(defined(app), template.content);
    c.bind();
  };
  c.render();
  return {
    c,
    document,
    recorders,
    tracks,
    mediaRequests,
    uploads,
    messages,
    toasts,
    speechCalls,
    bytes,
    intervals,
    revoked,
    set post(value: typeof postImpl) {
      postImpl = value;
    },
    set upload(value: typeof uploadImpl) {
      uploadImpl = value;
    },
    grant() {
      defined(resolvePermission)();
    },
    deny(error: unknown) {
      defined(rejectPermission)(error);
    },
    async advance(ms: number) {
      clock += ms;
      for (const fn of intervals.values()) fn();
      await settle();
    },
    async click(selector: string) {
      const node = document.querySelector<HTMLSelectElement>(selector);
      assert.ok(node, selector);
      node.dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
    },
    async send() {
      defined(document.querySelector<HTMLElement>('#message-form')).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();
    },
  };
}

test('mic opens a dedicated recording bar and Send voice sends audio alone while retaining the full text draft', async () => {
  const f = fixture();
  f.c.attachments = [{ id: 'draft-file', name: 'draft.txt' }];
  f.c.replyTo = 'draft-reply';
  f.c.state.messages = [{ id: 'draft-reply', role: 'assistant', text: 'Original quote' }];
  f.c.render();
  const input = f.document.querySelector<HTMLTextAreaElement>('#composer');
  await f.click('.composer-tools [data-action="record"]');
  assert.equal(f.mediaRequests.length, 1);
  assert.equal(defined(f.recorders[0]).timeslice, 1000);
  assert.ok(f.document.querySelector<HTMLElement>('.voice-message-recorder'));
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('#message-form')).hasAttribute('hidden'),
    true,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-action="send-voice"]')).title,
    'Send voice',
  );
  assert.equal(f.uploads.length, 0);
  assert.equal(f.messages.length, 0);
  await f.click('[data-action="send-voice"]');
  assert.equal(f.uploads.length, 1);
  assert.ok(defined(f.uploads[0]).file instanceof File);
  assert.match(defined(f.uploads[0]).file.name, /^voice-\d+\.webm$/);
  assert.deepEqual(defined(f.uploads[0]).bytes, f.bytes);
  assert.equal(f.messages.length, 1);
  assert.equal(defined(f.messages[0]).text, '');
  assert.deepEqual(defined(f.messages[0]).attachments, ['audio-1']);
  assert.equal(defined(f.messages[0]).replyTo, null);
  assert.match(observedString(defined(f.messages[0]).clientMessageId), /^[\w-]+$/);
  assert.equal(f.document.querySelector<HTMLTextAreaElement>('#composer'), input);
  assert.equal(defined(input).value, 'Keep my typed draft');
  assert.deepEqual(
    f.c.attachments.map((file) => file.id),
    ['draft-file'],
  );
  assert.equal(f.c.replyTo, 'draft-reply');
  assert.equal(f.document.querySelector<HTMLElement>('.voice-message-recorder'), null);
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('#message-form')).hasAttribute('hidden'),
    false,
  );
  assert.equal(f.intervals.size, 0);
  assert.ok(defined(f.tracks[0]).stops >= 1);
  assert.deepEqual(f.speechCalls, []);
});

test('a voice reply uses the explicitly selected task and keeps the target with an unconsumed text draft', async () => {
  const f = fixture(),
    target = { workId: 'voice-work', turnId: 'voice-turn', conversationId: 'conversation' };
  Object.assign(f.c.state, {
    conversationId: 'conversation',
    capabilities: { workReply: true },
    workTasks: [
      {
        id: target.workId,
        turnId: target.turnId,
        title: 'Verify result',
        status: 'waiting_user',
        executionEndedAt: 1000,
        plan: { steps: [{ step: 'Verify', status: 'pending' }] },
      },
    ],
  });
  f.c.taskReplies = createTaskReplyController({
    document: f.document,
    getModel: () => workProgress(f.c.state),
    isPending: () => f.c.sending || Boolean(f.c.messageSubmissions.unknown),
  });
  assert.equal(f.c.taskReplies.select(target), true);
  await f.click('[data-action="record"]');
  await f.advance(1500);
  await f.c.sendVoice();
  assert.deepEqual(defined(f.messages[0]).workReply, target);
  assert.equal(f.c.recordDraft, null);
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Keep my typed draft',
  );
  assert.deepEqual(
    f.c.taskReplies.target,
    target,
    'the remaining text must not silently become an ordinary reply',
  );
});

test('pause previews the actual audio, freezes elapsed time and resume continues the same recording', async () => {
  const f = fixture();
  await f.click('[data-action="record"]');
  await f.advance(3500);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-record-duration]')).textContent,
    '0:03',
  );
  await f.click('[data-action="pause-record"]');
  assert.equal(defined(f.recorders[0]).state, 'paused');
  const preview = f.document.querySelector<HTMLAudioElement>('.voice-message-recorder audio');
  let pausedPlayback = 0;
  defined(preview).pause = () => pausedPlayback++;
  assert.equal(defined(preview).getAttribute('src'), 'blob:voice-1');
  assert.equal(defined(preview).hasAttribute('autoplay'), false);
  assert.equal(defined(preview).hasAttribute('controls'), true);
  f.c.render();
  assert.equal(
    f.document.querySelector<HTMLAudioElement>('.voice-message-recorder audio'),
    preview,
  );
  await f.advance(7000);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-record-duration]')).textContent,
    '0:03',
  );
  await f.click('[data-action="pause-record"]');
  assert.equal(defined(f.recorders[0]).state, 'recording');
  assert.equal(f.document.querySelector<HTMLAudioElement>('.voice-message-recorder audio'), null);
  assert.ok(f.revoked.includes('blob:voice-1'));
  assert.equal(pausedPlayback, 1);
  await f.advance(2000);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-record-duration]')).textContent,
    '0:05',
  );
  await f.click('[data-action="send-voice"]');
  assert.equal(defined(f.uploads[0]).bytes.length, f.bytes.length * 2);
  assert.equal(f.messages.length, 1);
});

test('voice actions have separate bilingual labels and speech-to-text remains an explicit menu action', async () => {
  for (const [language, record, pause, resume, send, dictate] of [
    ['zh', '语音消息', '暂停录音', '继续录音', '发送语音', '语音转文字'],
    ['en', 'Voice message', 'Pause recording', 'Resume recording', 'Send voice', 'Speech to text'],
  ] as const) {
    const f = fixture({ language });
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="record"]')).getAttribute(
        'aria-label',
      ),
      record,
    );
    await f.click('[data-action="attach-menu"]');
    assert.match(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="dictate"]')).textContent,
      new RegExp(dictate),
    );
    await f.click('[data-action="dictate"]');
    assert.deepEqual(f.speechCalls, ['dictate']);
    assert.equal(f.mediaRequests.length, 0);
    assert.equal(
      defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
      'Keep my typed draft Recognized text',
    );
    f.c.dictating = false;
    await f.click('[data-action="record"]');
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="pause-record"]')).title,
      pause,
    );
    await f.click('[data-action="pause-record"]');
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="pause-record"]')).title,
      resume,
    );
    assert.equal(
      defined(
        f.document.querySelector<HTMLButtonElement>('[data-action="send-voice"]'),
      ).getAttribute('aria-label'),
      send,
    );
    await f.click('[data-action="cancel-record"]');
  }
});

test('cancel releases media, revokes preview and never uploads or sends a partial recording', async () => {
  const f = fixture();
  await f.click('[data-action="record"]');
  await f.click('[data-action="pause-record"]');
  await f.click('[data-action="cancel-record"]');
  assert.equal(f.c.recording, null);
  assert.equal(f.c.recordDraft, null);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.messages.length, 0);
  assert.ok(defined(f.tracks[0]).stops >= 1);
  assert.equal(f.intervals.size, 0);
  assert.ok(f.revoked.includes('blob:voice-1'));
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Keep my typed draft',
  );
});

test('pending microphone permission supports cancellation and releases a late granted stream', async () => {
  const f = fixture({ deferPermission: true });
  await f.click('[data-action="record"]');
  assert.equal(f.c.recordStarting, true);
  assert.ok(f.document.querySelector<HTMLElement>('.voice-message-recorder'));
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-action="send-voice"]')).disabled,
    true,
  );
  await f.send();
  assert.equal(f.messages.length, 0);
  await f.click('[data-action="cancel-record"]');
  f.grant();
  await settle();
  assert.equal(f.recorders.length, 0);
  assert.equal(f.uploads.length, 0);
  assert.equal(defined(f.tracks[0]).stops, 1);
  assert.equal(f.c.recordStarting, false);
});

test('permission and recorder errors preserve the draft, release media and never upload audio', async () => {
  const denied = fixture({
    permissionError: Object.assign(Error('denied'), { name: 'NotAllowedError' }),
  });
  await denied.click('[data-action="record"]');
  assert.equal(denied.c.recordStarting, false);
  assert.equal(denied.c.recordDraft, null);
  assert.match(defined(denied.toasts.at(-1)), /Microphone permission/);
  const failed = fixture();
  await failed.click('[data-action="record"]');
  defined(defined(failed.recorders[0]).onerror)();
  await settle();
  assert.equal(failed.uploads.length, 0);
  assert.ok(defined(failed.tracks[0]).stops >= 1);
  assert.equal(failed.c.recordDraft, null);
  assert.match(defined(failed.toasts.at(-1)), /Recording failed/);
  assert.equal(
    defined(failed.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Keep my typed draft',
  );
});

test('calls, dictation and unsupported formats block recording without acquiring the microphone', async () => {
  const call = fixture();
  call.c.state.call = { id: 'live', provider: 'subscription' };
  call.c.render();
  await call.click('[data-action="record"]');
  assert.equal(call.mediaRequests.length, 0);
  assert.match(defined(call.toasts.at(-1)), /End the call/);
  const dictated = fixture();
  dictated.c.dictating = true;
  await dictated.click('[data-action="record"]');
  assert.equal(dictated.mediaRequests.length, 0);
  const unsupported = fixture({ mime: 'audio/mp4' });
  await unsupported.click('[data-action="record"]');
  assert.equal(unsupported.mediaRequests.length, 0);
  assert.match(defined(unsupported.toasts.at(-1)), /WebM or Ogg/);
});

test('read-aloud shutdown owns the recording guard before any await and ignores duplicate starts', async () => {
  const f = fixture();
  let finishSpeech: (() => void) | undefined;
  f.c.speakingId = 'reading';
  f.c.speech.stop = () => new Promise<void>((resolve) => (finishSpeech = resolve));
  await f.click('[data-action="record"]');
  assert.equal(f.c.recordStarting, true);
  await f.click('[data-action="record"]');
  assert.equal(f.mediaRequests.length, 0);
  defined(finishSpeech)();
  await settle();
  assert.equal(f.recorders.length, 1);
  assert.equal(f.c.recordStarting, false);
  await f.click('[data-action="cancel-record"]');
});

test('cancel, call changes and unload during permission or read-aloud waits never start a late recording', async () => {
  for (const phase of ['permission', 'read-aloud'])
    for (const reason of ['cancel', 'call', 'unload']) {
      const f = fixture({ deferPermission: phase === 'permission' });
      let finishSpeech: (() => void) | undefined;
      if (phase === 'read-aloud') {
        f.c.speakingId = 'reading';
        f.c.speech.stop = () => new Promise<void>((resolve) => (finishSpeech = resolve));
      }
      await f.click('[data-action="record"]');
      if (reason === 'cancel') await f.click('[data-action="cancel-record"]');
      else if (reason === 'call') f.c.state.call = { id: 'remote-call' };
      else f.c.unloading = true;
      if (finishSpeech) finishSpeech();
      else f.grant();
      await settle();
      assert.equal(f.recorders.length, 0, phase + reason);
      assert.equal(f.c.recordStarting, false);
      assert.equal(f.uploads.length, 0);
      if (phase === 'permission') assert.equal(defined(f.tracks[0]).stops, 1);
    }
});

test('old recorder stop and old read-aloud callbacks cannot clear a newer recording or its timer', async () => {
  const f = fixture();
  await f.click('[data-action="record"]');
  const old = f.recorders[0];
  f.c.cancelRecording();
  await f.c.toggleRecord();
  const current = f.c.recording;
  defined(defined(old).onstop)();
  await settle();
  assert.equal(f.c.recording, current);
  assert.equal(f.intervals.size, 1);
  await f.advance(2000);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-record-duration]')).textContent,
    '0:02',
  );
  await f.click('[data-action="cancel-record"]');
  const waiting = fixture();
  let finish: (() => void) | undefined;
  waiting.c.speakingId = 'reading';
  waiting.c.speech.stop = () => new Promise<void>((resolve) => (finish = resolve));
  await waiting.click('[data-action="record"]');
  await waiting.click('[data-action="cancel-record"]');
  await waiting.click('[data-action="record"]');
  const next = waiting.c.recording;
  defined(finish)();
  await settle();
  assert.equal(waiting.c.recording, next);
  assert.equal(waiting.recorders.length, 1);
  await waiting.click('[data-action="cancel-record"]');
});

test('a known send failure retains one uploaded voice for explicit retry with the same client ID', async () => {
  const f = fixture();
  let calls = 0;
  f.post = async () => {
    if (++calls === 1) throw Object.assign(Error('Service rejected'), { status: 409 });
    return { submission: 'confirmed' };
  };
  await f.click('[data-action="record"]');
  await f.click('[data-action="send-voice"]');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(defined(f.c.recordDraft).status, 'ready');
  assert.ok(f.document.querySelector<HTMLAudioElement>('.voice-message-recorder audio'));
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-action="send-voice"]')).disabled,
    false,
  );
  await f.click('[data-action="send-voice"]');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.messages.length, 2);
  assert.equal(defined(f.messages[0]).clientMessageId, defined(f.messages[1]).clientMessageId);
  assert.equal(f.c.recordDraft, null);
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Keep my typed draft',
  );
});

test('an unknown voice send is never replayed automatically and checking its ID clears only the voice draft', async () => {
  const f = fixture();
  f.post = async () => {
    throw Object.assign(Error('Disconnected'), { unknownOutcome: true });
  };
  await f.click('[data-action="record"]');
  await f.click('[data-action="send-voice"]');
  assert.equal(f.messages.length, 1);
  assert.equal(defined(f.c.messageSubmissions.unknown).kind, 'voice');
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-action="send-voice"]')).disabled,
    true,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-action="cancel-record"]')).disabled,
    true,
  );
  f.c.render();
  await settle();
  assert.equal(f.messages.length, 1);
  f.c.state.messages.push({
    id: 'accepted',
    clientMessageId: observedString(defined(f.messages[0]).clientMessageId),
  });
  await f.click('[data-action="check-send"]');
  assert.equal(f.c.messageSubmissions.unknown, null);
  assert.equal(f.c.recordDraft, null);
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Keep my typed draft',
  );
  assert.equal(f.messages.length, 1);
});

test('explicitly confirmed resend uses a fresh client ID, while a call arriving during upload prevents any voice submission', async () => {
  const f = fixture();
  let calls = 0;
  f.post = async () => {
    if (++calls === 1) throw Object.assign(Error('Disconnected'), { unknownOutcome: true });
    return { submission: 'confirmed' };
  };
  await f.click('[data-action="record"]');
  await f.click('[data-action="send-voice"]');
  await f.click('[data-action="confirm-resend"]');
  assert.equal(f.messages.length, 2);
  assert.notEqual(defined(f.messages[0]).clientMessageId, defined(f.messages[1]).clientMessageId);
  assert.equal(f.uploads.length, 1);
  const interrupted = fixture();
  let finish: ((value: unknown) => void) | undefined;
  interrupted.upload = () => new Promise<unknown>((resolve) => (finish = resolve));
  await interrupted.click('[data-action="record"]');
  await interrupted.click('[data-action="send-voice"]');
  interrupted.c.state.call = { id: 'new-call' };
  defined(finish)({ id: 'uploaded' });
  await settle();
  assert.equal(interrupted.messages.length, 0);
  assert.equal(defined(interrupted.c.recordDraft).status, 'ready');
  assert.match(defined(interrupted.toasts.at(-1)), /End the call/);
  interrupted.c.cancelRecording(true);
});

test('Ogg is sent as audio and size limits stop capture before an oversized upload', async () => {
  const ogg = fixture({ mime: 'audio/ogg;codecs=opus' });
  await ogg.click('[data-action="record"]');
  await ogg.click('[data-action="send-voice"]');
  assert.match(defined(ogg.uploads[0]).file.name, /\.ogg$/);
  assert.match(defined(ogg.uploads[0]).file.type, /^audio\/ogg/);
  const large = fixture();
  await large.click('[data-action="record"]');
  defined(defined(large.recorders[0]).ondataavailable)({
    data: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]),
  });
  await settle();
  assert.equal(large.c.recordDraft, null);
  assert.equal(large.uploads.length, 0);
  assert.match(defined(large.toasts.at(-1)), /10 MiB/);
});

test('empty capture and upload failure do not submit a voice message, and captured audio remains available for an explicit retry', async () => {
  const empty = fixture();
  await empty.click('[data-action="record"]');
  defined(empty.recorders[0]).stop = function (
    this: ReturnType<typeof fixture>['recorders'][number],
  ) {
    this.state = 'inactive';
    queueMicrotask(() => defined(this.onstop)());
  };
  await empty.click('[data-action="send-voice"]');
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.uploads.length, 0);
  assert.match(defined(empty.toasts.at(-1)), /No audio was recorded/);
  await empty.click('[data-action="cancel-record"]');
  const failed = fixture();
  failed.upload = async () => {
    throw Error('Upload failed');
  };
  await failed.click('[data-action="record"]');
  await failed.click('[data-action="send-voice"]');
  assert.equal(failed.messages.length, 0);
  assert.equal(defined(failed.c.recordDraft).status, 'ready');
  assert.ok(failed.document.querySelector<HTMLAudioElement>('.voice-message-recorder audio'));
  failed.upload = null;
  await failed.click('[data-action="send-voice"]');
  assert.equal(failed.messages.length, 1);
});

test('a call appearing during capture cancels recording and an existing unknown message prevents a new microphone request', async () => {
  const call = fixture();
  await call.click('[data-action="record"]');
  call.c.state.call = { id: 'remote-call' };
  await call.advance(250);
  assert.equal(call.c.recordDraft, null);
  assert.ok(defined(call.tracks[0]).stops >= 1);
  assert.equal(call.uploads.length, 0);
  assert.equal(call.messages.length, 0);
  assert.equal(call.intervals.size, 0);
  const unknown = fixture();
  unknown.c.messageSubmissions.unconfirmed({
    ...unknown.c.messageSubmissions.prepare('/messages', { text: '' }),
    kind: 'voice',
  });
  unknown.c.render();
  await unknown.click('[data-action="record"]');
  assert.equal(unknown.mediaRequests.length, 0);
  assert.ok(unknown.toasts.length);
});

test('a call waiting for speech shutdown cannot take the microphone from a newly started voice recording', async () => {
  const f = fixture();
  let finishSpeech: (() => void) | undefined;
  f.c.speakingId = 'reading';
  f.c.speech.stop = () => new Promise<void>((resolve) => (finishSpeech = resolve));
  const callButton = f.document.createElement('button');
  callButton.dataset.action = 'call';
  defined(f.document.querySelector<HTMLElement>('#app')).append(callButton);
  f.c.bind();
  callButton.dispatchEvent(new f.c.Event('click', { bubbles: true }));
  await settle();
  assert.equal(f.mediaRequests.length, 0);
  await f.click('[data-action="record"]');
  const recorder = f.c.recording;
  assert.ok(recorder);
  assert.equal(f.mediaRequests.length, 1);
  defined(finishSpeech)();
  await settle();
  assert.equal(f.mediaRequests.length, 1, 'call must recheck recording ownership after the wait');
  assert.equal(f.c.recording, recorder);
  assert.equal(defined(f.c.recordDraft).status, 'recording');
  assert.equal(f.c.callStarting, false);
  assert.equal(defined(f.tracks[0]).stops, 0);
  assert.match(defined(f.toasts.at(-1)), /Finish your recording/);
  await f.click('[data-action="cancel-record"]');
});

test('unload or call-generation cancellation during speech shutdown prevents late microphone acquisition', async () => {
  for (const reason of ['unload', 'cancel']) {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.c.speakingId = 'reading';
    f.c.speech.stop = () => new Promise<void>((resolve) => (finish = resolve));
    const pending = f.c.startCall();
    await settle();
    if (reason === 'unload') f.c.unloading = true;
    else f.c.callGeneration++;
    defined(finish)();
    await pending.catch(() => {});
    assert.equal(f.mediaRequests.length, 0, reason);
    assert.equal(f.c.callStarting, false);
  }
});

test('Send voice is disabled while an unrelated text send or attachment upload owns the composer', async () => {
  const f = fixture();
  await f.click('[data-action="record"]');
  for (const key of ['sending', 'uploading'] as const) {
    if (key === 'uploading') f.c.uploading = 1;
    else f.c.sending = true;
    f.c.render();
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="send-voice"]')).disabled,
      true,
    );
    await f.click('[data-action="send-voice"]');
    assert.equal(f.messages.length, 0);
    if (key === 'uploading') f.c.uploading = 0;
    else f.c.sending = false;
  }
  await f.click('[data-action="cancel-record"]');
});
