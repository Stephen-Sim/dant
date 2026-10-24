import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import {
  clipboardImages,
  composerAttachmentScope,
  createComposerAttachments,
  MAX_COMPOSER_ATTACHMENTS,
} from '../../../ui/chat/composer-attachments.mts';
import { MAX_ATTACHMENT_BYTES } from '../../../ui/files/attachment-limits.mts';
import { attachment, read } from '../../../ui/app/application-state.mts';
import { apiPath } from '../../../ui/platform/native-protocol.mts';
import { ConnectionStatus } from '../../../ui/shared/states.mts';
import type { Attachment } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { deferred } from '../../support/service-fixtures.mts';
import { sourceCallStatement, sourceDeclaration } from '../../support/source-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';

const image = (name = 'Screenshot.png', bytes = 'synthetic image') =>
  new File([bytes], name, { type: 'image/png', lastModified: 123 });
const item = (file: File | null, type = file?.type || 'image/png') => ({
  kind: 'file',
  type,
  getAsFile: () => file,
});
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

function fixture() {
  const { document, Event } = parseHTML('<main><textarea id="composer"></textarea></main>'),
    attachments: Attachment[] = [],
    requests: {
      file: File;
      signal: AbortSignal;
      response: ReturnType<typeof deferred<Attachment>>;
    }[] = [],
    errors: string[] = [],
    uploading: number[] = [];
  let online = true,
    scope = 'conversation-a/computer-a',
    renderCount = 0;
  const controller = createComposerAttachments({
    getScope: () => scope,
    isReady: () => online,
    getAttachments: () => attachments,
    request(file, signal) {
      const response = deferred<Attachment>();
      requests.push({ file, signal, response });
      return response.promise;
    },
    add: (file) => attachments.push(file),
    setUploading: (count) => uploading.push(count),
    render: () => {
      renderCount++;
      controller.bind(document.querySelector<HTMLTextAreaElement>('#composer'));
    },
    error: (key) => key,
    unavailable: () => 'connectionLost',
    failed: (error) => errors.push(error instanceof Error ? error.message : 'unexpected'),
  });
  controller.bind(document.querySelector<HTMLTextAreaElement>('#composer'));
  return {
    document,
    Event,
    controller,
    attachments,
    requests,
    errors,
    uploading,
    set online(value: boolean) {
      online = value;
      controller.sync();
    },
    set scope(value: string) {
      scope = value;
      controller.sync();
    },
    get renders() {
      return renderCount;
    },
    paste(files: File[], text = '', items = files.map((file) => item(file)), insertText = true) {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { files, items, getData: (type: string) => (type === 'text/plain' ? text : '') },
      });
      const composer = defined(document.querySelector<HTMLTextAreaElement>('#composer'));
      composer.dispatchEvent(event);
      if (!event.defaultPrevented && text && insertText) composer.value += text;
      return event;
    },
    complete(index = 0, id = 'upload-' + index) {
      const request = defined(requests[index]);
      request.response.resolve({ id, name: request.file.name, type: request.file.type });
    },
  };
}

test('clipboard images prefer item MIME files and do not upload the files/items representation twice', async () => {
  const file = image(),
    second = image('Second.png', 'another image');
  assert.deepEqual(clipboardImages({ files: [file], items: [item(file)] }), [file]);
  assert.deepEqual(clipboardImages({ items: [item(file), item(file), item(second)] }), [
    file,
    second,
  ]);
  assert.deepEqual(clipboardImages({ files: [file, second], items: [] }), [file, second]);
  assert.deepEqual(clipboardImages({ files: [file], items: [item(null)] }), [file]);
  assert.deepEqual(clipboardImages(null), []);
});

test('nameless clipboard images receive a stable extension and preserve their bytes and timestamp', async () => {
  const file = new File(['clipboard bytes'], '', { lastModified: 567 }),
    result = defined(clipboardImages({ items: [item(file, 'image/jpeg')] })[0]);
  assert.equal(result.name, 'image-1.jpg');
  assert.equal(result.type, 'image/jpeg');
  assert.equal(result.lastModified, 567);
  assert.equal(await result.text(), 'clipboard bytes');
  const unknown = defined(clipboardImages({ items: [item(file, 'image/x-synthetic')] })[0]);
  assert.equal(unknown.name, 'image-1.img');
  assert.equal(unknown.type, 'image/x-synthetic');
});

