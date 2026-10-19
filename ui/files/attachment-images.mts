// Lazy images keep a visible footprint while their authenticated request loads.
// Rebinding after reconciliation also restores the ready state of cached nodes.
type ImagePhase = 'loading' | 'ready' | 'error';
interface ImageState {
  url: string;
  scope: string;
  phase: ImagePhase;
  ready: boolean;
  needsRetry: boolean;
  awaitingEvent: boolean;
  retired?: boolean;
}
const imageStates = new WeakMap<HTMLImageElement, ImageState>();
export function bindAttachmentImages(root: ParentNode & Node, { ready = true, scope = '' } = {}) {
  for (const image of root.querySelectorAll<HTMLImageElement>('.attachment-image')) {
    const card = image.closest<HTMLElement>('.image-attachment');
    if (!card) continue;
    const url = image.getAttribute('src') || '',
      previous = imageStates.get(image),
      changed = previous && (previous.url !== url || previous.scope !== scope);
    let state = previous;
    if (!state || changed) {
      state = {
        url,
        scope,
        phase: 'loading',
        ready,
        needsRetry: !ready,
        awaitingEvent: Boolean(changed),
        retired: Boolean(changed && previous.scope !== scope && previous.url === url),
      };
      imageStates.set(image, state);
      if (changed) {
        card.style.removeProperty('--attachment-width');
        card.style.removeProperty('--attachment-ratio');
      }
    }
    if (state.retired) {
      image.onload = image.onerror = () => {};
      card.dataset.imageState = 'error';
      card.setAttribute('aria-busy', 'false');
      continue;
    }
    const retry = ready && !state.ready && state.needsRetry && state.phase !== 'ready';
    if (retry) {
      state = { url, scope, phase: 'loading', ready, needsRetry: false, awaitingEvent: true };
      imageStates.set(image, state);
    }
    state.ready = ready;
    if (!ready && state.phase !== 'ready') state.needsRetry = true;
    const owns = () =>
      imageStates.get(image) === state &&
      image.getAttribute('src') === url &&
      (!root.contains || root.contains(image));
    const update = (phase: ImagePhase) => {
      if (!owns()) return;
      state.phase = phase;
      if (phase === 'ready') state.needsRetry = false;
      else if (phase === 'error' && !state.ready) state.needsRetry = true;
      card.dataset.imageState = phase;
      card.setAttribute('aria-busy', String(phase === 'loading'));
      if (phase === 'ready') {
        const width = image.naturalWidth,
          height = image.naturalHeight;
        card.style.setProperty(
          '--attachment-width',
          Math.min(width, 440, (270 * width) / height) + 'px',
        );
        card.style.setProperty('--attachment-ratio', width + ' / ' + height);
      }
    };
    image.onload = () => {
      state.awaitingEvent = false;
      update(image.naturalWidth > 0 && image.naturalHeight > 0 ? 'ready' : 'error');
    };
    image.onerror = () => {
      state.awaitingEvent = false;
      update('error');
    };
    if (retry && url) {
      // A failed same-URL load is otherwise retained by reconciliation forever.
      // Only a confirmed readiness transition retries it; state refreshes do not.
      image.removeAttribute('src');
      image.setAttribute('src', url);
      update('loading');
    } else
      update(
        state.phase === 'ready' || state.phase === 'error' || state.awaitingEvent
          ? state.phase
          : image.complete
            ? image.naturalWidth > 0 && image.naturalHeight > 0
              ? 'ready'
              : 'error'
            : 'loading',
      );
  }
}
