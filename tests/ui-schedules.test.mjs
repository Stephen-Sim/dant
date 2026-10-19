import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../ui/shared/dom.js';
import { createSchedules } from '../ui/schedules/schedules.js';

const now = Date.parse('2026-10-18T00:00:00Z');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const item = (id, status = 'pending', extra = {}) => ({
  id,
  status,
  enabled: status === 'pending',
  text: 'Task ' + id,
  at: now + 86400000,
  timeZone: 'Asia/Kuala_Lumpur',
  ...extra,
});
function fixture({
  items = [],
  online = true,
  language = 'en',
  zone = 'Asia/Kuala_Lumpur',
  recurring = false,
} = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector('#app'),
    calls = [],
    toasts = [],
    backend = structuredClone(items),
    state = {
      conversationId: 'conversation',
      capabilities: { recurringSchedules: recurring },
      settings: { language, vm: { host: 'vm-one', user: 'dant', port: 22 } },
      worker: { status: online ? 'online' : 'offline' },
      controller: { status: online ? 'online' : 'offline', cached: false },
      schedules: structuredClone(items),
    };
  let ui,
    wait = null,
    fail = null,
    after = null,
    connected = true,
    id = 0;
  function render() {
    const template = document.createElement('template');
    template.innerHTML = ui.renderPage();
    for (const textarea of template.content.querySelectorAll('textarea')) {
      const decoder = document.createElement('div');
      decoder.innerHTML = textarea.textContent;
      textarea.textContent = decoder.textContent;
    }
    reconcile(app, template.content);
    ui.bind();
  }
  async function request(route, options = {}) {
    const method = options.method || 'GET';
    calls.push({ route, method, ...structuredClone(options) });
    if (wait) await wait(route, options);
    if (fail?.(route, options)) throw Error('private server details');
    let result;
    if (method === 'GET')
      result = {
        items: structuredClone(backend),
        now: new Date(now).toISOString(),
        timeZone: zone,
      };
    else if (method === 'POST') {
      let created = backend.find((entry) => entry.clientRequestId === options.body.clientRequestId);
      if (!created) {
        created = item('created-' + ++id, 'pending', options.body);
        backend.push(created);
      }
      result = structuredClone(created);
    } else {
      const selected = backend.find(
        (entry) => entry.id === decodeURIComponent(route.split('/').at(-1)),
      );
      assert.ok(selected, 'Unexpected schedule ID');
      if (method === 'DELETE') {
        backend.splice(backend.indexOf(selected), 1);
        result = { deleted: true, id: selected.id };
      } else {
        Object.assign(selected, options.body);
        if (Object.hasOwn(options.body, 'enabled'))
          selected.status = options.body.enabled ? 'pending' : 'paused';
        result = structuredClone(selected);
      }
    }
    if (after) await after(route, options, result);
    return result;
  }
  ui = createSchedules({
    getState: () => state,
    request,
    render,
    document,
    toast: (message) => toasts.push(message),
    connected: () => connected,
    now: () => now,
    timeZone: () => zone,
    getID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
  });
  render();
  return {
    ui,
    document,
    state,
    backend,
    calls,
    toasts,
    render,
    set wait(value) {
      wait = value;
    },
    set fail(value) {
      fail = value;
    },
    set after(value) {
      after = value;
    },
    set connected(value) {
      connected = value;
    },
    node: (selector) => document.querySelector(selector),
    async click(selector) {
      const node = document.querySelector(selector);
      assert.ok(node, 'Missing ' + selector);
      await node.onclick?.({ preventDefault() {} });
    },
    input(name, value) {
      const node = document.querySelector(`[name="${name}"]`);
      assert.ok(node, 'Missing input ' + name);
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      return node;
    },
    select(name, value) {
      const node = document.querySelector(`select[name="${name}"]`);
      assert.ok(node, 'Missing select ' + name);
      for (const option of node.querySelectorAll('option')) {
        if (option.value === value) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      }
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.onchange?.();
      return node;
    },
    async submit() {
      const form = document.querySelector('[data-schedule-editor]');
      assert.ok(form);
      await form.onsubmit({ preventDefault() {} });
    },
  };
}
async function draft(f, text = 'Check the project', at = '2026-10-19T09:30') {
  await f.click('[data-schedule-add]');
  f.input('text', text);
  f.input('at', at);
}

