import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createWorkspaceLayout, workspaceWidths } from '../../../ui/work/workspace-layout.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
import { defined } from '../../support/fixture-assertions.mts';

function fixture({
  width = 1400,
  progress = true,
  computer = true,
  saved = new Map<string, string>(),
  unavailableStorage = false,
} = {}) {
  const { document, Event } = parseHTML('<html><body><div id="app"></div></body></html>');
  const listeners = new Map<string, Set<() => void>>();
  const window = {
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      defined(listeners.get(type)).add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const writes: [string, string][] = [];
  const storage = {
    getItem(key: string) {
      if (unavailableStorage) throw Error('Unavailable fixture storage');
      return saved.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (unavailableStorage) throw Error('Unavailable fixture storage');
      writes.push([key, value]);
      saved.set(key, value);
    },
  };
  const layout = createWorkspaceLayout({ document, window, storage });
  function render() {
    const template = document.createElement('template');
    template.innerHTML = `<div class="workspace ${progress ? 'progress-visible' : ''} ${computer ? 'computer-visible' : ''}" data-key="workspace"><section class="conversation" data-key="chat"><textarea>Unsent draft</textarea><audio controls src="fixture.webm"></audio></section>${progress ? '<div data-key="progress-resize" class="resize-handle" data-workspace-resize="progress" role="separator" aria-controls="work-progress-panel" aria-label="Resize work progress" tabindex="0"></div><aside data-key="progress" data-progress-panel><button>Existing task</button></aside>' : ''}${computer ? '<div data-key="computer-resize" class="resize-handle" data-workspace-resize="computer" role="separator" aria-controls="computer-panel" aria-label="Resize computer" tabindex="0"></div><aside class="computer-panel" data-key="computer"><img src="fixture.png"></aside>' : ''}</div>`;
    reconcile(defined(document.querySelector('#app')), template.content);
    const node = defined(document.querySelector<HTMLElement>('.workspace'));
    node.getBoundingClientRect = () => ({
      width,
      height: 700,
      left: 52,
      right: 52 + width,
      top: 60,
      bottom: 760,
      x: 52,
      y: 60,
      toJSON() {
        return {};
      },
    });
    layout.bind();
  }
  render();
  const handle = (pane: 'progress' | 'computer') =>
    defined(document.querySelector<HTMLElement>(`[data-workspace-resize="${pane}"]`));
  const paneWidth = (pane: 'progress' | 'computer') =>
    parseFloat(
      defined(
        document.querySelector<HTMLElement>(
          pane === 'progress' ? '[data-progress-panel]' : '.computer-panel',
        ),
      ).style.width,
    );
  function event(
    target: EventTarget,
    type: string,
    values: Record<string, number | string | boolean> = {},
  ) {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      pointerId: 7,
      button: 0,
      isPrimary: true,
      clientX: 500,
      ...values,
    });
    target.dispatchEvent(event);
    return event;
  }
  return {
    document,
    layout,
    saved,
    writes,
    listeners,
    handle,
    paneWidth,
    event,
    render,
    workspace: () => defined(document.querySelector<HTMLElement>('.workspace')),
    resize(value: number) {
      width = value;
      for (const listener of listeners.get('resize') ?? []) listener();
    },
    hideProgress() {
      progress = false;
      render();
    },
    hideComputer() {
      computer = false;
      render();
    },
    windowEvent(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    drag(pane: 'progress' | 'computer', delta: number) {
      event(handle(pane), 'pointerdown');
      event(document, 'pointermove', { clientX: 500 + delta });
      event(document, 'pointerup');
    },
  };
}

test('pane widths honor minimums and only stack when the visible panes cannot fit', () => {
  assert.deepEqual(workspaceWidths(1400, true, true), {
    mode: 'columns',
    progress: 320,
    computer: 756,
  });
  assert.deepEqual(workspaceWidths(876, true, true), {
    mode: 'columns',
    progress: 260,
    computer: 320,
  });
  assert.equal(workspaceWidths(875, true, true).mode, 'split');
  assert.equal(workspaceWidths(548, true, true).mode, 'split');
  assert.equal(workspaceWidths(547, true, true).mode, 'stacked');
  assert.equal(workspaceWidths(548, true, false).mode, 'columns');
  assert.deepEqual(workspaceWidths(1000, false, true, { computer: 900 }), {
    mode: 'columns',
    progress: 0,
    computer: 712,
  });
  assert.equal(workspaceWidths(Number.NaN, true, true).mode, 'stacked');
});

