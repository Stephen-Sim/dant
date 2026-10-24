import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import type { Attachment, UiModal } from '../../../ui/shared/contracts.mts';
import { isRecord } from '../../../ui/shared/contracts.mts';
import { escapeHtml } from '../../../ui/shared/html.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
import { bindAttachmentImages } from '../../../ui/files/attachment-images.mts';
import {
  createComposerImagePreviews,
  renderComposerImage,
} from '../../../ui/chat/composer-image-previews.mts';
import { composerAttachmentScope } from '../../../ui/chat/composer-attachments.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import {
  compactCss,
  sourceCallStatement,
  sourceDeclaration,
  sourceSelectorBinding,
} from '../../support/source-fixtures.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  image: Attachment = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Screenshot.png',
    type: 'image/png',
    size: 12345,
  },
  otherImage: Attachment = {
    ...image,
    id: '10000000-0000-4000-8000-000000000002',
    name: 'Other.png',
  },
  documentFile: Attachment = {
    ...image,
    id: '10000000-0000-4000-8000-000000000003',
    name: 'Report.pdf',
    type: 'application/pdf',
  };

function dimensions(node: HTMLImageElement, width: number, height: number) {
  Object.defineProperties(node, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
}

function fixture(language = 'en') {
  const { document, Event, HTMLElement } = parseHTML(
      '<html><body><main id="app"></main></body></html>',
    ),
    app = defined(document.querySelector<HTMLElement>('#app'));
  let focused: HTMLElement | null = null,
    resolveDownload: ((id: string) => Attachment | undefined | null) | null = null;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused });
  const context = uiEntrypointFixture({
    document,
    HTMLElement,
    state: {
      conversationId: 'conversation-a',
      settings: {
        vm: {
          host: 'computer-a',
          user: 'dant',
          port: 22,
          keyPath: 'key-a',
          knownHosts: 'known-a',
          provider: 'hyperv',
        },
      },
      controller: { status: 'online', cached: false },
      messages: [],
    },
    eventConnected: true,
    base: '',
    token: 'a'.repeat(64),
    attachments: [image, otherImage, documentFile] as Attachment[],
    composerDraft: 'Unsent text must stay here',
    replyTo: 'original-quoted-message',
    modal: null as UiModal | null,
    modalFocus: null as HTMLElement | null,
    emojiFor: null,
    language: () => language,
    t: (key: string) =>
      ({
        close: language === 'zh' ? '关闭' : 'Close',
        download: language === 'zh' ? '下载' : 'Download',
      })[key] || key,
    ico: () => '<svg aria-hidden="true"></svg>',
    button: (action: string, _icon: string, label: string) =>
      `<button type="button" data-action="${escapeHtml(action)}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`,
    managedSettings: { renderModal: () => null, onClose() {} },
    chatHistory: { renderModal: () => null, onClose() {} },
    progressActions: { onClose() {} },
    bindAttachmentImages,
    createComposerImagePreviews,
    renderComposerImage,
    composerAttachmentScope,
    downloads: {
      bind(resolve: (id: string) => Attachment | undefined | null) {
        resolveDownload = resolve;
      },
    },
    api() {
      assert.fail('Image preview and removal must not submit requests');
    },
    post() {
      assert.fail('Image preview and removal must not submit messages');
    },
    render: () => render(),
  });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    [
      'const fileURL',
      'const composerImagePreviews',
      'function renderDraftAttachment(',
      'function conversationFiles(',
      'function renderModal(',
      'function openModal(',
      'function closeModal(',
    ]
      .map((marker) => sourceDeclaration(source, marker))
      .join('\n'),
    context,
  );
  function render(): void {
    vm.runInContext('modal = composerImagePreviews.syncModal(modal)', context);
    const input = document.querySelector<HTMLTextAreaElement>('#composer');
    if (input) context.composerDraft = input.value;
    const template = document.createElement('template');
    template.innerHTML = `<div class="attachment-chips" data-key="attachments">${context.attachments.map(context.renderDraftAttachment).join('')}</div><textarea id="composer">${escapeHtml(context.composerDraft)}</textarea>${context.renderModal()}`;
    reconcile(app, template.content);
    for (const element of document.querySelectorAll<HTMLElement>('button,textarea,.dialog'))
      element.focus = () => {
        focused = element;
      };
    vm.runInContext(
      sourceCallStatement(source, 'composerImagePreviews.bind') +
        sourceCallStatement(source, 'bindAttachmentImages') +
        sourceCallStatement(source, 'downloads.bind') +
        sourceSelectorBinding(source, '[data-remove]'),
      context,
    );
  }
  render();
  return {
    document,
    Event,
    context,
    render,
    get focused() {
      return focused;
    },
    get downloadFile() {
      return defined(resolveDownload);
    },
    click(selector: string) {
      const button = defined(document.querySelector<HTMLButtonElement>(selector));
      button.focus();
      button.dispatchEvent(new Event('click', { bubbles: true }));
      return button;
    },
  };
}