test('schedule creation sends a stable request ID and the displayed time zone, then closes only after confirmation', async () => {
  const f = fixture();
  await draft(f, '  Check <project>  ');
  const pause = deferred();
  f.wait = (route, options) => (options.method === 'POST' ? pause.promise : undefined);
  const pending = f.submit();
  assert.ok(f.node('[data-schedule-editor]'));
  assert.equal(f.node('[type="submit"]').disabled, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, {
    text: 'Check <project>',
    at: Date.parse('2026-10-19T01:30:00Z'),
    timeZone: 'Asia/Kuala_Lumpur',
    clientRequestId: '00000000-0000-4000-8000-000000000001',
  });
  pause.resolve();
  await pending;
  assert.equal(f.node('[data-schedule-editor]'), null);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['POST', 'GET'],
  );
  assert.equal(f.state.schedules.length, 1);
  assert.equal(f.node('project'), null);
  assert.match(f.node('.schedule-card-text').textContent, /<project>/);
});

test('a lost create acknowledgement retries the original ID and payload before applying edited draft content', async () => {
  const f = fixture();
  await draft(f);
  let lost = true;
  f.after = (route, options) => {
    if (options.method === 'POST' && lost) {
      lost = false;
      throw Error('Connection lost');
    }
  };
  await f.submit();
  assert.ok(f.node('[data-schedule-editor]'));
  assert.equal(f.backend.length, 1);
  assert.equal(f.toasts.length, 1);
  assert.doesNotMatch(f.document.toString(), /Connection lost|private server/);
  f.input('text', 'Updated instructions');
  await f.submit();
  const posts = f.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(f.backend.length, 1);
  assert.equal(f.backend[0].text, 'Updated instructions');
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['POST', 'POST', 'PATCH', 'GET'],
  );
  assert.equal(f.node('[data-schedule-editor]'), null);
});

test('acknowledged creation with a failed list refresh keeps a draft bound to that task for safe retry', async () => {
  const f = fixture();
  await draft(f);
  f.fail = (route, options) => !options.method;
  await f.submit();
  assert.ok(f.node('[data-schedule-editor]'));
  assert.equal(f.backend.length, 1);
  f.fail = null;
  await f.submit();
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(f.node('[data-schedule-editor]'), null);
});

test('editing preserves the task zone and its wall time independently of the browser default zone', async () => {
  const original = item('edit', 'pending', {
      at: Date.parse('2026-10-19T14:15:00Z'),
      timeZone: 'America/New_York',
    }),
    f = fixture({ items: [original] });
  await f.click('[data-schedule-edit]');
  assert.equal(f.node('[name="at"]').value, '2026-10-19T10:15');
  assert.match(f.node('.schedule-editor-time').textContent, /America\/New_York/);
  f.input('text', 'Edited task');
  await f.submit();
  assert.equal(f.calls[0].method, 'PATCH');
  assert.deepEqual(f.calls[0].body, {
    text: 'Edited task',
    at: original.at,
    timeZone: 'America/New_York',
  });
  assert.equal(f.backend[0].text, 'Edited task');
});

test('unsaved live draft values survive state updates, refresh and another task pause or removal', async () => {
  const f = fixture({ items: [item('other')] });
  await draft(f, 'Keep my <draft>');
  const textarea = f.node('[name="text"]');
  textarea.value = 'Unsaved live value';
  f.state.schedules.push(item('streamed'));
  f.render();
  assert.equal(f.node('[name="text"]'), textarea);
  assert.equal(textarea.value, 'Unsaved live value');
  await f.click('[data-schedules-refresh]');
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['GET'],
  );
  assert.equal(f.node('[name="text"]').value, 'Unsaved live value');
  await f.click('[data-schedule-toggle="other"]');
  assert.equal(f.backend[0].status, 'paused');
  assert.equal(f.node('[name="text"]').value, 'Unsaved live value');
  await f.click('[data-schedule-filter="paused"]');
  await f.click('[data-schedule-remove="other"]');
  assert.equal(f.backend.length, 0);
  assert.equal(f.node('[name="text"]').value, 'Unsaved live value');
  assert.equal(f.node('[name="at"]').value, '2026-10-19T09:30');
});