test('Chat to Progress drag resizes those panes without moving Computer or replacing interactive nodes', () => {
  const f = fixture(),
    computer = f.paneWidth('computer');
  const audio = f.document.querySelector('audio'),
    textarea = defined(f.document.querySelector('textarea'));
  textarea.value = 'Retained unsent message';
  f.drag('progress', -20);
  assert.equal(f.paneWidth('progress'), 340);
  assert.equal(f.paneWidth('computer'), computer);
  assert.equal(f.document.querySelector('audio'), audio);
  assert.equal(f.document.querySelector('textarea'), textarea);
  assert.equal(textarea.value, 'Retained unsent message');
  assert.equal(f.saved.get('workProgressWidth'), '340');
  assert.equal(f.handle('progress').getAttribute('aria-valuenow'), '340');
  assert.equal(f.workspace().hasAttribute('data-workspace-resizing'), false);
  const reopened = fixture({ saved: f.saved });
  assert.equal(reopened.paneWidth('progress'), 340);
  assert.equal(reopened.paneWidth('computer'), computer);
});

test('Progress to Computer drag transfers width between those two panes, retaining chat width', () => {
  const f = fixture(),
    sum = f.paneWidth('progress') + f.paneWidth('computer');
  f.drag('computer', 50);
  assert.equal(f.paneWidth('computer'), 706);
  assert.equal(f.paneWidth('progress'), 370);
  assert.equal(f.paneWidth('progress') + f.paneWidth('computer'), sum);
  assert.equal(f.saved.get('computerWidth'), '706');
  assert.equal(f.saved.get('workProgressWidth'), '370');
  f.drag('computer', -10000);
  assert.equal(f.paneWidth('progress'), 260);
  assert.equal(f.paneWidth('computer'), sum - 260);
});

test('computer-only resizing preserves the existing preference key and accessible Home/End/arrow controls', () => {
  const f = fixture({ progress: false, width: 1000, saved: new Map([['computerWidth', '500']]) });
  assert.equal(f.paneWidth('computer'), 500);
  f.event(f.handle('computer'), 'keydown', { key: 'ArrowLeft' });
  assert.equal(f.paneWidth('computer'), 520);
  f.event(f.handle('computer'), 'keydown', { key: 'ArrowRight' });
  assert.equal(f.paneWidth('computer'), 500);
  f.event(f.handle('computer'), 'keydown', { key: 'End' });
  assert.equal(f.paneWidth('computer'), 712);
  f.event(f.handle('computer'), 'keydown', { key: 'Home' });
  assert.equal(f.paneWidth('computer'), 320);
  assert.equal(f.handle('computer').getAttribute('aria-valuemin'), '320');
  assert.equal(f.handle('computer').getAttribute('aria-valuemax'), '712');
  const before = f.writes.length;
  f.event(f.handle('computer'), 'keydown', { key: 'a' });
  f.event(f.handle('computer'), 'keydown', { key: 'ArrowLeft', isComposing: true });
  assert.equal(f.writes.length, before);
});

test('window resizing temporarily clamps saved widths and disables only dividers that cannot fit', () => {
  const f = fixture({
    saved: new Map([
      ['workProgressWidth', '400'],
      ['computerWidth', '600'],
    ]),
  });
  f.resize(1000);
  assert.equal(f.workspace().dataset.workspaceLayout, 'columns');
  assert.equal(f.paneWidth('progress'), 384);
  assert.equal(f.paneWidth('computer'), 320);
  f.resize(750);
  assert.equal(f.workspace().dataset.workspaceLayout, 'split');
  assert.equal(f.handle('computer').hidden, true);
  assert.equal(f.handle('progress').hidden, false);
  assert.equal(f.handle('computer').tabIndex, -1);
  f.resize(500);
  assert.equal(f.workspace().dataset.workspaceLayout, 'stacked');
  assert.equal(f.handle('progress').hidden, true);
  f.event(f.handle('progress'), 'keydown', { key: 'ArrowLeft' });
  assert.equal(f.writes.length, 0);
  f.resize(1400);
  assert.equal(f.paneWidth('progress'), 400);
  assert.equal(f.paneWidth('computer'), 600);
});