test('unsent images show authenticated thumbnail images and preserve filename chips for other files', () => {
  const f = fixture(),
    cards = f.document.querySelectorAll<HTMLElement>('.draft-image'),
    thumbnail = defined(cards[0]).querySelector<HTMLImageElement>('img');
  assert.equal(cards.length, 2);
  assert.equal(
    defined(thumbnail).getAttribute('src'),
    `/api/files/${image.id}?token=${'a'.repeat(64)}`,
  );
  assert.equal(defined(thumbnail).alt, image.name);
  assert.equal(defined(thumbnail).getAttribute('loading'), null, 'selected images load eagerly');
  assert.equal(defined(cards[0]).querySelector('.draft-image-name')?.textContent, image.name);
  assert.equal(
    f.document.querySelector('.attachment-chips > span > span')?.textContent,
    documentFile.name,
  );
  assert.equal(f.context.attachments[0], image);
  assert.equal(
    f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
    'Unsent text must stay here',
  );
});

test('thumbnail preview and each Remove image control have localized keyboard-accessible names', () => {
  for (const [language, preview, remove] of [
    ['en', 'Preview image', 'Remove image'],
    ['zh', '预览图片', '移除图片'],
  ] as const) {
    const f = fixture(language),
      button = defined(f.document.querySelector<HTMLButtonElement>('[data-draft-preview]')),
      close = defined(f.document.querySelector<HTMLButtonElement>('.draft-image-remove'));
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), preview + ' ' + image.name);
    assert.equal(close.getAttribute('aria-label'), remove + ' ' + image.name);
    assert.equal(close.getAttribute('title'), remove + ' ' + image.name);
    assert.equal(button.hasAttribute('tabindex'), false);
  }
});

test('clicking an unsent thumbnail opens the existing large accessible image dialog and retains every draft field', () => {
  const f = fixture(),
    before = [...f.context.attachments],
    target = f.click(`[data-draft-preview="${image.id}"]`),
    dialog = defined(f.document.querySelector<HTMLElement>('.image-dialog')),
    full = defined(dialog.querySelector<HTMLImageElement>('.image-preview-body img'));
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'dialog-title');
  assert.equal(dialog.querySelector('#dialog-title')?.textContent, image.name);
  assert.equal(full.getAttribute('src'), `/api/files/${image.id}?token=${'a'.repeat(64)}`);
  assert.equal(f.focused, dialog);
  assert.equal(
    f.downloadFile(image.id),
    image,
    'the existing modal download resolves the unsent attachment',
  );
  assert.deepEqual(f.context.attachments, before);
  assert.equal(f.context.replyTo, 'original-quoted-message');
  assert.equal(
    f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
    'Unsent text must stay here',
  );
  f.context.closeModal();
  assert.equal(f.context.modal, null);
  assert.equal(
    f.focused,
    target,
    'closing the existing dialog returns keyboard focus to its thumbnail',
  );
});

test('removing one selected image closes its preview and preserves text, the other image and file attachments', () => {
  const f = fixture();
  f.click(`[data-draft-preview="${image.id}"]`);
  f.click(`.draft-image-remove[data-remove="${image.id}"]`);
  assert.equal(f.context.modal, null);
  assert.equal(f.document.querySelector('.image-dialog'), null);
  assert.deepEqual(f.context.attachments, [otherImage, documentFile]);
  assert.equal(f.document.querySelectorAll('.draft-image').length, 1);
  assert.equal(
    f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
    'Unsent text must stay here',
  );
  assert.equal(f.context.replyTo, 'original-quoted-message');
});

test('removing a different image keeps the selected preview and the remaining draft unchanged', () => {
  const f = fixture();
  f.click(`[data-draft-preview="${image.id}"]`);
  f.click(`.draft-image-remove[data-remove="${otherImage.id}"]`);
  const modal: unknown = Reflect.get(f.context, 'modal');
  assert.ok(isRecord(modal));
  assert.equal(modal.fileId, image.id);
  assert.equal(f.document.querySelector('.image-dialog #dialog-title')?.textContent, image.name);
  assert.deepEqual(f.context.attachments, [image, documentFile]);
  assert.equal(
    f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
    'Unsent text must stay here',
  );
});