test('pause, resume, edit and delete use local endpoints without navigation', async () => {
  const f = fixture({ items: [item('one/id')] });
  await f.click('[data-schedule-toggle]');
  assert.deepEqual(f.calls[0], {
    route: '/schedules/one%2Fid',
    method: 'PATCH',
    body: { enabled: false },
  });
  await f.click('[data-schedule-filter="paused"]');
  await f.click('[data-schedule-toggle]');
  assert.equal(f.backend[0].status, 'pending');
  await f.click('[data-schedule-filter="upcoming"]');
  await f.click('[data-schedule-edit]');
  await f.click('[data-schedule-remove]');
  assert.equal(f.node('[data-schedule-editor]'), null);
  assert.equal(f.backend.length, 0);
  assert.ok(f.calls.every((call) => call.route.startsWith('/schedules')));
  assert.equal(f.document.querySelector('a'), null);
});

test('expired paused work asks for a future date without overwriting an existing draft', async () => {
  const f = fixture({ items: [item('expired', 'paused', { at: now - 1 })] });
  await f.click('[data-schedule-filter="paused"]');
  await f.click('[data-schedule-toggle]');
  assert.equal(f.node('[name="at"]').value, '');
  assert.match(f.node('.schedule-editor').textContent, /future/);
  await f.click('[data-schedule-cancel]');
  await draft(f, 'My separate task');
  await f.click('[data-schedule-toggle]');
  assert.equal(f.node('[name="text"]').value, 'My separate task');
  assert.equal(f.calls.length, 0);
});

test('filters, normalized search and safe malformed-date rendering work in both languages', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({
      language,
      items: [
        item('one', 'pending', { text: 'ＰＲＯＪＥＣＴ <script>alert(1)</script>' }),
        item('two', 'paused'),
        item('three', 'dispatched', { at: 'bad-date' }),
        item('four', 'unknown'),
      ],
    });
    assert.equal(f.document.querySelectorAll('.schedule-card').length, 1);
    await f.click('[data-schedule-filter="all"]');
    assert.equal(f.document.querySelectorAll('.schedule-card').length, 4);
    assert.equal(f.document.querySelector('script'), null);
    assert.equal(f.node('[data-key="schedule-three"] time').getAttribute('datetime'), '');
    const search = f.node('#schedules-search');
    search.value = 'project';
    search.oninput();
    assert.equal(f.document.querySelectorAll('.schedule-card').length, 1);
    search.value = '';
    search.oninput();
    await f.click('[data-schedule-filter="history"]');
    assert.equal(f.document.querySelectorAll('.schedule-card').length, 2);
    assert.equal(f.document.querySelectorAll('[data-schedule-edit]').length, 0);
  }
});

test('invalid, past and nonexistent daylight-saving times fail before dispatch and preserve the draft', async () => {
  const f = fixture({ zone: 'America/New_York' });
  await draft(f, '', 'invalid');
  await f.submit();
  assert.match(f.node('.error').textContent, /Describe/);
  f.input('text', 'Task');
  for (const value of ['invalid', '2026-02-30T12:00', '2026-10-17T09:00', '2027-03-14T02:30']) {
    f.input('at', value);
    await f.submit();
    assert.match(f.node('.error').textContent, /future/);
    assert.equal(f.node('[name="text"]').value, 'Task');
  }
  assert.equal(f.calls.length, 0);
});

test('offline, cached and disconnected states disable mutations but preserve an editable draft', async () => {
  for (const mode of ['worker', 'controller', 'cached', 'disconnected']) {
    const f = fixture({ items: [item('one')] });
    await draft(f);
    if (mode === 'worker') f.state.worker.status = 'offline';
    if (mode === 'controller') f.state.controller.status = 'offline';
    if (mode === 'cached') f.state.controller.cached = true;
    if (mode === 'disconnected') f.connected = false;
    f.render();
    assert.equal(f.node('[data-schedule-add]').disabled, true);
    assert.equal(f.node('[type="submit"]').disabled, true);
    assert.ok(f.node('.skills-page-notice'));
    await f.submit();
    await f.click('[data-schedule-toggle]');
    await f.click('[data-schedules-refresh]');
    assert.equal(f.calls.length, 0);
    assert.equal(f.node('[name="text"]').value, 'Check the project');
  }
});

