import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../ui/shared/dom.js';
import { createWorkDisclosures } from '../ui/work/work-disclosures.js';
import { workProgress, renderWorkTaskHistory } from '../ui/work/work-progress.js';

function fixture() {
  const { document, Event } = parseHTML('<html><body><main id="app"></main></body></html>'),
    parent = document.querySelector('#app');
  const state = {
      conversationId: 'conversation-a',
      settings: { vm: { host: 'vm-a', user: 'dant', port: 22 } },
    },
    ui = createWorkDisclosures({ getState: () => state, document }),
    labels = workProgress({ worker: { status: 'online' }, messages: [], queue: [] }).labels;
  const items = [
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
      .map((item) => renderWorkTaskHistory(item, labels, { planOpen: ui.isOpen(item.id) }))
      .join('');
    reconcile(parent, next.content);
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
    plan: (id) => document.querySelector('[data-work-plan="' + id + '"]'),
  };
}

test('opening a task checklist survives a status render before its toggle event arrives', () => {
  const f = fixture(),
    node = f.plan('one');
  node.setAttribute('open', '');
  f.items[0].plan.completed = 2;
  f.items[0].status = 'completed';
  f.render();
  assert.equal(f.plan('one'), node);
  assert.equal(node.hasAttribute('open'), true);
  assert.match(node.querySelector('summary').textContent, /2 \/ 3/);
  assert.equal(f.plan('two').hasAttribute('open'), false);
});

test('each task remembers explicit opening and closing independently', () => {
  const f = fixture();
  for (const id of ['one', 'two']) {
    f.plan(id).setAttribute('open', '');
    f.plan(id).dispatchEvent(new f.Event('toggle'));
  }
  f.render();
  assert.equal(f.plan('one').hasAttribute('open'), true);
  assert.equal(f.plan('two').hasAttribute('open'), true);
  f.plan('one').removeAttribute('open');
  f.plan('one').dispatchEvent(new f.Event('toggle'));
  f.render();
  f.render();
  assert.equal(f.plan('one').hasAttribute('open'), false);
  assert.equal(f.plan('two').hasAttribute('open'), true);
});

test('closing and reopening the progress panel retains task expansion and ignores detached toggle events', () => {
  const f = fixture(),
    old = f.plan('one');
  old.setAttribute('open', '');
  const staleToggle = old.ontoggle;
  f.render([]);
  old.removeAttribute('open');
  staleToggle();
  f.render();
  assert.notEqual(f.plan('one'), old);
  assert.equal(f.plan('one').hasAttribute('open'), true);
});

test('changing conversation or VM clears expansion and stale owners cannot change the new view', () => {
  const f = fixture();
  f.plan('one').setAttribute('open', '');
  f.render();
  const oldToggle = f.plan('one').ontoggle;
  f.state.conversationId = 'conversation-b';
  f.render();
  assert.equal(f.plan('one').hasAttribute('open'), false);
  oldToggle();
  f.render();
  assert.equal(f.plan('one').hasAttribute('open'), false);
  f.plan('one').setAttribute('open', '');
  f.render();
  f.state.settings.vm.host = 'vm-b';
  f.render();
  assert.equal(f.plan('one').hasAttribute('open'), false);
});