test('text, HTML, non-image files, empty images and mismatching item types remain native paste input', () => {
  const text = new File(['plain'], 'Note.txt', { type: 'text/plain' }),
    empty = image('Empty.png', '');
  assert.deepEqual(
    clipboardImages({
      files: [text, empty],
      items: [
        { kind: 'string', type: 'text/html', getAsFile: () => null },
        item(text),
        item(text, 'image/png'),
      ],
    }),
    [],
  );
  const f = fixture(),
    event = f.paste([], 'native pasted text');
  assert.equal(event.defaultPrevented, false);
  assert.equal(
    f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
    'native pasted text',
  );
  assert.equal(f.requests.length, 0);
});

test('image-only paste uploads once without sending a message, preserves typing and uses existing draft attachments', async () => {
  const f = fixture(),
    composer = defined(f.document.querySelector<HTMLTextAreaElement>('#composer')),
    file = image();
  composer.value = 'My existing draft';
  const event = f.paste([file]);
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(defined(f.requests[0]).file, file);
  assert.equal(defined(f.requests[0]).signal.aborted, false);
  composer.value += ' and new typing';
  f.complete();
  await settle();
  assert.deepEqual(f.attachments, [{ id: 'upload-0', name: 'Screenshot.png', type: 'image/png' }]);
  assert.equal(composer.value, 'My existing draft and new typing');
  assert.equal(f.uploading.at(-1), 0);
  assert.deepEqual(f.errors, []);
});

test('mixed text and image paste retains native text insertion before upload triggers rendering', async () => {
  const f = fixture(),
    composer = defined(f.document.querySelector<HTMLTextAreaElement>('#composer'));
  composer.value = 'Before ';
  const event = f.paste([image()], 'pasted text', [], false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.renders, 0, 'upload must not render before the native paste default action');
  await Promise.resolve();
  assert.equal(f.renders, 0, 'a listener microtask checkpoint cannot start an upload render');
  composer.value += 'pasted text';
  assert.equal(composer.value, 'Before pasted text');
  await settle();
  f.complete();
  await settle();
  assert.equal(composer.value, 'Before pasted text');
  assert.equal(f.attachments.length, 1);
});

test('clipboard and picker share the size and total attachment limit, including simultaneous uploads', async () => {
  const f = fixture();
  await assert.rejects(
    f.controller.upload(
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'Large.png', { type: 'image/png' }),
    ),
    /fileLimit/,
  );
  const pending = [];
  for (let index = 0; index < MAX_COMPOSER_ATTACHMENTS; index++)
    pending.push(f.controller.upload(image()));
  await assert.rejects(f.controller.upload(image()), /attachmentLimit/);
  assert.equal(f.requests.length, MAX_COMPOSER_ATTACHMENTS);
  f.requests.forEach((_request, index) => f.complete(index));
  await Promise.all(pending);
  assert.equal(f.attachments.length, MAX_COMPOSER_ATTACHMENTS);
  await assert.rejects(f.controller.upload(image()), /attachmentLimit/);
  assert.equal(f.uploading.at(-1), 0);
});

test('paste batches stop at the existing five-attachment limit without losing admitted images', async () => {
  const f = fixture();
  for (let index = 0; index < 4; index++)
    f.attachments.push({ id: 'existing-' + index, name: 'Old.png', type: 'image/png' });
  f.paste([image('First.png'), image('Second.png')]);
  await settle();
  f.complete();
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.attachments.length, 5);
  assert.deepEqual(f.errors, ['attachmentLimit']);
});

test('a large clipboard file list is bounded to five uploads and one count-limit notice', async () => {
  const f = fixture();
  f.paste(Array.from({ length: 105 }, (_value, index) => image(`Image-${index}.png`)));
  for (let index = 0; index < MAX_COMPOSER_ATTACHMENTS; index++) {
    await settle();
    f.complete(index);
  }
  await settle();
  assert.equal(f.requests.length, MAX_COMPOSER_ATTACHMENTS);
  assert.equal(f.attachments.length, MAX_COMPOSER_ATTACHMENTS);
  assert.deepEqual(f.errors, ['attachmentLimit']);
});

test('a batch cannot claim a sixth slot after other attachments fill the composer during its first upload', async () => {
  const f = fixture(),
    batch = f.controller.uploadFiles([image('Batch-first.png'), image('Must-not-be-uploaded.png')]),
    others = Array.from({ length: 4 }, () => f.controller.upload(image('Other.png')));
  f.complete(0);
  await batch;
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.errors, ['attachmentLimit']);
  others.forEach((_pending, index) => f.complete(index + 1));
  await Promise.all(others);
  assert.equal(f.attachments.length, 5);
  assert.equal(f.uploading.at(-1), 0);
});