test('stale refresh responses and captured old controls cannot change another VM scope', async () => {
  const f = fixture({ items: [item('old')] });
  const oldControl = f.node('[data-schedule-toggle]'),
    wait = deferred();
  f.wait = () => wait.promise;
  const pending = f.click('[data-schedules-refresh]');
  f.state.settings.vm.host = 'vm-two';
  f.state.schedules = [item('new')];
  f.render();
  await oldControl.onclick();
  wait.resolve();
  await pending;
  assert.deepEqual(
    f.state.schedules.map((entry) => entry.id),
    ['new'],
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.node('[data-schedules-refresh]').disabled, false);
});

test('a stale save acknowledgement does not refresh, close the new editor, or show errors in another scope', async () => {
  for (const reject of [false, true]) {
    const f = fixture();
    await draft(f, 'Old VM draft');
    const wait = deferred();
    f.wait = () => wait.promise;
    const pending = f.submit();
    f.state.settings.vm.host = 'vm-two';
    f.state.schedules = [];
    f.render();
    await draft(f, 'New VM draft');
    if (reject) wait.reject(Error('old VM failure'));
    else wait.resolve();
    await pending;
    assert.equal(f.node('[name="text"]').value, 'New VM draft');
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.schedules.length, 0);
    assert.deepEqual(f.toasts, []);
  }
});

test('definite mutation failures retain the draft and cancellation clears only local form state', async () => {
  const f = fixture({ items: [item('one')] });
  await f.click('[data-schedule-edit]');
  f.input('text', 'Keep this edit');
  f.fail = () => true;
  await f.submit();
  assert.equal(f.node('[name="text"]').value, 'Keep this edit');
  assert.equal(f.backend[0].text, 'Task one');
  assert.equal(f.calls.length, 1);
  await f.click('[data-schedule-cancel]');
  assert.equal(f.node('[data-schedule-editor]'), null);
  assert.equal(f.calls.length, 1);
});

test('daily and weekly schedules send only cron plus priority and let the service calculate the next run', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ recurring: true, language });
    await draft(f, 'Repeat safely');
    f.select('repeat', 'daily');
    f.input('time', '08:30');
    f.select('priority', 'high');
    assert.equal(f.node('[name="at"]'), null);
    assert.match(
      f.node('.schedule-next-run').textContent,
      language === 'en' ? /calculated/ : /计算/,
    );
    await f.submit();
    assert.deepEqual(f.calls[0].body, {
      text: 'Repeat safely',
      timeZone: 'Asia/Kuala_Lumpur',
      cron: '30 8 * * *',
      priority: 'high',
      clientRequestId: '00000000-0000-4000-8000-000000000001',
    });
    assert.match(
      f.node('.schedule-card-meta').textContent,
      language === 'en' ? /Every day · 08:30/ : /每天 · 08:30/,
    );
    assert.equal(f.node('[data-schedule-priority]').dataset.schedulePriority, 'high');
    assert.match(
      f.node('.schedule-card-date').textContent,
      language === 'en' ? /Next run/ : /下次执行/,
    );
    await draft(f, 'Weekly work');
    f.select('repeat', 'weekly');
    f.input('time', '18:45');
    f.select('weekday', '0');
    f.select('priority', 'low');
    await f.submit();
    const body = f.calls.filter((call) => call.method === 'POST').at(-1).body;
    assert.equal(body.cron, '45 18 * * 0');
    assert.equal(body.priority, 'low');
    assert.equal(Object.hasOwn(body, 'at'), false);
  }
});

test('editing recurring schedules preserves their exact cron and original zone until rule controls are changed', async () => {
  for (const cron of ['00   09 * * *', '0 9 * * 7', '*/15 9-17 * JAN,MAR MON-FRI']) {
    const original = item('repeat', 'pending', {
        cron,
        priority: 'low',
        timeZone: 'America/New_York',
      }),
      f = fixture({ recurring: true, items: [original] });
    await f.click('[data-schedule-edit]');
    assert.match(f.node('.schedule-next-run').textContent, /Next run/);
    f.input('text', 'Keep the original rule');
    await f.submit();
    assert.deepEqual(f.calls[0].body, {
      text: 'Keep the original rule',
      timeZone: 'America/New_York',
      cron,
      priority: 'low',
    });
    assert.equal(Object.hasOwn(f.calls[0].body, 'at'), false);
  }
  const f = fixture({
    recurring: true,
    items: [item('repeat', 'pending', { cron: '00   09 * * *', priority: 'normal' })],
  });
  await f.click('[data-schedule-edit]');
  f.input('time', '09:15');
  await f.submit();
  assert.equal(f.calls[0].body.cron, '15 9 * * *');
});

