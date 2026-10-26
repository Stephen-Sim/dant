import { createCredentialReveal } from './reveal.mts';
import type { RevealIdentity } from './reveal.mts';
import type { ApiRequest } from '../shared/contracts.mts';

export const CREDENTIAL_SECRET_MAX_UNITS = 16_000;

export interface SecretEditorIdentity {
  key: string;
  scope: string;
  modal: object;
  saved: RevealIdentity | null;
}

const same = (left: SecretEditorIdentity | null, right: SecretEditorIdentity | null): boolean =>
  left === null || right === null
    ? left === right
    : left.key === right.key &&
      left.scope === right.scope &&
      left.modal === right.modal &&
      (left.saved === null || right.saved === null
        ? left.saved === right.saved
        : left.saved.credentialId === right.saved.credentialId &&
          left.saved.conversationId === right.saved.conversationId &&
          left.saved.computer === right.saved.computer &&
          left.saved.modal === right.saved.modal);

// Displaying a saved value never creates replacement intent. The exact private
// replacement buffer, not either DOM representation, is the Save boundary.
export function createCredentialSecretEditor({
  request,
  identity,
  changed,
  invalid,
}: {
  request: ApiRequest;
  identity: () => SecretEditorIdentity | null;
  changed: () => void;
  invalid: () => void;
}) {
  let owner: SecretEditorIdentity | null = null;
  let replacement = '';
  let edited = false;
  let visible = false;
  let masked: HTMLInputElement | null = null;
  let shown: HTMLTextAreaElement | null = null;

  const clearNode = (node: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (node) {
      node.value = '';
      node.hidden = true;
    }
  };
  const reveal = createCredentialReveal({
    request,
    identity: () => {
      const current = identity();
      return same(owner, current) ? (current?.saved ?? null) : null;
    },
    clear: () => {
      if (!edited) clearNode(shown);
    },
    changed: () => {
      sync();
      if (reveal.state.visible && !edited) visible = true;
      apply();
      changed();
    },
  });

  function reset() {
    replacement = '';
    edited = visible = false;
    clearNode(masked);
    clearNode(shown);
    reveal.reset();
    owner = null;
  }
  function sync() {
    const current = identity();
    if (!same(owner, current)) {
      reset();
      owner = current;
    }
    return current;
  }
  function apply() {
    sync();
    if (masked) {
      masked.hidden = visible;
      masked.readOnly = edited && /[\r\n]/.test(replacement);
      // A hidden multiline representation is display-only. Its native input
      // sanitizer must never overwrite the exact replacement buffer.
      const value = !visible && edited ? replacement.replace(/[\r\n]/g, '') : '';
      if (masked.value !== value) masked.value = value;
    }
    if (!shown) return;
    shown.readOnly = false;
    if (!visible) clearNode(shown);
    else if (edited || !owner?.saved || !reveal.state.visible) {
      shown.hidden = false;
      if (shown.value !== replacement.replace(/\r\n?/g, '\n')) shown.value = replacement;
    } else reveal.apply(shown);
  }
  function replace(value: string) {
    if (value.length > CREDENTIAL_SECRET_MAX_UNITS) {
      apply();
      invalid();
      return false;
    }
    replacement = value;
    // Empty is the existing keep-stored-value contract. It also permits a later
    // explicit Show to fetch the saved value again rather than a stale draft.
    edited = value.length > 0;
    reveal.reset();
    apply();
    changed();
    return true;
  }
  function owns(
    captured: SecretEditorIdentity | null,
    node: HTMLInputElement | HTMLTextAreaElement,
  ) {
    return (
      captured !== null &&
      same(captured, sync()) &&
      (node === masked || node === shown) &&
      node.isConnected &&
      !node.hidden
    );
  }
  function bindNode(node: HTMLInputElement | HTMLTextAreaElement | null) {
    if (!node) return;
    const captured = owner;
    node.oninput = node.onchange = () => {
      if (!owns(captured, node)) return;
      if (node.readOnly) {
        apply();
        return;
      }
      replace(node.value);
    };
    node.onpaste = (event) => {
      if (!owns(captured, node)) return;
      event.preventDefault();
      if (node.readOnly) {
        invalid();
        return;
      }
      const value = event.clipboardData?.getData('text/plain');
      if (value === undefined) {
        invalid();
        return;
      }
      const current = edited ? replacement : visible ? node.value : '',
        start = node.selectionStart,
        end = node.selectionEnd;
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > node.value.length
      ) {
        invalid();
        return;
      }
      // Textarea selection indexes use LF-normalized text. Translate them back
      // to private CRLF offsets without normalizing the retained value.
      const offset = (position: number) => {
        let exact = 0;
        for (let displayed = 0; displayed < position && exact < current.length; displayed++) {
          if (current[exact] === '\r' && current[exact + 1] === '\n') exact++;
          exact++;
        }
        return exact;
      };
      const prefix = current.slice(0, offset(start)) + value;
      if (!replace(prefix + current.slice(offset(end)))) return;
      if (owns(captured, node) && typeof node.setSelectionRange === 'function') {
        const caret =
          node === masked
            ? prefix.replace(/[\r\n]/g, '').length
            : prefix.replace(/\r\n?/g, '\n').length;
        node.setSelectionRange(caret, caret);
      }
    };
  }

  return {
    get state() {
      const current = sync(),
        saved = reveal.state;
      return {
        visible,
        pending: saved.pending,
        failed: saved.failed,
        available: current !== null,
        hiddenMultiline: !visible && edited && /[\r\n]/.test(replacement),
      };
    },
    bind(input: HTMLInputElement | null, textarea: HTMLTextAreaElement | null) {
      sync();
      if (masked !== input) clearNode(masked);
      if (shown !== textarea) clearNode(shown);
      masked = input;
      shown = textarea;
      apply();
      bindNode(masked);
      bindNode(shown);
    },
    async toggle() {
      if (!sync()) return;
      if (visible || reveal.state.pending) {
        visible = false;
        reveal.reset();
        apply();
        changed();
      } else if (replacement || !owner?.saved) {
        visible = true;
        apply();
        changed();
      } else await reveal.toggle();
    },
    replacement() {
      return sync() && edited ? replacement : '';
    },
    reset,
  };
}
