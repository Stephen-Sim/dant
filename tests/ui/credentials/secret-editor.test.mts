import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  CREDENTIAL_SECRET_MAX_UNITS,
  createCredentialSecretEditor,
} from '../../../ui/credentials/secret-editor.mts';
import type { SecretEditorIdentity } from '../../../ui/credentials/secret-editor.mts';
import type { ApiOptions } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';

interface WaitingRequest {
  route: string;
  options: ApiOptions;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function fixture(saved = true) {
  const { document, Event } = parseHTML('<html><body><main></main></body></html>'),
    root = defined(document.querySelector('main')),
    modal = {},
    calls: WaitingRequest[] = [];
  let identity: SecretEditorIdentity | null = {
      key: 'synthetic-editor',
      scope: 'synthetic-scope',
      modal,
      saved: saved
        ? {
            credentialId: 'synthetic-id',
            conversationId: 'synthetic-conversation',
            computer: 'synthetic-computer',
            modal,
          }
        : null,
    },
    invalid = 0,
    editor: ReturnType<typeof createCredentialSecretEditor> | undefined;

  function fields() {
    const masked = document.createElement('input'),
      shown = document.createElement('textarea');
    masked.id = 'synthetic-masked';
    masked.type = 'password';
    shown.id = 'synthetic-shown';
    shown.hidden = true;
    let maskedValue = '',
      shownValue = '';
    // Linkedom does not implement the native value sanitization boundary.
    // Keep the same behavior here so exact private values cannot accidentally
    // be reconstructed from a lossy password input or normalized textarea.
    Object.defineProperty(masked, 'value', {
      configurable: true,
      get: () => maskedValue,
      set: (value: string) => {
        maskedValue = String(value).replace(/[\r\n]/g, '');
        masked.selectionStart = masked.selectionEnd = maskedValue.length;
      },
    });
    Object.defineProperty(shown, 'value', {
      configurable: true,
      get: () => shownValue,
      set: (value: string) => {
        shownValue = String(value).replace(/\r\n?/g, '\n');
        shown.selectionStart = shown.selectionEnd = shownValue.length;
      },
    });
    masked.selectionStart = masked.selectionEnd = 0;
    shown.selectionStart = shown.selectionEnd = 0;
    masked.setSelectionRange = (start, end) => {
      masked.selectionStart = start;
      masked.selectionEnd = end;
    };
    shown.setSelectionRange = (start, end) => {
      shown.selectionStart = start ?? 0;
      shown.selectionEnd = end ?? 0;
    };
    root.append(masked, shown);
    return { masked, shown };
  }

  let bound = fields();
  editor = createCredentialSecretEditor({
    identity: () => identity,
    changed: () => editor?.bind(bound.masked, bound.shown),
    invalid: () => invalid++,
    request: async (route, options = {}) => {
      return await new Promise<unknown>((resolve, reject) => {
        calls.push({ route, options, resolve, reject });
      });
    },
  });
  const current = editor;
  current.bind(bound.masked, bound.shown);

  function paste(target: HTMLInputElement | HTMLTextAreaElement, text: string) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (kind: string) => (kind === 'text/plain' ? text : '') },
    });
    // Linkedom has no native onpaste property dispatch. Exercise the actual
    // bound DOM handler with a cancelable clipboard event instead.
    if (target.onpaste) Reflect.apply(target.onpaste, target, [event]);
    return event;
  }

  return {
    editor: current,
    calls,
    get masked() {
      return bound.masked;
    },
    get shown() {
      return bound.shown;
    },
    get identity() {
      return identity;
    },
    set identity(value: SecretEditorIdentity | null) {
      identity = value;
    },
    get invalid() {
      return invalid;
    },
    typeMasked(value: string) {
      bound.masked.value = value;
      bound.masked.dispatchEvent(new Event('input', { bubbles: true }));
    },
    typeShown(value: string) {
      bound.shown.value = value;
      bound.shown.dispatchEvent(new Event('input', { bubbles: true }));
    },
    pasteMasked: (value: string) => paste(bound.masked, value),
    replaceFields() {
      const previous = bound;
      previous.masked.remove();
      previous.shown.remove();
      bound = fields();
      current.bind(bound.masked, bound.shown);
      return previous;
    },
    detachFields() {
      bound.masked.remove();
      bound.shown.remove();
    },
    staleInput(target: HTMLInputElement, value: string) {
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    },
    paste,
  };
}

const savedReply = () => ({
  id: 'synthetic-id',
  conversationId: 'synthetic-conversation',
  secret: 'synthetic saved\r\nsecond line',
});

