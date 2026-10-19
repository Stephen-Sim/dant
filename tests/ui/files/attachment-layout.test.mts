import type { Attachment } from '../../../ui/shared/contracts.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceIndex, compactCss } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { bindAttachmentImages } from '../../../ui/files/attachment-images.mts';
import { canPreviewFile } from '../../../ui/files/file-preview.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
function fixture(language = 'en') {
  const { document } = parseHTML('<main></main>'),
    context = uiEntrypointFixture({
      canPreviewFile,
      language: () => language,
      fileURL: (file: Attachment) => '/api/files/' + file.id + '?token=fixture',
      esc: (value: unknown) =>
        String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
      ico: (name: string) => `<svg data-icon="${name}"></svg>`,
      t: (value: string) => value,
    });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    stripTypeScriptTypes(
      source.slice(
        sourceIndex(source, 'function renderAttachment(file){'),
        sourceIndex(source, 'function renderMessages(){'),
      ),
    ),
    context,
  );
  return {
    document,
    render(files?: Attachment[]) {
      defined(document.querySelector<HTMLElement>('main')).innerHTML =
        context.renderAttachments(files);
      return defined(document.querySelector<HTMLElement>('main'));
    },
    context,
  };
}
const imageFile = { id: 'image', name: 'tetrio-live.png', type: 'image/png', size: 300000 },
  textFile = {
    id: 'report',
    name: 'tetrio-2026-10-17T14-26-55.997Z.json',
    type: 'application/json',
    size: 1024,
  };