test('stale thumbnail callbacks cannot open a removed, replaced or different-computer attachment', () => {
  const f = fixture(),
    stale = defined(f.document.querySelector<HTMLButtonElement>('[data-draft-preview]'));
  f.context.attachments = f.context.attachments.filter((file) => file !== image);
  stale.dispatchEvent(new f.Event('click'));
  assert.equal(f.context.modal, null);
  f.context.attachments = [{ ...image }];
  stale.dispatchEvent(new f.Event('click'));
  assert.equal(
    f.context.modal,
    null,
    'matching IDs do not authorize a replacement attachment object',
  );
  f.context.attachments = [image];
  f.context.state.settings.vm.knownHosts = 'different-known-hosts';
  stale.dispatchEvent(new f.Event('click'));
  assert.equal(f.context.modal, null);
  f.render();
  f.click('[data-draft-preview]');
  const modal: unknown = Reflect.get(f.context, 'modal');
  assert.ok(isRecord(modal));
  assert.equal(modal.type, 'image');
});

test('an open draft image and its download stay owned by the exact draft object and computer', () => {
  for (const change of ['conversation', 'knownHosts', 'provider', 'replacement'] as const) {
    const f = fixture();
    f.click(`[data-draft-preview="${image.id}"]`);
    const download = f.downloadFile;
    if (change === 'conversation') f.context.state.conversationId = 'conversation-b';
    else if (change === 'replacement')
      f.context.attachments = [{ ...image }, otherImage, documentFile];
    else f.context.state.settings.vm[change] = 'different-' + change;
    assert.equal(
      download(image.id),
      null,
      'an old download resolver cannot adopt changed ownership',
    );
    f.render();
    assert.equal(f.document.querySelector('.image-dialog'), null, change);
    assert.equal(f.context.modal, null, change);
    assert.equal(download(image.id), null, 'rerendering cannot authorize the stale download');
    assert.equal(f.context.attachments.length, 3);
    assert.equal(f.context.replyTo, 'original-quoted-message');
    assert.equal(
      f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
      'Unsent text must stay here',
    );
  }
});

test('stale image Remove callbacks preserve replacement drafts and drafts on a different computer', () => {
  for (const change of ['detached', 'replacement', 'scope'] as const) {
    const f = fixture(),
      stale = defined(f.document.querySelector<HTMLButtonElement>('.draft-image-remove'));
    if (change === 'detached') stale.remove();
    else if (change === 'replacement')
      f.context.attachments = [{ ...image }, otherImage, documentFile];
    else f.context.state.settings.vm.knownHosts = 'different-known-hosts';
    const before = [...f.context.attachments];
    stale.dispatchEvent(new f.Event('click'));
    assert.deepEqual(f.context.attachments, before, change);
    assert.equal(f.context.replyTo, 'original-quoted-message');
    assert.equal(
      f.document.querySelector<HTMLTextAreaElement>('#composer')?.value,
      'Unsent text must stay here',
    );
  }
});

test('foreign attachment URLs and markup in filenames never become a thumbnail source or executable markup', () => {
  const malicious: Attachment = {
      ...image,
      name: 'x"><script>alert(1)</script>.png',
      url: 'https://untrusted.invalid/private-image',
    },
    { document } = parseHTML(
      renderComposerImage(malicious, {
        language: 'en',
        fileURL: (file) => '/api/files/' + encodeURIComponent(file.id) + '?token=synthetic',
      }),
    );
  assert.equal(
    document.querySelector('img')?.getAttribute('src'),
    '/api/files/' + image.id + '?token=synthetic',
  );
  assert.equal(document.querySelector('script'), null);
  assert.equal(document.querySelector('[onerror]'), null);
  assert.equal(document.querySelector('[href]'), null);
  assert.equal(document.querySelector('.draft-image-name')?.textContent, malicious.name);
});

test('detached, missing and non-image draft preview buttons cannot open the image modal', () => {
  const { document, Event } = parseHTML(
      `<main><button data-draft-preview="${documentFile.id}"></button><button data-draft-preview="missing"></button><button data-draft-preview="${image.id}"></button></main>`,
    ),
    previews: UiModal[] = [];
  createComposerImagePreviews({
    getAttachments: () => [image, documentFile],
    getScope: () => 'same-conversation',
    openModal: (modal) => previews.push(modal),
    remove: () => assert.fail('A preview must not remove an attachment'),
  }).bind(document);
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-draft-preview]');
  defined(buttons[0]).dispatchEvent(new Event('click'));
  defined(buttons[1]).dispatchEvent(new Event('click'));
  const detached = defined(buttons[2]);
  detached.remove();
  detached.dispatchEvent(new Event('click'));
  assert.deepEqual(previews, []);
});