test('saved content is fetched explicitly in the single logical field and viewing never becomes replacement intent', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.equal(f.masked.type, 'password');
  assert.equal(f.masked.hidden, false);
  assert.equal(f.shown.hidden, true);
  assert.equal(f.editor.replacement(), '');
  const waiting = f.editor.toggle(),
    request = defined(f.calls[0]);
  assert.equal(request.route, '/credentials/reveal/synthetic-id');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.beforeSend?.(), true);
  assert.equal(f.editor.state.pending, true);
  const response = savedReply();
  request.resolve(response);
  await waiting;
  assert.equal(response.secret, '');
  assert.equal(f.masked.hidden, true);
  assert.equal(f.shown.hidden, false);
  assert.equal(f.shown.value, 'synthetic saved\nsecond line');
  assert.equal(f.editor.replacement(), '');
  assert.equal(JSON.stringify(f.editor.state).includes('synthetic saved'), false);
  const oldShown = f.shown;
  await f.editor.toggle();
  assert.equal(oldShown.value, '');
  assert.equal(f.editor.state.visible, false);
  assert.equal(f.editor.replacement(), '');
  const refetch = f.editor.toggle();
  assert.equal(f.calls.length, 2);
  defined(f.calls[1]).resolve(savedReply());
  await refetch;
  assert.equal(f.editor.replacement(), '');
});

test('editing the shown saved value creates a replacement while blank still means keep the existing value', async () => {
  const f = fixture(),
    waiting = f.editor.toggle();
  defined(f.calls[0]).resolve(savedReply());
  await waiting;
  f.typeShown('synthetic edited\nsecond line');
  assert.equal(f.editor.replacement(), 'synthetic edited\nsecond line');
  await f.editor.toggle();
  assert.equal(f.editor.replacement(), 'synthetic edited\nsecond line');
  await f.editor.toggle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.shown.value, 'synthetic edited\nsecond line');
  f.typeShown('');
  assert.equal(f.editor.replacement(), '');
});

test('clearing an edited saved value then hiding and showing refetches a view-only value that Save still omits', async () => {
  const f = fixture(),
    initial = f.editor.toggle();
  defined(f.calls[0]).resolve(savedReply());
  await initial;
  f.typeShown('synthetic edit before clearing');
  f.typeShown('');
  assert.equal(f.editor.replacement(), '');
  await f.editor.toggle();
  assert.equal(f.editor.state.visible, false);
  const viewingAgain = f.editor.toggle();
  assert.equal(f.calls.length, 2);
  defined(f.calls[1]).resolve(savedReply());
  await viewingAgain;
  assert.equal(f.editor.state.visible, true);
  assert.equal(f.shown.hidden, false);
  assert.equal(f.shown.value, 'synthetic saved\nsecond line');
  assert.equal(f.editor.replacement(), '', 'the Save boundary must keep the stored value');
  assert.equal(
    f.calls.every((call) => call.route.startsWith('/credentials/reveal/')),
    true,
  );
});

test('typed single-line replacement stays local through hiding, showing and rebinding', async () => {
  const f = fixture(false);
  f.typeMasked('synthetic replacement');
  assert.equal(f.editor.replacement(), 'synthetic replacement');
  await f.editor.toggle();
  assert.equal(f.shown.value, 'synthetic replacement');
  assert.equal(f.editor.replacement(), 'synthetic replacement');
  await f.editor.toggle();
  assert.equal(f.masked.type, 'password');
  assert.equal(f.editor.replacement(), 'synthetic replacement');
  const outgoing = f.replaceFields();
  assert.equal(outgoing.masked.value, '');
  assert.equal(outgoing.shown.value, '');
  assert.equal(f.editor.replacement(), 'synthetic replacement');
  assert.equal(f.calls.length, 0);
});

test('hidden paste preserves exact LF and CRLF replacements despite both native controls normalizing their displayed values', async () => {
  for (const value of [
    'synthetic\nmultiline',
    'synthetic\r\nmultiline\r\n',
    'synthetic\rmultiline',
  ]) {
    const f = fixture(false),
      event = f.pasteMasked(value);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.editor.replacement(), value);
    assert.equal(f.editor.state.hiddenMultiline, true);
    assert.equal(f.masked.readOnly, true);
    await f.editor.toggle();
    assert.equal(f.shown.value, value.replace(/\r\n?/g, '\n'));
    assert.equal(f.editor.replacement(), value);
    await f.editor.toggle();
    assert.equal(f.editor.replacement(), value);
    assert.equal(f.editor.state.hiddenMultiline, true);
    const invalid = f.invalid,
      rejected = f.pasteMasked('must not overwrite hidden multiline');
    assert.equal(rejected.defaultPrevented, true);
    assert.equal(f.invalid, invalid + 1);
    assert.equal(f.editor.replacement(), value);
    await f.editor.toggle();
    assert.equal(f.editor.replacement(), value);
    assert.equal(f.calls.length, 0);
    assert.equal(JSON.stringify(f.editor.state).includes('synthetic'), false);
  }
});

test('visible paste maps normalized textarea selection back to exact retained CRLF positions', async () => {
  const f = fixture(false);
  f.pasteMasked('synthetic\r\noriginal');
  await f.editor.toggle();
  assert.equal(f.shown.value, 'synthetic\noriginal');
  f.shown.selectionStart = 'synthetic\n'.length;
  f.shown.selectionEnd = f.shown.value.length;
  const event = f.paste(f.shown, 'replacement\r\nlast');
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.editor.replacement(), 'synthetic\r\nreplacement\r\nlast');
  await f.editor.toggle();
  assert.equal(f.editor.replacement(), 'synthetic\r\nreplacement\r\nlast');
  assert.equal(f.calls.length, 0);
});