test('custom cron has a five-field explanation, accepts supported syntax and safely rejects malformed rules', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ recurring: true, language });
    await draft(f);
    f.select('repeat', 'custom');
    assert.ok(f.node('#schedule-cron-help'));
    assert.match(
      f.node('#schedule-cron-help').textContent,
      language === 'en'
        ? /minute.*hour.*day of month.*month.*day of week/
        : /分钟.*小时.*日期.*月份.*星期/,
    );
    for (const cron of [
      '@daily',
      '0 0 9 * * *',
      '60 9 * * *',
      '*/0 * * * *',
      '*/61 * * * *',
      '5/2 * * * *',
      '0 25 * * *',
      '0 9 * BAD *',
      '0 9 * * MON#2',
      '0 9 * * <script>',
      '0 9\n* * *',
    ]) {
      f.input('cron', cron);
      await f.submit();
      assert.equal(f.calls.length, 0, cron);
      assert.match(f.node('.error').textContent, language === 'en' ? /five-field/ : /五字段/);
      assert.equal(f.node('[name="text"]').value, 'Check the project');
    }
    f.input('cron', '*/15 9-17 * JAN,MAR MON-FRI');
    await f.submit();
    assert.equal(f.calls[0].body.cron, '*/15 9-17 * JAN,MAR MON-FRI');
    assert.equal(f.document.querySelector('script'), null);
  }
});

test('switching recurring and one-time modes never sends at and cron as competing time sources', async () => {
  const f = fixture({
    recurring: true,
    items: [item('repeat', 'pending', { cron: '0 9 * * *', priority: 'high' })],
  });
  await f.click('[data-schedule-edit]');
  f.select('repeat', 'once');
  f.input('at', '2026-10-20T11:00');
  await f.submit();
  assert.deepEqual(f.calls[0].body, {
    text: 'Task repeat',
    at: Date.parse('2026-10-20T03:00:00Z'),
    timeZone: 'Asia/Kuala_Lumpur',
    cron: null,
    priority: 'high',
  });
  const g = fixture({ recurring: true });
  await draft(g);
  g.select('repeat', 'daily');
  g.input('time', '10:00');
  await g.submit();
  assert.equal(g.calls[0].body.cron, '0 10 * * *');
  assert.equal(Object.hasOwn(g.calls[0].body, 'at'), false);
});

test('an expired paused recurring schedule resumes its original rule without asking for another date', async () => {
  const f = fixture({
    recurring: true,
    items: [item('repeat', 'paused', { at: now - 86400000, cron: '0 9 * * *', priority: 'high' })],
  });
  await f.click('[data-schedule-filter="paused"]');
  await f.click('[data-schedule-toggle]');
  assert.deepEqual(f.calls[0], {
    route: '/schedules/repeat',
    method: 'PATCH',
    body: { enabled: true },
  });
  assert.equal(f.node('[data-schedule-editor]'), null);
  assert.equal(f.backend[0].cron, '0 9 * * *');
  assert.equal(f.backend[0].priority, 'high');
});

test('lost recurring create acknowledgements retain the original ID, cron and priority before applying edited rules', async () => {
  const f = fixture({ recurring: true });
  await draft(f, 'Original recurring work');
  f.select('repeat', 'weekly');
  f.input('time', '09:30');
  f.select('weekday', '1');
  f.select('priority', 'high');
  let lost = true;
  f.after = (route, options) => {
    if (options.method === 'POST' && lost) {
      lost = false;
      throw Error('Lost acknowledgement');
    }
  };
  await f.submit();
  assert.equal(f.backend.length, 1);
  assert.ok(f.node('[data-schedule-editor]'));
  f.select('repeat', 'custom');
  f.input('cron', '0 10 * * 1-5');
  f.select('priority', 'low');
  f.input('text', 'Edited recurring work');
  await f.submit();
  const posts = f.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(posts[0].body.cron, '30 9 * * 1');
  assert.equal(posts[0].body.priority, 'high');
  assert.equal(f.backend.length, 1);
  assert.equal(f.backend[0].cron, '0 10 * * 1-5');
  assert.equal(f.backend[0].priority, 'low');
  assert.equal(f.backend[0].text, 'Edited recurring work');
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 1);
});

