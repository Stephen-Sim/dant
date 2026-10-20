import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { readAppState } from '../../../../ui/app/application-state.mts';
import type { AppState } from '../../../../ui/app/application-types.ts';
import { ConnectionStatus } from '../../../../ui/shared/states.mts';
import { managedMemoryFixture } from '../../../support/memory-management-fixtures.mts';

const scenario = process.argv[2] ?? 'navigation';
const syntheticComputerResources = {
  cpu: { default: 7, min: 3, max: 11 },
  memoryGB: { default: 19, min: 5, max: 29 },
  diskGB: { default: 137, min: 73, max: 257 },
};
const page = parseHTML(
  '<!doctype html><html><head></head><body><div id="app"></div></body></html>',
);
const storage = new Map<string, string>();
storage.set('dant.language', 'en');
const localStorage: Storage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => {
    storage.delete(key);
  },
  setItem: (key, value) => {
    storage.set(key, value);
  },
};
const intervals = new Set<ReturnType<typeof setInterval>>();
const timeouts = new Set<ReturnType<typeof setTimeout>>();
const fixtureTrack = {
  enabled: true,
  stopped: 0,
  stop() {
    this.stopped++;
  },
};
const fixtureStream = { getTracks: () => [fixtureTrack], getAudioTracks: () => [fixtureTrack] };
let mediaAcquisitions = 0;
class FixturePeer {
  static instances: FixturePeer[] = [];
  connectionState = 'new';
  remoteDescription: unknown = null;
  localDescription: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack:
    ((event: { streams: (typeof fixtureStream)[]; track: typeof fixtureTrack }) => void) | null =
    null;
  channel = {
    readyState: 'open',
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
  };
  constructor() {
    FixturePeer.instances.push(this);
  }
  addTrack(track: typeof fixtureTrack, stream: typeof fixtureStream) {
    assert.equal(track, fixtureTrack);
    assert.equal(stream, fixtureStream);
  }
  createDataChannel(name: string) {
    assert.equal(name, 'oai-events');
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'synthetic-offer' };
  }
  async setLocalDescription(value: unknown) {
    this.localDescription = value;
  }
  async setRemoteDescription(value: unknown) {
    this.remoteDescription = value;
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
  close() {
    this.connectionState = 'closed';
  }
}
class FixtureAudio {
  autoplay = false;
  srcObject: unknown = null;
  playCount = 0;
  async play() {
    this.playCount++;
  }
  pause() {}
}
class FixtureImage {
  naturalWidth = 800;
  naturalHeight = 600;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    if (value) queueMicrotask(() => this.onload?.());
  }
  async decode() {}
}
class FixtureRecognition {
  static instances: FixtureRecognition[] = [];
  onresult:
    ((event: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor() {
    FixtureRecognition.instances.push(this);
  }
  start() {}
  abort() {
    this.onend?.();
  }
}
class FixtureUtterance {
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}
const utterances: FixtureUtterance[] = [];
class BrowserFormData extends FormData {
  constructor(form?: HTMLElement) {
    super();
    if (!form) return;
    for (const control of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >('[name]')) {
      if (control.hasAttribute('disabled')) continue;
      if (
        control instanceof page.HTMLInputElement &&
        ['checkbox', 'radio'].includes(control.type) &&
        !control.checked
      )
        continue;
      this.append(control.name, control.value);
    }
  }
}
class FixtureRecorder {
  static supported = true;
  static produceData = true;
  static instances: FixtureRecorder[] = [];
  static isTypeSupported(type: string) {
    return this.supported && type === 'audio/webm';
  }
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly mimeType: string;
  readonly stream: typeof fixtureStream;
  constructor(stream: typeof fixtureStream, options: { mimeType: string }) {
    assert.equal(stream, fixtureStream);
    this.stream = stream;
    this.mimeType = options.mimeType;
    FixtureRecorder.instances.push(this);
  }
  start(timeslice: number) {
    assert.equal(timeslice, 1000);
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  requestData() {
    if (FixtureRecorder.produceData)
      this.ondataavailable?.({ data: new Blob(['synthetic audio'], { type: this.mimeType }) });
  }
  stop() {
    this.requestData();
    this.state = 'inactive';
    this.onstop?.();
  }
}
Object.assign(page, { MediaRecorder: FixtureRecorder });
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
Object.assign(globalThis, {
  window: page,
  document: page.document,
  Node: page.Node,
  Element: page.Element,
  HTMLElement: page.HTMLElement,
  HTMLInputElement: page.HTMLInputElement,
  HTMLTextAreaElement: page.HTMLTextAreaElement,
  HTMLSelectElement: page.HTMLSelectElement,
  localStorage,
  RTCPeerConnection: FixturePeer,
  MediaRecorder: FixtureRecorder,
  Audio: FixtureAudio,
  Image: FixtureImage,
  SpeechRecognition: FixtureRecognition,
  SpeechSynthesisUtterance: FixtureUtterance,
  speechSynthesis: {
    getVoices: () => [],
    speak: (value: FixtureUtterance) => utterances.push(value),
    cancel: () => utterances.at(-1)?.onend?.(),
  },
  FormData: BrowserFormData,
  location: new URL('http://dant-fixture.invalid/'),
  requestAnimationFrame: (callback: FrameRequestCallback) => setImmediate(() => callback(0)),
  cancelAnimationFrame: (handle: ReturnType<typeof setImmediate>) => clearImmediate(handle),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '', fontSize: '14px' }),
  setInterval: (...args: Parameters<typeof setInterval>) => {
    const timer = originalSetInterval(...args);
    intervals.add(timer);
    return timer;
  },
  clearInterval: (timer: ReturnType<typeof setInterval>) => {
    intervals.delete(timer);
    originalClearInterval(timer);
  },
  setTimeout: (...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    timeouts.add(timer);
    return timer;
  },
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
    timeouts.delete(timer);
    originalClearTimeout(timer);
  },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    language: 'en-US',
    languages: ['en-US'],
    clipboard: { writeText: async () => {} },
    mediaDevices: {
      getUserMedia: async () => {
        mediaAcquisitions++;
        return fixtureStream;
      },
    },
  },
});
Object.defineProperty(page.document, 'visibilityState', { value: 'visible', configurable: true });
page.document.hasFocus = () => true;
page.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 800,
  bottom: 600,
  width: 800,
  height: 600,
  toJSON: () => ({}),
});
page.HTMLElement.prototype.getClientRects = function () {
  return {
    0: this.getBoundingClientRect(),
    length: 1,
    item: () => this.getBoundingClientRect(),
    [Symbol.iterator]: function* () {
      yield page.document.body.getBoundingClientRect();
      return undefined;
    },
  };
};
page.HTMLElement.prototype.scrollIntoView = () => {};
Object.assign(page.HTMLElement.prototype, {
  reportValidity: () => true,
  setPointerCapture: () => {},
});
Object.defineProperty(page.HTMLElement.prototype, 'elements', {
  configurable: true,
  get(this: HTMLElement) {
    return {
      namedItem: (name: string) =>
        [...this.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')].find(
          (input) => input.name === name,
        ) ?? null,
    };
  },
});
// LinkeDOM exposes a read-only select value; the browser boundary also supports selection writes.
Object.defineProperty(page.HTMLSelectElement.prototype, 'value', {
  configurable: true,
  get(this: HTMLSelectElement) {
    return (
      this.querySelector<HTMLOptionElement>('option[selected]')?.value ??
      this.querySelector<HTMLOptionElement>('option')?.value ??
      ''
    );
  },
  set(this: HTMLSelectElement, value: string) {
    for (const option of this.querySelectorAll<HTMLOptionElement>('option'))
      option.selected = option.value === value;
  },
});