test('upload failure preserves the text and admitted files and does not retry automatically', async () => {
  const f = fixture(),
    composer = defined(f.document.querySelector<HTMLTextAreaElement>('#composer'));
  composer.value = 'Still my draft';
  f.paste([image()]);
  await settle();
  defined(f.requests[0]).response.reject(Error('Upload failed'));
  await settle();
  assert.deepEqual(f.errors, ['Upload failed']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.attachments.length, 0);
  assert.equal(f.uploading.at(-1), 0);
  assert.equal(composer.value, 'Still my draft');
});

test('disconnect invalidates old uploads even after reconnect to the same computer and conversation', async () => {
  const f = fixture(),
    old = f.controller.upload(image('Old.png'));
  f.online = false;
  assert.equal(defined(f.requests[0]).signal.aborted, true);
  assert.equal(f.uploading.at(-1), 0);
  f.online = true;
  const fresh = f.controller.upload(image('Fresh.png'));
  f.complete(0, 'stale');
  await old;
  assert.equal(f.attachments.length, 0);
  assert.equal(f.uploading.at(-1), 1, 'late completion cannot release the new upload ownership');
  f.complete(1, 'fresh');
  await fresh;
  assert.deepEqual(
    f.attachments.map((file) => file.id),
    ['fresh'],
  );
});

test('conversation/computer changes discard late results and the remainder of a captured paste batch', async () => {
  const f = fixture();
  f.paste([image('Old.png'), image('Do-not-upload-to-new-target.png')]);
  await settle();
  f.scope = 'conversation-b/computer-b';
  f.scope = 'conversation-a/computer-a';
  f.complete();
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.attachments.length, 0);
  assert.equal(defined(f.requests[0]).signal.aborted, true);
  assert.deepEqual(f.errors, []);
});

test('a target change before the deferred paste task sends no upload to the replacement target', async () => {
  const f = fixture();
  f.paste([image()]);
  f.scope = 'replacement';
  await settle();
  assert.equal(f.requests.length, 0);
  assert.equal(f.attachments.length, 0);
});

test('disposal before the deferred paste task cancels the queued upload completely', async () => {
  const f = fixture();
  f.paste([image()]);
  f.controller.dispose();
  await settle();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.errors, []);
});

test('offline paste reports unavailable, permits plain text, and never uploads on later reconnect', async () => {
  const f = fixture();
  f.online = false;
  f.paste([image()], 'keep pasted text');
  await settle();
  assert.deepEqual(f.errors, ['connectionLost']);
  assert.equal(
    f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
    'keep pasted text',
  );
  f.online = true;
  await settle();
  assert.equal(f.requests.length, 0);
});

test('repeated binding and composer DOM replacement do not duplicate paste or retain detached handlers', async () => {
  const f = fixture(),
    old = defined(f.document.querySelector<HTMLTextAreaElement>('#composer'));
  for (let index = 0; index < 4; index++) f.controller.bind(old);
  f.paste([image()]);
  await settle();
  assert.equal(f.requests.length, 1);
  defined(f.document.querySelector('main')).innerHTML = '<textarea id="composer"></textarea>';
  f.controller.bind(f.document.querySelector<HTMLTextAreaElement>('#composer'));
  const detached = new f.Event('paste', { cancelable: true });
  Object.defineProperty(detached, 'clipboardData', {
    value: { files: [image()], items: [], getData: () => '' },
  });
  old.dispatchEvent(detached);
  await settle();
  assert.equal(detached.defaultPrevented, false);
  assert.equal(f.requests.length, 1);
  f.complete();
  await settle();
  assert.equal(f.attachments.length, 1);
  f.controller.bind(null);
  f.paste([image()]);
  await settle();
  assert.equal(f.requests.length, 1);
});

test('dispose cancels pending uploads and stale failures cannot toast or alter attachments', async () => {
  const f = fixture();
  f.paste([image()]);
  await settle();
  f.controller.dispose();
  assert.equal(defined(f.requests[0]).signal.aborted, true);
  defined(f.requests[0]).response.reject(Error('Stale failure'));
  await settle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.attachments.length, 0);
  assert.equal(f.uploading.at(-1), 0);
  f.paste([image()]);
  await settle();
  assert.equal(f.requests.length, 1);
  f.controller.dispose();
});