test('old work services keep legacy one-time payloads and cannot silently downgrade recurrence or priority', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language });
    await draft(f);
    assert.equal(f.node('[name="priority"]').disabled, true);
    assert.equal(f.node('[name="repeat"] option[value="daily"]').hasAttribute('disabled'), true);
    assert.match(
      f.node('.schedule-capability-notice').textContent,
      language === 'en' ? /Update the work computer/ : /更新工作电脑服务/,
    );
    f.select('repeat', 'daily');
    await f.submit();
    assert.equal(f.calls.length, 0);
    assert.match(f.node('.error').textContent, language === 'en' ? /Update/ : /更新/);
    const g = fixture({ language });
    await draft(g);
    g.select('priority', 'high');
    await g.submit();
    assert.equal(g.calls.length, 0);
    const h = fixture({
      language,
      items: [item('repeat', 'pending', { cron: '0 9 * * *', priority: 'high' })],
    });
    for (const action of ['edit', 'toggle', 'remove']) {
      assert.equal(h.node(`[data-schedule-${action}]`).disabled, true);
      await h.click(`[data-schedule-${action}]`);
    }
    assert.equal(h.calls.length, 0);
  }
  const f = fixture({ recurring: true });
  await draft(f);
  f.select('repeat', 'daily');
  let lost = true;
  f.after = (route, options) => {
    if (options.method === 'POST' && lost) {
      lost = false;
      throw Error('lost');
    }
  };
  await f.submit();
  f.state.capabilities.recurringSchedules = false;
  f.render();
  f.select('repeat', 'once');
  await f.submit();
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(f.backend.length, 1);
  assert.match(f.node('.error').textContent, /Update/);
});

test('recurrence drafts preserve live rule and priority controls across state updates and invalid times do not dispatch', async () => {
  const f = fixture({ recurring: true, items: [item('other')] });
  await draft(f, 'Retain recurring draft');
  f.select('repeat', 'weekly');
  f.input('time', '16:25');
  f.select('weekday', '4');
  f.select('priority', 'high');
  f.state.schedules.push(item('streamed'));
  f.render();
  assert.equal(f.node('[name="repeat"]').value, 'weekly');
  assert.equal(f.node('[name="time"]').value, '16:25');
  assert.equal(f.node('[name="weekday"]').value, '4');
  assert.equal(f.node('[name="priority"]').value, 'high');
  await f.click('[data-schedules-refresh]');
  assert.equal(f.node('[name="time"]').value, '16:25');
  f.input('time', '25:99');
  await f.submit();
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  assert.match(f.node('.error').textContent, /valid time/);
  assert.equal(f.node('[name="text"]').value, 'Retain recurring draft');
});

test('a fresh service capability rejection keeps the repeating draft and gives single-language update guidance', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ recurring: true, language });
    await draft(f, 'Keep my recurring instructions');
    f.select('repeat', 'weekly');
    f.input('time', '15:20');
    f.select('weekday', '3');
    f.select('priority', 'high');
    f.wait = () => {
      throw Object.assign(Error('private transport details'), { code: 'service_update_required' });
    };
    await f.submit();
    assert.equal(f.backend.length, 0);
    assert.equal(f.node('[name="text"]').value, 'Keep my recurring instructions');
    assert.equal(f.node('[name="repeat"]').value, 'weekly');
    assert.equal(f.node('[name="time"]').value, '15:20');
    assert.equal(f.node('[name="priority"]').value, 'high');
    assert.match(
      f.node('.error').textContent,
      language === 'en' ? /Update the work computer/ : /更新工作电脑服务/,
    );
    assert.doesNotMatch(f.document.toString(), /private transport details/);
  }
});