test('pasting in the middle keeps the caret after the insertion instead of moving it to the end', async () => {
  const f = fixture(false);
  f.pasteMasked('ab\r\ncd');
  await f.editor.toggle();
  f.shown.selectionStart = f.shown.selectionEnd = 1;
  f.paste(f.shown, 'X\r\nY');
  assert.equal(f.editor.replacement(), 'aX\r\nYb\r\ncd');
  assert.equal(f.shown.value, 'aX\nYb\ncd');
  assert.equal(f.shown.selectionStart, 4);
  assert.equal(f.shown.selectionEnd, 4);
});

test('actual multiline textarea edits become the authoritative replacement without stripping line breaks on Hide', async () => {
  const f = fixture(false);
  await f.editor.toggle();
  f.typeShown('synthetic first\nsecond\n');
  assert.equal(f.editor.replacement(), 'synthetic first\nsecond\n');
  await f.editor.toggle();
  assert.equal(f.editor.replacement(), 'synthetic first\nsecond\n');
  assert.equal(f.editor.state.hiddenMultiline, true);
  await f.editor.toggle();
  assert.equal(f.shown.value, 'synthetic first\nsecond\n');
});

test('invalid paste keeps the previous replacement and reports a bounded validation failure', () => {
  const f = fixture(false);
  assert.equal(CREDENTIAL_SECRET_MAX_UNITS, 16000);
  f.typeMasked('synthetic kept');
  const event = f.pasteMasked('x'.repeat(CREDENTIAL_SECRET_MAX_UNITS + 1));
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.invalid, 1);
  assert.equal(f.editor.replacement(), 'synthetic kept');
  assert.equal(f.calls.length, 0);
});

test('identity and scope changes clear replacement values including detached bound controls', async () => {
  for (const change of ['key', 'scope', 'modal', 'close'] as const) {
    const f = fixture(false);
    f.typeMasked('synthetic private');
    await f.editor.toggle();
    f.detachFields();
    if (change === 'close') f.identity = null;
    else {
      const identity = defined(f.identity);
      f.identity = { ...identity, [change]: change === 'modal' ? {} : 'changed-' + change };
    }
    assert.equal(f.editor.replacement(), '', change);
    assert.equal(f.masked.value, '', change);
    assert.equal(f.shown.value, '', change);
    assert.equal(f.editor.state.visible, false, change);
  }
});

test('late saved replies and queued dispatch guards cannot cross editor or saved-owner changes', async () => {
  for (const change of [
    'key',
    'scope',
    'modal',
    'credentialId',
    'conversationId',
    'computer',
    'close',
  ] as const) {
    const f = fixture(),
      pending = f.editor.toggle(),
      request = defined(f.calls[0]);
    if (change === 'close') f.identity = null;
    else {
      const identity = defined(f.identity);
      if (change === 'credentialId' || change === 'conversationId' || change === 'computer')
        f.identity = {
          ...identity,
          saved: { ...defined(identity.saved), [change]: 'different-owner' },
        };
      else f.identity = { ...identity, [change]: change === 'modal' ? {} : 'different-owner' };
    }
    assert.equal(request.options.beforeSend?.(), false, change);
    const response = savedReply();
    request.resolve(response);
    await pending;
    assert.equal(response.secret, '', change);
    assert.equal(f.editor.replacement(), '', change);
    assert.equal(f.masked.value, '', change);
    assert.equal(f.shown.value, '', change);
    assert.equal(f.editor.state.visible, false, change);
  }
});

test('a replacement entered during a pending reveal wins over late success and failure', async () => {
  for (const failed of [false, true]) {
    const f = fixture(),
      pending = f.editor.toggle(),
      request = defined(f.calls[0]);
    f.typeMasked('synthetic current replacement');
    if (failed) request.reject(Error('raw synthetic failure must not render'));
    else request.resolve(savedReply());
    await pending;
    assert.equal(f.editor.replacement(), 'synthetic current replacement');
    assert.equal(JSON.stringify(f.editor.state).includes('raw synthetic'), false);
    await f.editor.toggle();
    assert.equal(f.shown.value, 'synthetic current replacement');
    assert.equal(f.calls.length, 1);
  }
});

test('rebinding rejects stale node callbacks and reset wipes the currently bound detached elements', async () => {
  const f = fixture(false);
  f.typeMasked('synthetic current');
  const previous = f.replaceFields();
  f.staleInput(previous.masked, 'synthetic stale');
  f.paste(previous.masked, 'synthetic stale pasted');
  assert.equal(f.editor.replacement(), 'synthetic current');
  await f.editor.toggle();
  const outgoing = f.shown;
  f.detachFields();
  f.editor.reset();
  assert.equal(outgoing.value, '');
  assert.equal(f.masked.value, '');
  assert.equal(f.editor.replacement(), '');
  assert.equal(f.editor.state.visible, false);
});