test('an attachment returned twice is represented once in the draft', async () => {
  const f = fixture(),
    first = f.controller.upload(image());
  f.complete(0, 'same-id');
  await first;
  const second = f.controller.upload(image());
  f.complete(1, 'same-id');
  await second;
  assert.equal(f.attachments.length, 1);
});

test('scope retains legacy omissions and distinguishes every adopted conversation/computer identity field', () => {
  assert.equal(composerAttachmentScope(null), composerAttachmentScope({ settings: {} }));
  const state = {
    conversationId: 'conversation-a',
    settings: {
      vm: {
        host: 'vm-a',
        user: 'dant',
        port: 22,
        keyPath: 'key-a',
        knownHosts: 'known-a',
        provider: 'hyperv',
      },
    },
  };
  const original = composerAttachmentScope(state);
  assert.notEqual(
    composerAttachmentScope({ ...state, conversationId: 'conversation-b' }),
    original,
  );
  for (const key of ['host', 'user', 'keyPath', 'knownHosts', 'provider'] as const) {
    const changed = structuredClone(state);
    changed.settings.vm[key] += '-changed';
    assert.notEqual(composerAttachmentScope(changed), original, key);
  }
  const changed = structuredClone(state);
  changed.settings.vm.port++;
  assert.notEqual(composerAttachmentScope(changed), original);
});

test('real main composer binding sends clipboard bytes through authenticated multipart upload and existing attachment decoding', async () => {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    { document, Event } = parseHTML('<textarea id="composer"></textarea>'),
    files: File[] = [],
    requests: string[] = [],
    errors: string[] = [],
    state = {
      settings: { vm: {} },
      worker: { status: 'online' },
      controller: { status: 'online', cached: false },
      call: null as { provider: string } | null,
    },
    context = uiEntrypointFixture({
      document,
      FormData,
      AbortController,
      composerAttachmentScope,
      createComposerAttachments,
      ConnectionStatus,
      state,
      currentState: () => state,
      eventConnected: true,
      unloading: false,
      updateInstalling: false,
      attachments: [] as Attachment[],
      uploading: 0,
      t: (key: string) => key,
      errorText: (error: unknown) => (error instanceof Error ? error.message : 'unexpected'),
      toast: (error: string) => errors.push(error),
      render() {},
      apiPath,
      base: '',
      token: 'synthetic-session',
      read,
      attachment,
      fetch: async (route: string, options: RequestInit) => {
        requests.push(route);
        assert.equal(options.method, 'POST');
        assert.equal(new Headers(options.headers).get('X-Dant-Token'), 'synthetic-session');
        assert.ok(options.body instanceof FormData);
        const file = options.body.get('file');
        assert.ok(file instanceof File);
        files.push(file);
        return {
          ok: true,
          json: async () => ({ id: 'image-id', name: file.name, type: file.type, size: file.size }),
        };
      },
      composer: document.querySelector<HTMLTextAreaElement>('#composer'),
    });
  vm.createContext(context);
  vm.runInContext(
    sourceDeclaration(source, 'function decodeApiResult(') +
      sourceDeclaration(source, 'async function api(') +
      sourceDeclaration(source, 'const computerReachable') +
      sourceDeclaration(source, 'const computerExecutorReady') +
      sourceDeclaration(source, 'const composerAttachments') +
      sourceCallStatement(source, 'composerAttachments.bind'),
    context,
  );
  const event = new Event('paste', { cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [image()], items: [], getData: () => '' },
  });
  defined(context.composer).dispatchEvent(event);
  await settle();
  assert.deepEqual(requests, ['/api/upload']);
  assert.equal(await defined(files[0]).text(), 'synthetic image');
  assert.equal(context.attachments[0]?.id, 'image-id');
  assert.equal(context.uploading, 0);
  assert.deepEqual(errors, []);
  state.call = { provider: 'subscription' };
  defined(context.composer).dispatchEvent(event);
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, ['callAttachment']);
  state.call = null;
  state.worker.status = 'offline';
  defined(context.composer).dispatchEvent(event);
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, ['callAttachment', 'connectionLost']);
  state.worker.status = 'online';
  state.controller.cached = true;
  defined(context.composer).dispatchEvent(event);
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, ['callAttachment', 'connectionLost', 'connectionLost']);
});