test('invalid or unavailable saved preferences cannot overflow the workspace or break dragging', () => {
  for (const value of ['Infinity', '-20', '10001', 'not a width', '', '0']) {
    const f = fixture({
      saved: new Map([
        ['workProgressWidth', value],
        ['computerWidth', value],
      ]),
    });
    assert.equal(f.paneWidth('progress'), 320);
    assert.equal(f.paneWidth('computer'), 756);
    f.layout.dispose();
  }
  const f = fixture({ unavailableStorage: true });
  f.drag('progress', -20);
  assert.equal(f.paneWidth('progress'), 340);
});

test('foreign pointer events cannot resize and cancellation, blur, removal and disposal release gestures', () => {
  const f = fixture(),
    handle = f.handle('progress');
  f.event(handle, 'pointerdown', { button: 2 });
  f.event(handle, 'pointerdown', { isPrimary: false });
  f.event(handle, 'pointerdown', { clientX: Number.NaN });
  f.event(f.document, 'pointermove', { clientX: 100 });
  assert.equal(f.paneWidth('progress'), 320);
  f.event(handle, 'pointerdown');
  f.event(f.document, 'pointermove', { pointerId: 8, clientX: 100 });
  f.event(f.document, 'pointerup', { pointerId: 8 });
  assert.equal(f.paneWidth('progress'), 320);
  f.event(f.document, 'pointermove', { clientX: 480 });
  f.event(f.document, 'pointercancel');
  f.event(f.document, 'pointermove', { clientX: 400 });
  assert.equal(f.paneWidth('progress'), 340);
  f.event(handle, 'pointerdown');
  f.windowEvent('blur');
  assert.equal(f.workspace().hasAttribute('data-workspace-resizing'), false);
  f.event(handle, 'pointerdown');
  f.hideProgress();
  f.event(f.document, 'pointermove', { clientX: 100 });
  assert.equal(f.workspace().hasAttribute('data-workspace-resizing'), false);
  f.layout.dispose();
  assert.equal(f.listeners.get('resize')?.size, 0);
  assert.equal(f.listeners.get('blur')?.size, 0);
  f.layout.bind();
});

test('state refresh restores widths without replacing panes or their active gesture', () => {
  const f = fixture(),
    handle = f.handle('progress'),
    panel = f.document.querySelector('[data-progress-panel]');
  f.event(handle, 'pointerdown');
  f.event(f.document, 'pointermove', { clientX: 480 });
  f.render();
  assert.equal(f.handle('progress'), handle);
  assert.equal(f.document.querySelector('[data-progress-panel]'), panel);
  assert.equal(f.paneWidth('progress'), 340);
  f.event(f.document, 'pointermove', { clientX: 475 });
  f.event(f.document, 'pointerup');
  assert.equal(f.paneWidth('progress'), 345);
});

test('right-to-left layouts retain physical pointer and keyboard directions', () => {
  const f = fixture();
  f.document.documentElement.dir = 'rtl';
  f.drag('progress', -20);
  assert.equal(f.paneWidth('progress'), 300);
  f.event(f.handle('progress'), 'keydown', { key: 'ArrowRight' });
  assert.equal(f.paneWidth('progress'), 320);
});

test('losing capture or removing a neighboring pane ends the gesture without applying stale widths', () => {
  const f = fixture();
  f.event(f.handle('progress'), 'pointerdown');
  f.event(f.handle('progress'), 'lostpointercapture');
  f.event(f.document, 'pointermove', { clientX: 480 });
  assert.equal(f.paneWidth('progress'), 320);
  f.event(f.handle('progress'), 'pointerdown');
  f.hideComputer();
  f.event(f.document, 'pointermove', { clientX: 480 });
  assert.equal(f.paneWidth('progress'), 320);
  assert.equal(f.workspace().hasAttribute('data-workspace-resizing'), false);
  f.event(f.handle('progress'), 'pointerdown');
  defined(f.document.querySelector('#app')).replaceChildren();
  f.layout.bind();
  f.event(f.document, 'pointermove', { clientX: 480 });
  f.layout.dispose();
});
