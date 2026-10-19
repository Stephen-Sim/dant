import type { ProgressRenderItem } from '../../../ui/work/work-progress.mts';
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createWorkDisclosures } from '../../../ui/work/work-disclosures.mts';
import { workProgress, renderWorkTaskHistory } from '../../../ui/work/work-progress.mts';

function fixture() {
  const { document, Event } = parseHTML('<html><body><main id="app"></main></body></html>'),
    parent = document.querySelector<HTMLElement>('#app');
  const state = {
      conversationId: 'conversation-a',
      settings: { vm: { host: 'vm-a', user: 'dant', port: 22 } },
    },
    ui = createWorkDisclosures({ getState: () => state, document }),
    labels = workProgress({ worker: { status: 'online' }, messages: [], queue: [] }).labels;
  const items: ProgressRenderItem[] = [
    {
      id: 'one',
      title: 'First task',
      status: 'review',
      plan: {
        total: 3,
        completed: 1,
        steps: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Verify', status: 'inProgress' },
        ],
      },
    },
    {
      id: 'two',
      title: 'Second task',
      status: 'paused',
      plan: { total: 2, completed: 0, currentStep: 'Wait' },
    },
  ];
  function render(visible = items) {
    ui.capture();
    const next = document.createElement('template');
    next.innerHTML = visible
      .map((item) => renderWorkTaskHistory(item, labels, { planOpen: ui.isOpen(defined(item.id)) }))
      .join('');
    reconcile(defined(parent), next.content);
    ui.bind();
  }
  render();
  return {
    document,
    Event,
    state,
    ui,
    items,
    render,
    plan: (id: string) =>
      document.querySelector<HTMLDetailsElement>('[data-work-plan="' + id + '"]'),
  };
}

test('opening a task checklist survives a status render before its toggle event arrives', () => {
  const f = fixture(),
    node = f.plan('one');
  defined(node).setAttribute('open', '');
  defined(defined(f.items[0]).plan).completed = 2;
  defined(f.items[0]).status = 'completed';
  f.render();
  assert.equal(f.plan('one'), node);
  assert.equal(defined(node).hasAttribute('open'), true);
  assert.match(defined(defined(node).querySelector<HTMLElement>('summary')).textContent, /2 \/ 3/);
  assert.equal(defined(f.plan('two')).hasAttribute('open'), false);
});

test('each task remembers explicit opening and closing independently', () => {
  const f = fixture();
  for (const id of ['one', 'two']) {
    defined(f.plan(id)).setAttribute('open', '');
    defined(f.plan(id)).dispatchEvent(
      Object.assign(new f.Event('toggle'), { newState: 'closed', oldState: 'open', source: null }),
    );
  }
  f.render();
  assert.equal(defined(f.plan('one')).hasAttribute('open'), true);
  assert.equal(defined(f.plan('two')).hasAttribute('open'), true);
  defined(f.plan('one')).removeAttribute('open');
  defined(f.plan('one')).dispatchEvent(
    Object.assign(new f.Event('toggle'), { newState: 'closed', oldState: 'open', source: null }),
  );
  f.render();
  f.render();
  assert.equal(defined(f.plan('one')).hasAttribute('open'), false);
  assert.equal(defined(f.plan('two')).hasAttribute('open'), true);
});

test('closing and reopening the progress panel retains task expansion and ignores detached toggle events', () => {
  const f = fixture(),
    old = f.plan('one');
  defined(old).setAttribute('open', '');
  const staleToggle = defined(old).ontoggle;
  f.render([]);
  defined(old).removeAttribute('open');
  defined(staleToggle).call(
    defined(old),
    Object.assign(new f.Event('toggle'), { newState: 'closed', oldState: 'open', source: null }),
  );
  f.render();
  assert.notEqual(f.plan('one'), old);
  assert.equal(defined(f.plan('one')).hasAttribute('open'), true);
});

test('changing conversation or VM clears expansion and stale owners cannot change the new view', () => {
  const f = fixture();
  defined(f.plan('one')).setAttribute('open', '');
  f.render();
  const oldToggle = defined(f.plan('one')).ontoggle;
  f.state.conversationId = 'conversation-b';
  f.render();
  assert.equal(defined(f.plan('one')).hasAttribute('open'), false);
  defined(oldToggle).call(
    defined(f.plan('one')),
    Object.assign(new f.Event('toggle'), { newState: 'closed', oldState: 'open', source: null }),
  );
  f.render();
  assert.equal(defined(f.plan('one')).hasAttribute('open'), false);
  defined(f.plan('one')).setAttribute('open', '');
  f.render();
  f.state.settings.vm.host = 'vm-b';
  f.render();
  assert.equal(defined(f.plan('one')).hasAttribute('open'), false);
});