test('draft modal ownership preserves ordinary file resolution and returns to its valid parent', () => {
  const { document, Event } = parseHTML(`<button data-draft-preview="${image.id}"></button>`),
    attachment = { ...image },
    parent: UiModal = { type: 'details' };
  let modal: UiModal | null = null,
    attachments = [attachment];
  const previews = createComposerImagePreviews({
    getAttachments: () => attachments,
    getScope: () => 'same-conversation',
    openModal(value) {
      value.parent = parent;
      modal = value;
    },
    remove: () => assert.fail('Previewing must preserve every draft attachment'),
  });
  previews.bind(document);
  defined(document.querySelector('button')).dispatchEvent(new Event('click'));
  const selected = defined(modal),
    resolve = previews.resolveDownload(selected, (id) =>
      id === documentFile.id ? documentFile : undefined,
    );
  assert.equal(previews.file(parent), undefined);
  assert.equal(previews.syncModal(parent), parent);
  assert.equal(resolve(undefined), undefined);
  assert.equal(resolve(documentFile.id), documentFile);
  assert.equal(previews.resolveDownload(null, () => documentFile)(documentFile.id), documentFile);
  attachment.type = documentFile.type;
  assert.equal(previews.file(selected), null, 'a non-image object cannot remain an image preview');
  attachment.type = image.type;
  attachments = [];
  assert.equal(resolve(image.id), null, 'removing the selected object invalidates its download');
  assert.equal(previews.syncModal(selected), parent);
});

test('thumbnail image load and error states use the existing bounded image lifecycle and remain removable', () => {
  const f = fixture(),
    button = defined(f.document.querySelector<HTMLElement>('.draft-image-preview')),
    thumbnail = defined(button.querySelector<HTMLImageElement>('img'));
  assert.equal(button.dataset.imageState, 'loading');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  thumbnail.dispatchEvent(new f.Event('error'));
  assert.equal(button.dataset.imageState, 'error');
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.querySelector('.attachment-image-error')?.textContent, 'Image unavailable');
  dimensions(thumbnail, 1600, 900);
  thumbnail.dispatchEvent(new f.Event('load'));
  assert.equal(button.dataset.imageState, 'ready');
  f.render();
  assert.equal(
    f.document.querySelector<HTMLElement>('.draft-image-preview')?.dataset.imageState,
    'ready',
  );
  f.click(`.draft-image-remove[data-remove="${image.id}"]`);
  assert.equal(
    f.context.attachments.some((file) => file.id === image.id),
    false,
  );
});

test('a detached thumbnail load cannot alter a different retained image after targeted removal', () => {
  const f = fixture(),
    old = defined(f.document.querySelector<HTMLImageElement>('.draft-image-preview img'));
  f.click(`.draft-image-remove[data-remove="${image.id}"]`);
  const remaining = defined(f.document.querySelector<HTMLElement>('.draft-image-preview'));
  dimensions(old, 200, 100);
  old.dispatchEvent(new f.Event('load'));
  assert.equal(remaining.dataset.imageState, 'loading');
  assert.equal(remaining.getAttribute('data-draft-preview'), otherImage.id);
});

test('thumbnail styles reserve visible compact image space and wrap without stretching narrow composers', () => {
  const css = compactCss(
      fs.readFileSync(
        new URL('../../../ui/chat/composer-image-previews.css', import.meta.url),
        'utf8',
      ),
    ),
    shared = compactCss(fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'));
  assert.match(css, /\.attachment-chips>\.draft-image\{[^}]*max-width:100%;[^}]*min-width:0/);
  assert.match(
    css,
    /\.draft-image>\.draft-image-preview\{[^}]*width:100%;[^}]*aspect-ratio:4\s*\/\s*3/,
  );
  assert.match(css, /\.draft-image-preview \.attachment-image\{[^}]*object-fit:contain/);
  assert.match(
    css,
    /@media\(max-width:520px\)\{\.attachment-chips>\.draft-image\{flex-basis:96px;width:96px/,
  );
  assert.match(shared, /\.attachment-chips\{[^}]*flex-wrap:wrap/);
  assert.match(
    shared,
    /\.image-attachment\[data-image-state='ready'\] \.attachment-image\{opacity:1/,
  );
});