function dimensions(
  image: HTMLImageElement | null,
  { complete = false, width = 0, height = 0 } = {},
) {
  Object.defineProperties(defined(image), {
    complete: { configurable: true, value: complete },
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
}

function imageEvent(image: HTMLImageElement | null, type: 'load' | 'error'): Event {
  const node = defined(image);
  return new (defined(node.ownerDocument.defaultView).Event)(type);
}

test('mixed attachments share a list and file controls stay inside one card with the full filename', () => {
  const { render } = fixture(),
    root = render([imageFile, textFile, { ...imageFile, id: 'crop' }]),
    list = defined(root).querySelector<HTMLElement>('.attachment-list');
  assert.equal(defined(list).children.length, 3);
  assert.ok(defined(list).classList.contains('attachment-list-wide'));
  const card = defined(list).children[1],
    view = defined(card).querySelector<HTMLButtonElement>('[data-file-preview]'),
    download = defined(card).querySelector<HTMLButtonElement>('[data-download]');
  assert.equal(defined(card).className, 'file-attachment');
  assert.equal(defined(view).tagName, 'BUTTON');
  assert.equal(
    defined(defined(view).querySelector<HTMLElement>('.file-attachment-name')).textContent,
    textFile.name,
  );
  assert.equal(
    defined(defined(view).querySelector<HTMLElement>('.file-view-label')).textContent,
    'View',
  );
  assert.equal(defined(download).parentElement, card);
  assert.equal(defined(download).tagName, 'BUTTON');
  assert.equal(defined(download).hasAttribute('href'), false);
  assert.equal(defined(download).getAttribute('data-download'), textFile.id);
  assert.equal(defined(root).querySelector<HTMLElement>('a'), null);
});

test('slow images reserve space and hide the broken-image alt representation until a valid load', () => {
  const { render } = fixture('zh'),
    root = render([imageFile]),
    image = defined(root).querySelector<HTMLImageElement>('img'),
    card = defined(image).parentElement;
  assert.equal(defined(card).dataset.imageState, 'loading');
  assert.equal(defined(card).getAttribute('aria-busy'), 'true');
  assert.equal(defined(image).getAttribute('loading'), 'lazy');
  assert.equal(defined(image).getAttribute('decoding'), 'async');
  assert.equal(
    defined(defined(card).querySelector<HTMLElement>('.attachment-image-loading')).textContent,
    '正在加载图片…',
  );
  dimensions(image);
  bindAttachmentImages(root);
  assert.equal(defined(card).dataset.imageState, 'loading');
  dimensions(image, { complete: true, width: 1440, height: 900 });
  defined(image).dispatchEvent(imageEvent(image, 'load'));
  assert.equal(defined(card).dataset.imageState, 'ready');
  assert.equal(defined(card).getAttribute('aria-busy'), 'false');
  assert.equal(defined(card).style.getPropertyValue('--attachment-width'), '432px');
  assert.equal(defined(card).style.getPropertyValue('--attachment-ratio'), '1440 / 900');
});

test('portrait and small images retain their proportions and are never expanded beyond their source size', () => {
  for (const [width, height, expected] of [
    [300, 600, '135px'],
    [100, 60, '100px'],
    [1920, 1080, '440px'],
  ] as const) {
    const { render } = fixture(),
      root = render([imageFile]),
      image = defined(root).querySelector<HTMLImageElement>('img');
    dimensions(image, { complete: true, width, height });
    bindAttachmentImages(root);
    assert.equal(
      defined(defined(image).parentElement).style.getPropertyValue('--attachment-width'),
      expected,
    );
    assert.equal(defined(defined(image).parentElement).dataset.imageState, 'ready');
  }
});

test('failed and invalid image loads show a stable error card without replacing or navigating the preview button', () => {
  const { render } = fixture(),
    root = render([imageFile]),
    image = defined(root).querySelector<HTMLImageElement>('img'),
    card = defined(image).parentElement;
  dimensions(image);
  bindAttachmentImages(root);
  defined(image).dispatchEvent(imageEvent(image, 'error'));
  assert.equal(defined(card).dataset.imageState, 'error');
  assert.equal(defined(card).getAttribute('aria-busy'), 'false');
  assert.equal(
    defined(defined(card).querySelector<HTMLElement>('.attachment-image-error')).textContent,
    'Image unavailable',
  );
  assert.equal(defined(card).dataset.preview, 'image');
  assert.equal(defined(card).hasAttribute('href'), false);
  dimensions(image, { complete: true, width: 120, height: 0 });
  bindAttachmentImages(root);
  assert.equal(defined(card).dataset.imageState, 'error');
  defined(image).dispatchEvent(imageEvent(image, 'load'));
  assert.equal(defined(card).dataset.imageState, 'error');
});

test('reconciliation preserves image and audio nodes and restores loaded state without changing the source', () => {
  const { render, document, context } = fixture(),
    files = [imageFile, { id: 'voice', name: 'Voice.webm', type: 'audio/webm' }],
    root = render(files),
    image = defined(root).querySelector<HTMLImageElement>('img'),
    audio = defined(root).querySelector<HTMLAudioElement>('audio');
  dimensions(image, { complete: true, width: 1440, height: 900 });
  bindAttachmentImages(root);
  const originalURL = defined(image).getAttribute('src');
  const next = document.createElement('main');
  next.innerHTML = context.renderAttachments(files);
  reconcile(root, next);
  bindAttachmentImages(root);
  assert.equal(defined(root).querySelector<HTMLImageElement>('img'), image);
  assert.equal(defined(root).querySelector<HTMLAudioElement>('audio'), audio);
  assert.equal(defined(image).getAttribute('src'), originalURL);
  assert.equal(defined(defined(image).parentElement).dataset.imageState, 'ready');
  assert.equal(defined(audio).getAttribute('controls'), '');
  assert.equal(defined(audio).getAttribute('preload'), 'metadata');
});

test('an offline or connecting image failure retries the same node and URL once when its connection is ready', () => {
  const { render, document, context } = fixture(),
    root = render([imageFile]),
    image = defined(root).querySelector<HTMLImageElement>('img'),
    card = defined(image).parentElement,
    url = defined(image).getAttribute('src'),
    scope = 'same-vm-and-conversation',
    set = defined(image).setAttribute.bind(image),
    remove = defined(image).removeAttribute.bind(image),
    loads: (string | null)[] = [];
  defined(image).setAttribute = (name, value) => {
    if (name === 'src') loads.push(value);
    return set(name, value);
  };
  defined(image).removeAttribute = (name) => {
    if (name === 'src') loads.push(null);
    return remove(name);
  };
  dimensions(image);
  bindAttachmentImages(root, { ready: false, scope });
  const oldLoad = defined(image).onload,
    oldError = defined(image).onerror;
  defined(image).dispatchEvent(imageEvent(image, 'error'));
  assert.equal(defined(card).dataset.imageState, 'error');
  for (let index = 0; index < 3; index++) {
    const next = document.createElement('main');
    next.innerHTML = context.renderAttachments([imageFile]);
    reconcile(root, next);
    bindAttachmentImages(root, { ready: false, scope });
  }
  assert.deepEqual(loads, []);
  bindAttachmentImages(root, { ready: true, scope });
  assert.equal(defined(root).querySelector<HTMLImageElement>('img'), image);
  assert.equal(defined(image).getAttribute('src'), url);
  assert.deepEqual(loads, [null, url]);
  assert.equal(defined(card).dataset.imageState, 'loading');
  assert.equal(defined(card).getAttribute('aria-busy'), 'true');
  dimensions(image, { complete: true, width: 1440, height: 900 });
  defined(oldLoad).call(defined(image), imageEvent(image, 'load'));
  defined(oldError).call(defined(image), imageEvent(image, 'error'));
  assert.equal(
    defined(card).dataset.imageState,
    'loading',
    'late callbacks from the offline attempt cannot settle its replacement',
  );
  defined(image).dispatchEvent(imageEvent(image, 'load'));
  assert.equal(defined(card).dataset.imageState, 'ready');
  for (let index = 0; index < 5; index++) bindAttachmentImages(root, { ready: true, scope });
  bindAttachmentImages(root, { ready: false, scope });
  bindAttachmentImages(root, { ready: true, scope });
  assert.deepEqual(
    loads,
    [null, url],
    'successful cached images survive further connection changes',
  );
  assert.equal(defined(card).dataset.imageState, 'ready');
  assert.equal(defined(card).dataset.preview, 'image');
  assert.equal(defined(card).hasAttribute('href'), false);
});

test('pending offline loads also recover, but a rejected retry never loops on state refreshes', () => {
  const { render } = fixture(),
    root = render([imageFile]),
    image = defined(root).querySelector<HTMLImageElement>('img'),
    set = defined(image).setAttribute.bind(image),
    loads: (string | null)[] = [];
  defined(image).setAttribute = (name, value) => {
    if (name === 'src') loads.push(value);
    return set(name, value);
  };
  dimensions(image);
  bindAttachmentImages(root, { ready: false, scope: 'same' });
  bindAttachmentImages(root, { ready: true, scope: 'same' });
  assert.equal(loads.length, 1);
  assert.equal(defined(defined(image).parentElement).dataset.imageState, 'loading');
  defined(image).dispatchEvent(imageEvent(image, 'error'));
  for (let index = 0; index < 20; index++)
    bindAttachmentImages(root, { ready: true, scope: 'same' });
  assert.equal(loads.length, 1);
  assert.equal(defined(defined(image).parentElement).dataset.imageState, 'error');
  bindAttachmentImages(root, { ready: false, scope: 'same' });
  for (let index = 0; index < 20; index++)
    bindAttachmentImages(root, { ready: false, scope: 'same' });
  assert.equal(loads.length, 1);
  bindAttachmentImages(root, { ready: true, scope: 'same' });
  assert.equal(loads.length, 2, 'a separate confirmed reconnect permits one new read');
});

test('changed image URLs and VM scopes reject stale events and never retry an old URL in another context', () => {
  const { render } = fixture(),
    root = render([imageFile]),
    image = defined(root).querySelector<HTMLImageElement>('img'),
    card = defined(image).parentElement,
    set = defined(image).setAttribute.bind(image),
    loads: (string | null)[] = [];
  defined(image).setAttribute = (name, value) => {
    if (name === 'src') loads.push(value);
    return set(name, value);
  };
  dimensions(image);
  bindAttachmentImages(root, { ready: false, scope: 'vm-a' });
  const firstLoad = defined(image).onload,
    firstError = defined(image).onerror;
  defined(image).dispatchEvent(imageEvent(image, 'error'));
  bindAttachmentImages(root, { ready: false, scope: 'vm-b' });
  bindAttachmentImages(root, { ready: true, scope: 'vm-b' });
  assert.equal(loads.length, 0);
  dimensions(image, { complete: true, width: 300, height: 600 });
  defined(firstLoad).call(defined(image), imageEvent(image, 'load'));
  defined(firstError).call(defined(image), imageEvent(image, 'error'));
  defined(image).dispatchEvent(imageEvent(image, 'load'));
  assert.equal(defined(card).dataset.imageState, 'error');
  assert.equal(defined(card).style.getPropertyValue('--attachment-ratio'), '');
  defined(image).setAttribute('src', '/api/files/current-vm-file?token=fixture');
  bindAttachmentImages(root, { ready: true, scope: 'vm-b' });
  assert.equal(loads.length, 1, 'a current source URL is not sent a second time');
  assert.equal(
    defined(card).dataset.imageState,
    'loading',
    'old decoded dimensions never represent the changed URL',
  );
  defined(firstLoad).call(defined(image), imageEvent(image, 'load'));
  assert.equal(defined(card).dataset.imageState, 'loading');
  const currentLoad = defined(image).onload;
  dimensions(image, { complete: true, width: 200, height: 100 });
  defined(image).dispatchEvent(imageEvent(image, 'load'));
  assert.equal(defined(card).dataset.imageState, 'ready');
  assert.equal(defined(card).style.getPropertyValue('--attachment-ratio'), '200 / 100');
  defined(image).setAttribute('src', '/api/files/newer-source?token=fixture');
  defined(currentLoad).call(defined(image), imageEvent(image, 'load'));
  assert.equal(
    defined(card).dataset.imageState,
    'ready',
    'a callback from another URL cannot update the current card',
  );
  bindAttachmentImages(root, { ready: true, scope: 'vm-b' });
  assert.equal(defined(card).dataset.imageState, 'loading');
  const detached = defined(image).onload;
  defined(root).replaceChildren();
  defined(detached).call(defined(image), imageEvent(image, 'load'));
  assert.equal(
    defined(card).dataset.imageState,
    'loading',
    'detached images cannot be updated by an old response',
  );
});

test('audio-only attachments keep their existing compact width and non-preview files still download explicitly', () => {
  const { render } = fixture(),
    audio = render([{ id: 'voice', name: 'voice.webm', type: 'audio/webm' }]);
  assert.equal(
    defined(defined(audio).querySelector<HTMLElement>('.attachment-list')).classList.contains(
      'attachment-list-wide',
    ),
    false,
  );
  const root = render([{ id: 'binary', name: 'archive.zip', type: 'application/zip', size: 2048 }]);
  assert.equal(defined(root).querySelector<HTMLButtonElement>('[data-file-preview]'), null);
  assert.equal(
    defined(defined(root).querySelector<HTMLElement>('.file-card')).dataset.download,
    'binary',
  );
  assert.equal(
    defined(defined(root).querySelector<HTMLElement>('.file-attachment-name')).textContent,
    'archive.zip',
  );
  assert.equal(defined(root).querySelector<HTMLElement>('.file-view-label'), null);
  assert.equal(defined(render([])).children.length, 0);
  assert.equal(defined(render(undefined)).children.length, 0);
});

test('long text and binary filenames share consistent metadata without losing their full name or actions', () => {
  const { render } = fixture('zh'),
    files = [
      { ...textFile, name: 'tetrio-2026-10-17T15-43-29.987Z-"final".json' },
      {
        id: 'pixels',
        name: 'tetrio-2026-10-17T15-43-29.987Z.ppm',
        type: 'application/octet-stream',
        size: 841728,
      },
      {
        id: 'archive',
        name: 'tetrio-2026-10-17T15-44-08.732Z.zip',
        type: 'application/zip',
        size: 4096,
      },
      { id: 'notes', name: 'README', type: 'text/plain', size: 52 },
    ];
  const root = render(files),
    cards = [...defined(root).querySelectorAll<HTMLElement>('.file-attachment')];
  assert.equal(cards.length, 4);
  for (const [index, card] of cards.entries()) {
    const file = files[index],
      primary = card.querySelector<HTMLElement>('.file-card'),
      name = defined(primary).querySelector<HTMLElement>('.file-attachment-name'),
      download = card.querySelector<HTMLElement>('.file-download');
    assert.equal(defined(name).textContent, defined(file).name);
    assert.equal(defined(name).getAttribute('title'), defined(file).name);
    assert.ok(defined(defined(primary).getAttribute('aria-label')).endsWith(defined(file).name));
    assert.ok(defined(defined(download).getAttribute('aria-label')).endsWith(defined(file).name));
    assert.equal(
      defined(download).getAttribute('title'),
      defined(download).getAttribute('aria-label'),
    );
    assert.equal(defined(primary).parentElement, card);
    assert.equal(defined(download).parentElement, card);
    assert.equal(card.children.length, 2);
    assert.equal(defined(primary).querySelectorAll<HTMLElement>('small').length, 1);
    assert.equal(
      defined(defined(primary).querySelector<HTMLElement>('.file-attachment-meta')).textContent,
      ['JSON · 1 KB', 'PPM · 822 KB', 'ZIP · 4 KB', '1 KB'][index],
    );
    assert.equal(
      defined(primary).getAttribute(
        index === 0 || index === 3 ? 'data-file-preview' : 'data-download',
      ),
      defined(file).id,
    );
  }
  assert.equal(
    defined(defined(cards[0]).querySelector<HTMLElement>('.file-view-label')).textContent,
    '查看',
  );
  assert.equal(defined(cards[1]).querySelector<HTMLElement>('.file-view-label'), null);
  assert.equal(defined(root).querySelector<HTMLElement>('a'), null);
});

test('attachment spacing and file actions have bounded responsive layout rules', () => {
  const css = compactCss(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  assert.match(css, /\.attachment-list\{[^}]*flex-direction:column[^}]*gap:8px[^}]*max-width:100%/);
  assert.match(css, /\.attachment-list-wide\{width:440px\}/);
  assert.match(css, /\.file-card>\.file-view-label\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.file-attachment\{[^}]*width:100%[^}]*min-height:64px[^}]*border:1px/);
  assert.match(
    css,
    /\.file-attachment-name\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/,
  );
  assert.match(
    css,
    /\.attachment-list>\.image-attachment\{[^}]*aspect-ratio:var\(--attachment-ratio,16 \/ 10\)/,
  );
  assert.match(css, /\.attachment-list \.attachment-image\{[^}]*opacity:0/);
  assert.match(css, /\[data-image-state=["']ready["']\] \.attachment-image\{opacity:1\}/);
});