class FixtureEvents {
  static instances: FixtureEvents[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: { data: string }) => void>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FixtureEvents.instances.push(this);
  }
  addEventListener(name: string, callback: (event: { data: string }) => void) {
    this.listeners.set(name, callback);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) });
  }
}
Object.assign(globalThis, { EventSource: FixtureEvents });
const requests: string[] = [];
const computerInputs: unknown[] = [];
let sendFailure: { error: string; code?: string; unknownOutcome?: boolean } | null = null;
let unknownMessageId = '';
const unexpected: string[] = [];
const state: AppState = readAppState({
  mode: 'vm-controller',
  conversationId: 'fixture-conversation',
  settings: { language: 'en', vm: { host: '192.0.2.44', user: 'fixture', port: 22 } },
  worker: { status: ConnectionStatus.Online, models: [], account: null },
  controller: { status: ConnectionStatus.Online, cached: false },
  messages: [
    {
      id: 'fixture-user',
      role: 'user',
      text: 'A synthetic request',
      time: 1792460080000,
      status: 'completed',
    },
    {
      id: 'fixture-assistant',
      role: 'assistant',
      text: 'A synthetic answer',
      time: 1792460081000,
      status: 'completed',
    },
  ],
  active: null,
  queue: [],
  call: null,
  work: [],
});
if (scenario === 'computer-controls') {
  state.computer = { status: 'dant' };
}
if (scenario === 'onboarding' || scenario === 'computer-resources') {
  state.messages = [];
  state.settings.vm.host = '';
  state.worker.status = ConnectionStatus.Offline;
}
if (scenario === 'vm-settings') {
  state.settings.vm.keyPath = 'synthetic-key-file';
  assert.ok(state.controller);
  state.controller.serviceUpdate = {
    status: 'current',
    reason: 'fixture-current',
    confirmed: true,
    targetVersion: '0.4.7-beta.19',
    runningVersion: '0.4.7-beta.19',
  };
}
const telegramState = {
  enabled: false,
  configured: false,
  connected: false,
  paired: false,
  sync: { forwardMode: 'unread', combineReplies: true, readState: 'independent' },
};
if (scenario === 'chat-actions') {
  state.messages[1]!.text += ' https://example.invalid/synthetic';
  state.messages[1]!.attachments = [
    { id: 'fixture-image', name: 'synthetic.png', type: 'image/png', size: 20 },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'synthetic.md',
      type: 'text/markdown',
      size: 30,
    },
    { id: 'fixture-audio', name: 'synthetic.wav', type: 'audio/wav', size: 40 },
  ];
  state.messages.push({
    id: 'fixture-reply',
    role: 'user',
    text: 'A synthetic reply',
    replyTo: 'fixture-assistant',
    time: 1792460082000,
    status: 'paused',
    assistantReaction: '👍',
    receivedAt: 1792460082000,
  });
  state.messages.push({
    id: 'fixture-call-log',
    role: 'user',
    kind: 'call',
    text: '',
    seconds: 15,
    time: 1792460083000,
    status: 'completed',
  });
}
Object.assign(globalThis, {
  fetch: async (input: string | URL | Request, options: RequestInit = {}) => {
    const route = String(input);
    assert.ok(route.startsWith('/api/'), 'Every request stays inside the in-memory API fixture.');
    requests.push(`${options.method ?? 'GET'} ${route}`);
    let value: unknown;
    if (route === '/api/session') value = { token: 'a'.repeat(64) };
    else if (route === '/api/version') value = { version: '0.4.7-beta.19' };
    else if (route === '/api/state')
      value = scenario === 'invalid-state' ? { invalid: true } : state;
    else if (route === '/api/controller/settings')
      value = {
        version: '0.4.7-beta.19',
        language: 'en',
        vm: state.settings.vm,
        status: ConnectionStatus.Online,
        serviceUpdate: null,
        updatesPaused: false,
        profiles: { candidates: [] },
        providers: { availableProviders: [] },
      };
    else if (route === '/api/vm/profiles')
      value = {
        candidates:
          scenario === 'vm-settings'
            ? [
                {
                  id: 'fixture-profile',
                  host: '192.0.2.45',
                  user: 'fixture',
                  port: 22,
                  keyPath: 'synthetic-key-file',
                },
              ]
            : [],
      };
    else if (route === '/api/desktop/update-draft') value = { draft: null };
    else if (route === '/api/call') {
      assert.ok(typeof options.body === 'string');
      const body: unknown = JSON.parse(options.body);
      assert.deepEqual(body, { sdp: 'synthetic-offer', provider: 'subscription' });
      state.call = { id: 'fixture-call', provider: 'subscription', status: 'connecting' };
      value = { callId: 'fixture-call', sdp: 'synthetic-answer' };
    } else if (route === '/api/call/connected') {
      assert.ok(state.call);
      state.call.status = 'connected';
      value = { connectedAt: Date.now() };
    } else if (route === '/api/call/stop') {
      state.call = null;
      value = { ok: true };
    } else if (route === '/api/messages') {
      if (sendFailure) {
        const body: unknown = JSON.parse(String(options.body));
        assert.ok(body && typeof body === 'object');
        if ('clientMessageId' in body && typeof body.clientMessageId === 'string')
          unknownMessageId = body.clientMessageId;
        return new Response(JSON.stringify(sendFailure), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      assert.ok(typeof options.body === 'string');
      const body: unknown = JSON.parse(options.body);
      assert.ok(
        body !== null &&
          typeof body === 'object' &&
          'text' in body &&
          typeof body.text === 'string',
      );
      state.messages.push({
        id: 'fixture-sent',
        role: 'user',
        text: body.text,
        status: 'queued',
        time: Date.now(),
      });
      value = { submission: 'acknowledged' };
    } else if (route === '/api/read') value = { ok: true, messageIds: [] };
    else if (route === '/api/connect') {
      state.worker.status = ConnectionStatus.Online;
      value = { ok: true };
    } else if (route === '/api/service-update') {
      assert.ok(state.controller);
      state.controller.updatesPaused = String(options.body).includes('"pause"');
      value = { ok: true };
    } else if (route === '/api/vm/import') {
      assert.equal(options.body, JSON.stringify({ id: 'fixture-profile' }));
      state.settings.vm = {
        host: '192.0.2.45',
        user: 'fixture',
        port: 22,
        keyPath: 'synthetic-key-file',
      };
      value = { ok: true };
    } else if (route === '/api/upload') {
      assert.ok(options.body instanceof FormData);
      const file = options.body.get('file');
      assert.ok(file instanceof File);
      assert.equal(file.type, 'audio/webm');
      assert.ok(file.size > 0);
      value = { id: 'fixture-upload', name: file.name, type: file.type, size: file.size };
    } else if (/^\/api\/messages\/[^/]+\/metadata$/.test(route)) {
      const message = state.messages.find(
        (message) => route === `/api/messages/${message.id}/metadata`,
      );
      assert.ok(message);
      assert.equal(options.method, 'PATCH');
      assert.equal(typeof options.body, 'string');
      const patch: unknown = JSON.parse(String(options.body));
      assert.ok(patch && typeof patch === 'object' && 'conversationId' in patch);
      assert.equal(patch.conversationId, state.conversationId);
      if ('pinned' in patch) {
        assert.equal(typeof patch.pinned, 'boolean');
        message.pinned = patch.pinned === true;
      }
      if ('starred' in patch) {
        assert.equal(typeof patch.starred, 'boolean');
        message.starred = patch.starred === true;
      }
      value = {
        conversationId: state.conversationId,
        message: {
          id: message.id,
          pinned: message.pinned === true,
          starred: message.starred === true,
        },
      };
    } else if (route === '/api/messages/fixture-assistant/reaction') {
      assert.equal(options.body, JSON.stringify({ emoji: '👍' }));
      state.messages[1]!.reactions = ['👍'];
      value = { ok: true };
    } else if (route === '/api/messages/fixture-user' && options.method === 'PATCH') {
      assert.equal(typeof options.body, 'string');
      const patch: unknown = JSON.parse(String(options.body));
      assert.ok(
        patch && typeof patch === 'object' && 'text' in patch && typeof patch.text === 'string',
      );
      state.messages[0]!.text = patch.text;
      state.messages[0]!.editedAt = Date.now();
      value = { ok: true };
    } else if (route === '/api/messages/fixture-reply' && options.method === 'DELETE') {
      state.messages = state.messages.filter((message) => message.id !== 'fixture-reply');
      value = { ok: true };
    } else if (route === '/api/fonts')
      value = { fonts: ['Fixture Sans'], source: 'isolated fixture' };
    else if (route === '/api/credentials') value = { items: [], requests: [] };
    else if (route === '/api/skills') value = { items: [] };
    else if (route === '/api/voices') value = { voices: ['fixture-voice'] };
    else if (route === '/api/telegram') value = telegramState;
    else if (route === '/api/telegram/config') {
      const patch: unknown = JSON.parse(String(options.body));
      assert.ok(patch && typeof patch === 'object');
      Object.assign(telegramState, patch);
      if ('forwardMode' in patch || 'combineReplies' in patch)
        Object.assign(telegramState.sync, patch);
      if ('token' in patch) telegramState.configured = true;
      value = telegramState;
    } else if (route === '/api/telegram/pair')
      value = {
        code: 'SYNTHETIC',
        expiresAt: Date.now() + 60000,
        bot: { username: 'fixture_bot' },
      };
    else if (route === '/api/telegram/disconnect') {
      telegramState.paired = false;
      if (String(options.body).includes('"clearToken":true')) {
        telegramState.configured = false;
        telegramState.enabled = false;
      }
      value = telegramState;
    } else if (route === '/api/voice-key') {
      state.worker.realtime = {
        ...state.worker.realtime,
        key: { configured: options.method !== 'DELETE' },
      };
      value = { ok: true };
    } else if (route === '/api/takeover') {
      assert.ok(state.computer);
      const body: unknown = JSON.parse(String(options.body));
      assert.ok(
        body && typeof body === 'object' && 'enabled' in body && typeof body.enabled === 'boolean',
      );
      state.computer.status = body.enabled ? 'human' : 'dant';
      state.computer.sessionId = body.enabled ? 'synthetic-control' : null;
      value = { ok: true };
    } else if (route === '/api/input') {
      const body: unknown = JSON.parse(String(options.body));
      assert.ok(
        body &&
          typeof body === 'object' &&
          'sessionId' in body &&
          body.sessionId === 'synthetic-control',
      );
      computerInputs.push(body);
      value = { ok: true };
    } else if (route === '/api/screen')
      return new Response(new Blob(['synthetic image'], { type: 'image/png' }));
    else if (route === '/api/files/22222222-2222-4222-8222-222222222222')
      return new Response('A synthetic **document**', {
        headers: { 'content-type': 'text/markdown' },
      });
    else if (route === '/api/vm/providers')
      value = { availableProviders: [{ id: 'hyperv', available: true }] };
    else if (route === '/api/provision') {
      const body: unknown = JSON.parse(String(options.body));
      assert.ok(body && typeof body === 'object' && 'memoryGB' in body && 'diskGB' in body);
      assert.equal(body.memoryGB, scenario === 'computer-resources' ? 19 : 8);
      assert.equal(body.diskGB, scenario === 'computer-resources' ? 137 : 64);
      value = { status: 'creating', running: true, provider: 'hyperv' };
      state.provisioning = { status: 'creating', running: true, provider: 'hyperv' };
    } else if (route.startsWith('/api/memory/manage?'))
      value = managedMemoryFixture(state.conversationId, 'Synthetic durable memory');
    else if (route === '/api/settings' && options.method === 'PATCH') {
      assert.ok(typeof options.body === 'string');
      const patch: unknown = JSON.parse(options.body);
      assert.ok(patch !== null && typeof patch === 'object' && !Array.isArray(patch));
      const previousVM = state.settings.vm;
      Object.assign(state.settings, patch);
      if ('vm' in patch) state.settings.vm = { ...previousVM, ...state.settings.vm };
      value = { ok: true };
    } else if (route === '/api/backups')
      value = {
        settings: {
          mode: 'manual',
          intervalMinutes: 60,
          onConnect: false,
          beforeVmChange: true,
          retainCount: 5,
        },
        availability: { online: true, supported: true },
        backups: [],
        phase: 'idle',
        lastBackupAt: null,
        lastError: null,
        nextAt: null,
        lastRestoredId: null,
      };
    else if (route === '/api/schedules') value = { items: [] };
    else if (route === '/api/updates?channel=beta')
      value = { status: 'current', version: '0.4.7-beta.19', channel: 'beta' };
    else {
      unexpected.push(route);
      throw Error(`An unconfigured API route was attempted: ${route}`);
    }
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
});

const packageUrl = new URL('../../../../package.json', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (
      scenario === 'computer-resources' &&
      url === new URL('../../../../resources/config/computer.json', import.meta.url).href
    )
      return {
        format: 'json',
        source: JSON.stringify(syntheticComputerResources),
        shortCircuit: true,
      };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url === packageUrl)
      return {
        format: 'module',
        source: `export default ${fs.readFileSync(fileURLToPath(url), 'utf8')}`,
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
const settle = async () => {
  for (let index = 0; index < 16; index++) await new Promise((resolve) => setImmediate(resolve));
};
const click = async (selector: string) => {
  const element = page.document.querySelector<HTMLElement>(selector);
  assert.ok(element, `The actual UI must expose ${selector}.`);
  element.click();
  await settle();
};
try {
  await import('../../../../ui/main.mts');
  await settle();
  assert.ok(requests.includes('GET /api/session'));
  assert.ok(requests.includes('GET /api/state'));
  if (scenario === 'invalid-state') {
    assert.ok(
      page.document.querySelector('[data-recovery-settings]'),
      page.document.body.textContent ?? '',
    );
    await click('[data-recovery-settings]');
    assert.equal(
      page.document.querySelector<HTMLInputElement>('[data-recovery-field="host"]')?.value,
      '192.0.2.44',
    );
    assert.ok(page.document.querySelector('[data-recovery-form]'));
  } else if (scenario === 'speech') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    const composer = page.document.querySelector<HTMLTextAreaElement>('#composer');
    assert.ok(composer);
    composer.value = 'An existing draft';
    composer.dispatchEvent(new page.Event('input'));
    await click('[data-action="attach-menu"]');
    await click('[data-action="dictate"]');
    assert.equal(FixtureRecognition.instances.length, 1);
    FixtureRecognition.instances[0]?.onresult?.({
      results: [{ isFinal: true, 0: { transcript: 'synthetic dictated text' } }],
    });
    FixtureRecognition.instances[0]?.onend?.();
    await settle();
    assert.equal(
      page.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
      'An existing draft synthetic dictated text',
    );
    await click('[data-message-more="fixture-assistant"]');
    await click('[data-message-speak="fixture-assistant"]');
    assert.equal(utterances.at(-1)?.text, 'A synthetic answer');
    assert.ok(page.document.querySelector('[data-action="speech-stop"]'));
    await click('[data-action="speech-stop"]');
    assert.equal(page.document.querySelector('[data-action="speech-stop"]'), null);
    await click('[data-action="attach-menu"]');
    await click('[data-action="dictate"]');
    await click('[data-action="settings"]');
    assert.ok(page.document.querySelector('.settings-layout'));
    assert.equal(page.document.querySelector('.composer-status'), null);
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'vm-settings') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    await click('[data-action="settings"]');
    await click('[data-settings-category="computer"]');
    await click('[data-action="service-pause"]');
    assert.equal(state.controller?.updatesPaused, true);
    await click('[data-action="service-resume"]');
    assert.equal(state.controller?.updatesPaused, false);
    await click('[data-action="connect"]');
    assert.ok(requests.includes('POST /api/connect'));
    state.settings.vm.keyPath = '';
    FixtureEvents.instances[0]?.emit('state', state);
    await settle();
    await click('[data-action="use-existing"]');
    assert.ok(page.document.querySelector('[name="vm-profile"][value="fixture-profile"]'));
    await click('[data-action="import-vm-profile"]');
    assert.ok(requests.includes('POST /api/vm/import'));
    assert.equal(state.settings.vm.host, '192.0.2.45');
    await click('[data-action="use-existing"]');
    const host = page.document.querySelector<HTMLInputElement>('#vm-form [name="host"]');
    assert.ok(host);
    host.value = '192.0.2.46';
    host.dispatchEvent(new page.Event('input', { bubbles: true }));
    page.document
      .querySelector('#vm-form')
      ?.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(state.settings.vm.host, '192.0.2.46');
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'onboarding' || scenario === 'computer-resources') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    assert.ok(page.document.querySelector('[data-action="onboarding-import"]'));
    await click('[data-action="onboarding-new"]');
    assert.ok(page.document.querySelector('[data-action="onboarding-create"]'));
    await click('[data-action="onboarding-back"]');
    assert.ok(page.document.querySelector('[data-action="onboarding-import"]'));
    await click('[data-action="onboarding-new"]');
    await click('[data-action="onboarding-create"]');
    assert.ok(page.document.querySelector('.setup-dialog'));
    if (scenario === 'computer-resources') {
      for (const [name, resource] of Object.entries(syntheticComputerResources)) {
        const input = page.document.querySelector<HTMLInputElement>(`[name="${name}"]`);
        assert.ok(input);
        assert.equal(input.value, String(resource.default));
        assert.equal(input.getAttribute('min'), String(resource.min));
        assert.equal(input.getAttribute('max'), String(resource.max));
      }
    } else {
      assert.equal(page.document.querySelector<HTMLInputElement>('[name="memoryGB"]')?.value, '8');
      assert.equal(page.document.querySelector<HTMLInputElement>('[name="diskGB"]')?.value, '64');
    }
    page.document
      .querySelector('#provision-form')
      ?.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.ok(
      requests.includes('POST /api/provision'),
      JSON.stringify({ requests, toast: page.document.querySelector('#toast')?.textContent }),
    );
    assert.ok(page.document.querySelector('.setup-phases .current'));
    state.provisioning = {
      status: 'ready',
      running: false,
      provider: 'hyperv',
      connection: { host: '192.0.2.44' },
    };
    FixtureEvents.instances[0]?.emit('state', state);
    await settle();
    await click('[data-action="setup-done"]');
    assert.equal(page.document.querySelector('.setup-dialog'), null);
    assert.equal(page.document.querySelector('.first-run'), null);
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'send-errors') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    for (const [failure, expected] of [
      [
        { error: 'The service requires an update.', code: 'service_update_required' },
        /automatically|updating/,
      ],
      [
        { error: 'The VM rejected the update.', code: 'vm_update_unconfirmed' },
        /update|work computer/i,
      ],
      [{ error: 'Telegram rejected the request (401)' }, /401/],
      [{ error: 'No VM connection is configured.' }, /work computer|connection/i],
      [{ error: 'Timed out: synthetic operation' }, /synthetic operation/],
      [{ error: 'A synthetic refusal' }, /A synthetic refusal/],
    ] as const) {
      sendFailure = failure;
      const composer = page.document.querySelector<HTMLTextAreaElement>('#composer');
      assert.ok(composer);
      composer.value = 'An unchanged synthetic draft';
      composer.dispatchEvent(new page.Event('input'));
      page.document
        .querySelector('#message-form')
        ?.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      assert.match(page.document.querySelector('#toast')?.textContent ?? '', expected);
      assert.equal(
        page.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
        'An unchanged synthetic draft',
      );
    }
    sendFailure = { error: 'An outcome cannot be confirmed', unknownOutcome: true };
    page.document
      .querySelector('#message-form')
      ?.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.ok(page.document.querySelector('.unconfirmed-send'));
    const sentCount = requests.filter((value) => value === 'POST /api/messages').length;
    await click('[data-action="check-send"]');
    assert.equal(requests.filter((value) => value === 'POST /api/messages').length, sentCount);
    state.messages.push({
      id: 'fixture-acknowledged',
      role: 'user',
      text: 'An unchanged synthetic draft',
      clientMessageId: unknownMessageId,
      time: Date.now(),
      status: 'queued',
    });
    await click('[data-action="check-send"]');
    assert.equal(page.document.querySelector('.unconfirmed-send'), null);
    assert.equal(page.document.querySelector<HTMLTextAreaElement>('#composer')?.value, '');
    assert.equal(requests.filter((value) => value === 'POST /api/messages').length, sentCount);
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'settings-operations') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    await click('[data-action="settings"]');
    await click('[data-settings-category="appearance"]');
    await click('[data-accent="#8660D9"]');
    assert.equal(state.settings.accentColor, '#8660D9');
    await click('[data-reset-color="backgroundColor"]');
    assert.equal(state.settings.backgroundColor, null);
    const size = page.document.querySelector<HTMLInputElement>('#appearance-size');
    assert.ok(size);
    size.value = '16';
    size.dispatchEvent(new page.Event('change'));
    await settle();
    assert.equal(state.settings.fontSize, 16);
    await click('[data-font="mono"]');
    assert.equal(state.settings.font, 'mono');
    await click('#appearance-export');
    await click('[data-settings-category="telegram"]');
    const tokenInput = page.document.querySelector<HTMLInputElement>('#telegram-token');
    assert.ok(tokenInput);
    tokenInput.value = 'synthetic-token';
    page.document
      .querySelector('#telegram-token-form')
      ?.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(telegramState.configured, true);
    assert.equal(page.document.querySelector<HTMLInputElement>('#telegram-token')?.value, '');
    await click('[data-action="telegram-toggle"]');
    assert.equal(telegramState.enabled, true);
    await click('[data-action="telegram-pair"]');
    assert.match(
      page.document.querySelector('.telegram-pair-code')?.textContent ?? '',
      /SYNTHETIC/,
    );
    await click('[data-action="telegram-unpair"]');
    assert.equal(page.document.querySelector('.telegram-pair-code'), null);
    const forwarding = page.document.querySelector<HTMLSelectElement>('#telegram-forward-mode');
    assert.ok(forwarding);
    forwarding.value = 'all';
    forwarding.dispatchEvent(new page.Event('change'));
    await settle();
    assert.equal(telegramState.sync.forwardMode, 'all');
    const combine = page.document.querySelector<HTMLInputElement>('#telegram-combine-replies');
    assert.ok(combine);
    combine.checked = false;
    combine.dispatchEvent(new page.Event('change'));
    await settle();
    assert.equal(telegramState.sync.combineReplies, false);
    await click('[data-action="telegram-remove"]');
    assert.equal(telegramState.configured, false);
    await click('[data-settings-category="voice"]');
    const key = page.document.querySelector<HTMLInputElement>('#voice-api-key');
    assert.ok(key);
    key.value = 'synthetic-key';
    page.document
      .querySelector('#voice-key-form')
      ?.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.ok(requests.includes('POST /api/voice-key'));
    await click('#voice-key-remove');
    assert.ok(requests.includes('DELETE /api/voice-key'));
    await click('[data-action="schedules"]');
    assert.ok(page.document.querySelector('.schedules-page'));
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'computer-controls') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    await click('[data-action="computer"]');
    assert.ok(page.document.querySelector('#computer-panel'));
    assert.ok(requests.includes('GET /api/screen'));
    assert.ok(page.document.querySelector<HTMLImageElement>('#screen')?.src.startsWith('blob:'));
    await click('[data-action="takeover"]');
    assert.equal(state.computer?.status, 'human');
    const target = page.document.querySelector<HTMLElement>('#screen-target');
    const image = page.document.querySelector<HTMLImageElement>('#screen');
    const input = page.document.querySelector<HTMLTextAreaElement>('#vm-ime');
    assert.ok(target && image && input);
    Object.assign(image, { naturalWidth: 800, naturalHeight: 600 });
    const event = (type: string, props: Record<string, unknown> = {}) =>
      Object.assign(new page.Event(type, { bubbles: true, cancelable: true }), props);
    target.dispatchEvent(
      event('pointerdown', { pointerId: 1, clientX: 20, clientY: 30, button: 0 }),
    );
    target.dispatchEvent(event('pointerup', { pointerId: 1, clientX: 20, clientY: 30, button: 0 }));
    target.dispatchEvent(
      event('pointerdown', { pointerId: 2, clientX: 40, clientY: 50, button: 0 }),
    );
    target.dispatchEvent(
      event('pointerup', { pointerId: 2, clientX: 80, clientY: 100, button: 0 }),
    );
    // LinkeDOM has no wheel event dispatcher; exercise the installed browser callback.
    target.onwheel?.({ deltaY: 20, preventDefault() {} } as WheelEvent);
    input.value = 'synthetic input';
    input.dispatchEvent(event('input', { isComposing: false }));
    input.dispatchEvent(event('keydown', { key: 'ArrowLeft', isComposing: false }));
    await settle();
    assert.equal(
      requests.filter((request) => request === 'POST /api/input').length,
      5,
      JSON.stringify(computerInputs),
    );
    await click('[data-action="takeover"]');
    assert.equal(state.computer?.status, 'dant');
    await click('[data-action="screen-refresh"]');
    await click('[data-action="hide-computer"]');
    assert.equal(page.document.querySelector('#computer-panel'), null);
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'voice-message') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    FixtureRecorder.supported = false;
    await click('[data-action="record"]');
    assert.match(
      page.document.querySelector('#toast')?.textContent ?? '',
      /cannot record WebM or Ogg/i,
    );
    assert.equal(mediaAcquisitions, 0);
    FixtureRecorder.supported = true;
    await click('[data-action="record"]');
    assert.equal(FixtureRecorder.instances[0]?.state, 'recording');
    await click('[data-action="pause-record"]');
    assert.equal(FixtureRecorder.instances[0]?.state, 'paused');
    assert.ok(page.document.querySelector('audio[data-key^="voice-preview"]'));
    await click('[data-action="pause-record"]');
    assert.equal(FixtureRecorder.instances[0]?.state, 'recording');
    await click('[data-action="pause-record"]');
    await click('[data-action="send-voice"]');
    assert.ok(requests.includes('POST /api/upload'));
    assert.ok(requests.includes('POST /api/messages'));
    assert.equal(page.document.querySelector('.voice-message-recorder'), null);
    assert.ok(fixtureTrack.stopped > 0);
    FixtureRecorder.produceData = false;
    await click('[data-action="record"]');
    await click('[data-action="send-voice"]');
    assert.match(page.document.querySelector('#toast')?.textContent ?? '', /empty|no audio/i);
    assert.ok(page.document.querySelector('.voice-message-recorder'));
    await click('[data-action="cancel-record"]');
    assert.equal(page.document.querySelector('.voice-message-recorder'), null);
    await click('[data-action="record"]');
    FixtureRecorder.instances.at(-1)?.onerror?.();
    await settle();
    assert.match(page.document.querySelector('#toast')?.textContent ?? '', /record/i);
    assert.equal(page.document.querySelector('.voice-message-recorder'), null);
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'chat-actions') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    await click('[data-reply="fixture-assistant"]');
    assert.match(
      page.document.querySelector('.reply-preview')?.textContent ?? '',
      /A synthetic answer/,
    );
    await click('[data-action="cancel-reply"]');
    assert.equal(page.document.querySelector('.reply-preview'), null);
    await click('[data-picker="fixture-assistant"]');
    assert.ok(page.document.querySelector('.reaction-menu'));
    await click('[data-react="fixture-assistant"][data-emoji="👍"]');
    assert.ok(requests.includes('POST /api/messages/fixture-assistant/reaction'));
    await click('[data-message-more="fixture-assistant"]');
    await click('[data-message-pin="fixture-assistant"]');
    assert.match(
      page.document.querySelector('.chat-pinned-bar')?.textContent ?? '',
      /A synthetic answer/,
    );
    await click('[data-message-more="fixture-assistant"]');
    await click('[data-message-star="fixture-assistant"]');
    await click('[data-action="details"]');
    await click('[data-chat-collection="starred"]');
    assert.match(
      page.document.querySelector('.chat-collection-dialog')?.textContent ?? '',
      /A synthetic answer/,
    );
    await click('[data-collection-unpin="fixture-assistant"]');
    assert.equal(page.document.querySelector('.chat-pinned-bar'), null);
    await click('[data-collection-unstar="fixture-assistant"]');
    assert.match(
      page.document.querySelector('.chat-collection-empty')?.textContent ?? '',
      /No starred messages/,
    );
    await click('[data-action="close-modal"]');
    await click('[data-action="details"]');
    await click('[data-chat-collection="shared"]');
    assert.ok(page.document.querySelector('[data-collection-file="fixture-image"]'));
    await click('[data-collection-tab="docs"]');
    assert.ok(
      page.document.querySelector('[data-collection-file="22222222-2222-4222-8222-222222222222"]'),
    );
    await click('[data-collection-tab="links"]');
    assert.ok(
      page.document.querySelector('[data-collection-link="https://example.invalid/synthetic"]'),
    );
    await click('[data-collection-go="fixture-assistant"]');
    assert.equal(page.document.querySelector('.chat-collection-dialog'), null);
    await click('[data-action="details"]');
    await click('[data-chat-search]');
    const search = page.document.querySelector<HTMLInputElement>('#chat-search-input');
    assert.ok(search);
    search.value = 'answer';
    search.dispatchEvent(new page.Event('input'));
    await settle();
    await click('[data-search-message="fixture-assistant"]');
    assert.equal(page.document.querySelector('#chat-search-input'), null);
    await click('[data-preview="fixture-image"]');
    assert.ok(page.document.querySelector('.image-dialog img'));
    await click('[data-action="close-modal"]');
    await click('[data-file-preview="22222222-2222-4222-8222-222222222222"]');
    assert.match(
      page.document.querySelector('.file-preview-body')?.textContent ?? '',
      /synthetic \*\*document\*\*/,
      JSON.stringify({
        requests,
        unexpected,
        body: page.document.querySelector('.dialog')?.textContent,
      }),
    );
    await click('[data-action="close-modal"]');
    await click('[data-message-more="fixture-user"]');
    await click('[data-message-edit="fixture-user"]');
    const edit = page.document.querySelector<HTMLTextAreaElement>('#message-edit-form textarea');
    assert.ok(edit);
    edit.value = 'A synthetic edit';
    edit.dispatchEvent(new page.Event('input'));
    page.document
      .querySelector('#message-edit-form')
      ?.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(state.messages[0]?.text, 'A synthetic edit');
    assert.match(
      page.document.querySelector('[data-id="fixture-user"]')?.textContent ?? '',
      /Edited/,
    );
    await click('[data-message-more="fixture-reply"]');
    await click('[data-message-remove="fixture-reply"]');
    await click('[data-history-confirm-remove="fixture-reply"]');
    assert.equal(page.document.querySelector('[data-id="fixture-reply"]'), null);
    assert.deepEqual(unexpected, []);
  } else if (scenario === 'call-controls') {
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    await click('[data-action="progress"]');
    await click('[data-action="voice-mode"]');
    await click('[data-action="call"]');
    assert.equal(mediaAcquisitions, 1);
    assert.ok(requests.includes('POST /api/call/connected'));
    assert.ok(page.document.querySelector('.conversation .call-view'));
    assert.ok(page.document.querySelector('#work-progress-panel'));
    await click('[data-action="mute"]');
    assert.equal(fixtureTrack.enabled, false);
    await click('[data-action="mute"]');
    assert.equal(fixtureTrack.enabled, true);
    await click('[data-call-caption-toggle]');
    assert.equal(state.settings.showCallCaptions, false);
    await click('[data-call-caption-toggle]');
    assert.equal(state.settings.showCallCaptions, true);
    state.callCaption = {
      callId: 'fixture-call',
      provider: 'subscription',
      sequence: 1,
      text: 'Synthetic call transcript',
      final: true,
    };
    FixtureEvents.instances[0]?.emit('state', state);
    await settle();
    assert.match(page.document.body.textContent ?? '', /Synthetic call transcript/);
    await click('[data-action="call-size"]');
    assert.ok(page.document.querySelector('.conversation .call-view.mini'));
    assert.ok(page.document.querySelector('#work-progress-panel'));
    await click('[data-action="call-size"]');
    assert.ok(page.document.querySelector('.conversation .call-view:not(.mini)'));
    await click('[data-action="hangup"]');
    assert.equal(fixtureTrack.stopped, 1);
    assert.equal(FixturePeer.instances[0]?.connectionState, 'closed');
    assert.ok(requests.includes('POST /api/call/stop'));
    assert.equal(page.document.querySelector('.call-view'), null);
    await click('[data-action="text-mode"]');
    const composer = page.document.querySelector<HTMLTextAreaElement>('#composer');
    assert.ok(composer);
    composer.value = 'A synthetic follow-up';
    composer.dispatchEvent(new page.Event('input'));
    const form = page.document.querySelector('#message-form');
    assert.ok(form);
    form.dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.ok(requests.includes('POST /api/messages'));
    assert.equal(page.document.querySelector<HTMLTextAreaElement>('#composer')?.value, '');
    FixtureEvents.instances[0]?.emit('state', state);
    await settle();
    assert.match(page.document.body.textContent ?? '', /A synthetic follow-up/);
    assert.deepEqual(unexpected, []);
  } else {
    assert.ok(page.document.querySelector('.conversation'), page.document.body.textContent ?? '');
    assert.match(page.document.body.textContent ?? '', /A synthetic answer/);
    FixtureEvents.instances[0]?.onopen?.();
    await settle();
    await click('[data-action="progress"]');
    assert.ok(page.document.querySelector('#work-progress-panel'));
    await click('[data-action="progress"]');
    assert.equal(page.document.querySelector('#work-progress-panel'), null);
    await click('[data-action="voice-mode"]');
    assert.ok(page.document.querySelector('.call-ready'));
    await click('[data-action="text-mode"]');
    assert.ok(page.document.querySelector('#message-form'));
    await click('[data-action="settings"]');
    assert.ok(page.document.querySelector('[data-settings-category="history"]'));
    for (const category of [
      'appearance',
      'voice',
      'computer',
      'account',
      'usage',
      'credentials',
      'history',
      'telegram',
      'about',
      'general',
    ]) {
      await click(`[data-settings-category="${category}"]`);
      assert.equal(
        page.document.querySelector(`[data-settings-panel="${category}"]`)?.hasAttribute('hidden'),
        false,
      );
      if (category === 'appearance') {
        await click('[data-theme="dark"]');
        assert.equal(state.settings.theme, 'dark');
        await click('[data-theme="light"]');
        assert.equal(state.settings.theme, 'light');
      }
      if (category === 'history') assert.ok(page.document.querySelector('.vm-backups'));
      if (category === 'computer')
        assert.equal(page.document.querySelector('.vm-settings .vm-backups'), null);
    }
    await click('[data-action="chat"]');
    assert.match(page.document.body.textContent ?? '', /A synthetic answer/);
    await click('[data-action="settings"]');
    await click('[data-settings-category="history"]');
    await click('[data-action="memory"]');
    assert.match(page.document.body.textContent ?? '', /Synthetic durable memory/);
    await click('[data-action="chat"]');
    await click('[data-action="skills"]');
    assert.match(page.document.body.textContent ?? '', /Reusable tools and workflows/);
    await click('[data-action="chat"]');
    assert.deepEqual(unexpected, []);
  }
  console.log(JSON.stringify({ scenario, booted: true, requests: requests.length }));
} finally {
  page.dispatchEvent(new page.Event('beforeunload'));
  await settle();
  for (const timer of intervals) originalClearInterval(timer);
  for (const timer of timeouts) originalClearTimeout(timer);
  hooks.deregister();
}
