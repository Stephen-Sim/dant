import { defined } from '../../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { observedRecord, observedRecords } from '../../support/service-fixtures.mts';

const script = fs.readFileSync('vm/install-worker.sh', 'utf8').replaceAll('\r\n', '\n');
const check = fs.readFileSync('vm/worker-update-guard.py', 'utf8');
const idle = () => ({
  active: null,
  call: null,
  queue: [],
  takeover: false,
  computer: { status: 'dant', sessionId: null },
  worker: { status: 'online' },
  messages: [],
  workTasks: [],
});
interface Reply {
  route: string;
  value: unknown;
  method?: string;
  body?: unknown;
  error?: boolean;
}
const step = (
  route: string,
  value: unknown,
  options: { method?: string; body?: unknown; error?: boolean } = {},
): Reply => ({ route, value, ...options });
const session = () => step('/api/session', { token: 'fixture-session' });
const state = (value: unknown) => step('/api/state', value);
const pause = () => step('/api/tasks/pause', { ok: true }, { method: 'POST', body: {} });
const witness = () =>
  step('/api/connect', { ok: true }, { method: 'POST', body: { idleRecovery: true } });
const GUARD_FIXTURE_CASE_TIMEOUT_MS = 10_000;
const MAX_GUARD_FIXTURE_CASES = 32;
const harness = String.raw`
import contextlib, io, json, os, sys, threading, time, urllib.request
sys.path.insert(0,os.path.abspath('vm'))
fixtures=json.loads(sys.argv[1]); source=compile(sys.argv[2],'vm/worker-update-guard.py','exec')
case_timeout=int(sys.argv[3])/1000
results=[]
def expired():
    os.write(2,b'GUARD_FIXTURE_CASE_TIMEOUT\n')
    os._exit(124)
for fixture in fixtures:
    sys.argv=['-',fixture.get('mode','pause')]
    calls=[]; replies=list(fixture['replies'])
    def urlopen(request, timeout):
        if fixture.get('stallOnRequest'):
            threading.Event().wait()
        route=(request if isinstance(request,str) else request.full_url).removeprefix('http://127.0.0.1:4317')
        body=None if isinstance(request,str) or request.data is None else json.loads(request.data)
        method='GET' if body is None else 'POST'
        calls.append({'route':route,'method':method,'body':body})
        if not replies: raise RuntimeError('Unexpected network request')
        reply=replies.pop(0)
        if (route,method,body)!=(reply['route'],reply.get('method','GET'),reply.get('body')): raise RuntimeError('Unexpected request ownership')
        if reply.get('error'): raise TimeoutError('PRIVATE RESPONSE MUST NOT BE EXPOSED')
        return io.BytesIO(json.dumps(reply['value']).encode())
    urllib.request.urlopen=urlopen
    stdout,stderr=io.StringIO(),io.StringIO()
    status=0
    deadline=threading.Timer(case_timeout,expired)
    deadline.daemon=True
    started=time.monotonic()
    deadline.start()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                exec(source,{})
            except SystemExit as error:
                status=error.code
        if time.monotonic()-started > case_timeout:
            expired()
    finally:
        deadline.cancel()
        deadline.join()
    results.append({'status':status,'stdout':stdout.getvalue(),'stderr':stderr.getvalue(),
                    'report':{'calls':calls,'remaining':len(replies)}})
print(json.dumps(results))
`;
interface GuardFixture {
  replies: Reply[];
  mode?: string;
  stallOnRequest?: boolean;
}

// Keep the same isolated HTTP replies and per-case exit codes, but amortize
// Python startup for tables so parallel coverage cannot starve dozens of hosts.
function runMany(fixtures: GuardFixture[]) {
  assert.ok(fixtures.length > 0 && fixtures.length <= MAX_GUARD_FIXTURE_CASES);
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['-c', harness, JSON.stringify(fixtures), check, String(GUARD_FIXTURE_CASE_TIMEOUT_MS)],
    {
      encoding: 'utf8',
      shell: false,
      timeout: GUARD_FIXTURE_CASE_TIMEOUT_MS * fixtures.length,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const reports = observedRecords(JSON.parse(result.stdout));
  assert.equal(reports.length, fixtures.length);
  return reports.map((parsed) => {
    assert.ok(typeof parsed.status === 'number');
    assert.ok(typeof parsed.stderr === 'string');
    assert.ok(typeof parsed.stdout === 'string');
    const report = observedRecord(parsed.report);
    return {
      status: parsed.status,
      stderr: parsed.stderr,
      stdout: parsed.stdout,
      report: { remaining: report.remaining, calls: observedRecords(report.calls) },
    };
  });
}

function run(replies: Reply[], { mode = 'pause' } = {}) {
  return defined(runMany([{ mode, replies }])[0]);
}

test('batched guard fixtures retain an individual deadline and cannot advance past a stalled request', () => {
  const fixtures: GuardFixture[] = [
    { replies: [session()], stallOnRequest: true },
    { replies: [session(), state(idle())], mode: 'check' },
  ];
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['-c', harness, JSON.stringify(fixtures), check, '100'],
    { encoding: 'utf8', shell: false, timeout: GUARD_FIXTURE_CASE_TIMEOUT_MS },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 124);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'GUARD_FIXTURE_CASE_TIMEOUT');
});

test('manual update pauses beta2 work twice and preserves its authoritative legacy idle witness', () => {
  const busy = {
    ...idle(),
    active: { workId: 'one', turnId: 'turn' },
    queue: ['queued'],
    workTasks: [{ id: 'one', status: 'running' }],
  };
  const ended = { ...idle(), workTasks: [{ id: 'one', status: 'continuing' }] };
  const paused = { ...idle(), workTasks: [{ id: 'one', status: 'paused' }] };
  const result = run([
    session(),
    state(busy),
    pause(),
    state(ended),
    pause(),
    state(paused),
    witness(),
    state(paused),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.remaining, 0);
  assert.deepEqual(
    result.report.calls.map((call) => call.route),
    [
      '/api/session',
      '/api/state',
      '/api/tasks/pause',
      '/api/state',
      '/api/tasks/pause',
      '/api/state',
      '/api/connect',
      '/api/state',
    ],
  );
});

test('manual update pauses legacy continuing history through its owner-checked task endpoint', () => {
  const old = {
    ...idle(),
    workTasks: [
      { id: 'old/task', turnId: 'ended-turn', status: 'continuing', plan: { steps: [] } },
    ],
  };
  const paused = { ...idle(), workTasks: [{ ...old.workTasks[0], status: 'paused' }] };
  const result = run([
    session(),
    state(old),
    pause(),
    state(old),
    pause(),
    state(old),
    step(
      '/api/tasks/old%2Ftask/pause',
      { ok: true, paused: true },
      { method: 'POST', body: { kind: 'work', turnId: 'ended-turn' } },
    ),
    witness(),
    state(paused),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.remaining, 0);
  assert.equal(
    result.report.calls.filter((call) => call.route === '/api/tasks/old%2Ftask/pause').length,
    1,
  );
});

test('an unconfirmed legacy per-task pause stops installation without replaying it', () => {
  const old = { ...idle(), workTasks: [{ id: 'old', turnId: 'ended-turn', status: 'continuing' }] };
  const result = run([
    session(),
    state(old),
    pause(),
    state(old),
    pause(),
    state(old),
    step('/api/tasks/old/pause', null, {
      method: 'POST',
      body: { kind: 'work', turnId: 'ended-turn' },
      error: true,
    }),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DANT_UPDATE_FAILED:saved-pause-unconfirmed:saved-pause/);
  assert.equal(
    result.report.calls.filter((call) => call.route === '/api/tasks/old/pause').length,
    1,
  );
  assert.equal(result.report.calls.filter((call) => call.route === '/api/connect').length, 0);
});

test('explicit installation recovers a stopped idle executor only after two confirmed pauses', () => {
  const offline = {
    ...idle(),
    worker: { status: 'offline' },
    workTasks: [{ id: 'saved', status: 'paused' }],
  };
  const online = { ...offline, worker: { status: 'online' } };
  const result = run([
    session(),
    state(offline),
    pause(),
    state(offline),
    pause(),
    state(offline),
    witness(),
    state(online),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.remaining, 0);
  assert.deepEqual(
    result.report.calls.filter((call) => call.method === 'POST').map((call) => call.route),
    ['/api/tasks/pause', '/api/tasks/pause', '/api/connect'],
  );
});

test('explicit stopped-executor installation preserves accepted speech from an ended call', () => {
  const offline = {
    ...idle(),
    worker: { status: 'offline' },
    messages: [
      { role: 'user', status: 'accepted', workKind: 'conversation', voiceCallId: 'ended-call' },
    ],
  };
  const result = run([
    session(),
    state(offline),
    pause(),
    state(offline),
    pause(),
    state(offline),
    witness(),
    state({ ...offline, worker: { status: 'online' } }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.remaining, 0);
});

test('an offline executor with queued, active, unknown or uncontrolled work is never recovered for installation', () => {
  const offline = { ...idle(), worker: { status: 'offline' } };
  const cases = [
    { ...offline, messages: undefined },
    { ...offline, workTasks: undefined },
    { ...offline, active: { turnId: 'active' } },
    { ...offline, call: { id: 'call' } },
    { ...offline, queue: ['queued'] },
    { ...offline, workTasks: [{ status: 'continuing' }] },
    { ...offline, messages: [{ role: 'user', status: 'queued' }] },
    { ...offline, messages: [{ role: 'user', status: 'paused', submission: 'unknown' }] },
    { ...offline, workTasks: [{ status: 'unknown' }] },
    {
      ...offline,
      workTasks: [{ status: 'paused', continuation: { dispatch: { phase: 'acknowledged' } } }],
    },
    { ...offline, computer: { status: 'human', sessionId: 'lease' } },
    { ...offline, computer: { status: 'dant', pending: true } },
    { ...offline, acquiring: true },
  ];
  const results = runMany(cases.map((current) => ({ replies: [session(), state(current)] })));
  for (const [index, current] of cases.entries()) {
    const result = defined(results[index]);
    assert.equal(result.status, 1, JSON.stringify(current));
    assert.ok(result.report.calls.every((call) => call.method === 'GET'));
    assert.equal(result.report.remaining, 0);
  }
});

test('fresh stopped-executor activity after either pause blocks recovery and installation', () => {
  const offline = { ...idle(), worker: { status: 'offline' } };
  const cases = [
    { ...offline, active: { turnId: 'new' } },
    { ...offline, queue: ['new'] },
    { ...offline, messages: [{ role: 'user', status: 'queued' }] },
    { ...offline, workTasks: [{ status: 'continuing' }] },
    { ...offline, messages: [{ role: 'user', status: 'unknown', submission: 'unknown' }] },
  ].flatMap((current) => [true, false].map((afterFirst) => ({ current, afterFirst })));
  const results = runMany(
    cases.map(({ current, afterFirst }) => ({
      replies: [
        session(),
        state(offline),
        pause(),
        ...(afterFirst ? [state(current)] : [state(offline), pause(), state(current)]),
      ],
    })),
  );
  for (const [index, { current, afterFirst }] of cases.entries()) {
    const result = defined(results[index]);
    assert.equal(result.status, 1, JSON.stringify({ current, afterFirst }));
    assert.ok(result.report.calls.every((call) => call.route !== '/api/connect'));
    assert.equal(result.report.remaining, 0);
  }
});

test('explicit stopped-executor recovery must confirm online and never resends an unconfirmed witness', () => {
  const offline = { ...idle(), worker: { status: 'offline' } };
  for (const result of [
    run([
      session(),
      state(offline),
      pause(),
      state(offline),
      pause(),
      state(offline),
      witness(),
      state(offline),
    ]),
    run([
      session(),
      state(offline),
      pause(),
      state(offline),
      pause(),
      state(offline),
      { ...witness(), error: true },
    ]),
  ]) {
    assert.equal(result.status, 1);
    assert.equal(result.report.calls.filter((call) => call.route === '/api/connect').length, 1);
    assert.equal(result.report.remaining, 0);
    assert.doesNotMatch(result.stderr, /PRIVATE RESPONSE/);
  }
});

test('automatic deployment leaves busy work running without issuing mutations', () => {
  const result = run([session(), state({ ...idle(), active: { turnId: 'current' } })], {
    mode: 'check',
  });
  assert.equal(result.status, 79);
  assert.match(result.stderr, /DANT_WORK_ACTIVE/);
  assert.ok(result.report.calls.every((call) => call.method === 'GET'));
});

test('automatic deployment defers during human control and keeps the existing service available', () => {
  for (const computer of [
    { status: 'human', sessionId: 'control' },
    { status: 'taking-over', sessionId: null },
    { status: 'dant', pending: true },
    { status: 'dant', sessionId: 'pending-control' },
  ]) {
    const result = run([session(), state({ ...idle(), computer })], { mode: 'check' });
    assert.equal(result.status, 79, JSON.stringify(computer) + ' ' + result.stderr);
    assert.match(result.stderr, /DANT_WORK_ACTIVE/);
    assert.ok(result.report.calls.every((call) => call.method === 'GET'));
  }
});

test('a known current call is closed normally and then saved work is paused again', () => {
  const busy = { ...idle(), active: { turnId: 'work' }, call: { id: 'call-one' } };
  const result = run([
    session(),
    state(busy),
    pause(),
    state({ ...idle(), call: { id: 'call-one' } }),
    step('/api/call/stop', { stopped: true }, { method: 'POST', body: { callId: 'call-one' } }),
    pause(),
    state(idle()),
    witness(),
    state(idle()),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.remaining, 0);
});

test('manual update refuses changed call ownership without stopping the replacement call', () => {
  for (const initial of [null, { id: 'first' }]) {
    const result = run([
      session(),
      state({ ...idle(), call: initial }),
      pause(),
      state({ ...idle(), call: { id: 'replacement' } }),
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.report.calls.filter((call) => call.method === 'POST').length, 1);
    assert.ok(result.report.calls.every((call) => call.route !== '/api/call/stop'));
  }
});

test('a pause timeout is an unknown result and is never resent', () => {
  const result = run([
    session(),
    state({ ...idle(), active: { turnId: 'work' } }),
    { ...pause(), error: true },
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.report.calls.filter((call) => call.route === '/api/tasks/pause').length, 1);
  assert.match(result.stderr, /no unconfirmed action was resent/);
  assert.doesNotMatch(result.stderr, /PRIVATE RESPONSE/);
});

test('malformed state, human control and unconfirmed work fail before any mutation', () => {
  const cases: unknown[] = [
    {},
    { ...idle(), queue: {} },
    { ...idle(), takeover: true },
    { ...idle(), active: 'bad' },
    { ...idle(), call: { id: '' } },
    { ...idle(), worker: { status: 'connecting' } },
    { ...idle(), computer: { status: 'dant', pending: true } },
    { ...idle(), computer: { status: 'dant', sessionId: 'lease' } },
    { ...idle(), messages: [{ role: 'user', status: 'paused', submission: 'unknown' }] },
    { ...idle(), workTasks: [{ status: 'unknown' }] },
    { ...idle(), workTasks: [{ continuation: { dispatch: { phase: 'submitting' } } }] },
    { ...idle(), workTasks: [{ continuation: { invalid: true } }] },
  ];
  const results = runMany(cases.map((snapshot) => ({ replies: [session(), state(snapshot)] })));
  for (const [index, snapshot] of cases.entries()) {
    const result = defined(results[index]);
    assert.equal(result.status, 1, JSON.stringify(snapshot));
    assert.ok(result.report.calls.every((call) => call.method === 'GET'));
  }
});

test('new activity or unresolved continuation after pause blocks replacement', () => {
  const cases = [
    { ...idle(), active: { turnId: 'new' } },
    { ...idle(), queue: ['new'] },
    { ...idle(), call: { id: 'new' } },
    { ...idle(), takeover: true },
    { ...idle(), workTasks: [{ status: 'continuing' }] },
    {
      ...idle(),
      workTasks: [{ status: 'paused', continuation: { dispatch: { phase: 'acknowledged' } } }],
    },
  ];
  const results = runMany(
    cases.map((current) => ({
      replies: [
        session(),
        state(idle()),
        pause(),
        state(idle()),
        pause(),
        state(idle()),
        witness(),
        state(current),
      ],
    })),
  );
  for (const [index, current] of cases.entries()) {
    const result = defined(results[index]);
    assert.equal(result.status, 1, JSON.stringify(current));
    assert.equal(result.report.remaining, 0);
  }
});

test('final state rejection aborts after confirmed pauses and the existing legacy witness', () => {
  const result = run([
    session(),
    state(idle()),
    pause(),
    state(idle()),
    pause(),
    state(idle()),
    witness(),
    { ...state(idle()), error: true },
  ]);
  assert.equal(result.status, 1);
  assert.equal(defined(result.report.calls.at(-1)).route, '/api/state');
  assert.equal(result.report.calls.filter((call) => call.route === '/api/connect').length, 1);
  assert.match(result.stderr, /^DANT_UPDATE_FAILED:state-unavailable:final$/m);
  assert.match(result.stderr, /Saved task records were preserved/);
});

test('rollback idle validation preserves its legacy witness without task pause or call stop on newly started work', () => {
  for (const current of [
    { ...idle(), active: { turnId: 'new' } },
    { ...idle(), call: { id: 'new-call' } },
    { ...idle(), queue: ['new'] },
  ]) {
    const result = run([session(), state(idle()), witness(), state(current)], { mode: 'idle' });
    assert.equal(result.status, 79);
    assert.ok(
      result.report.calls.every((call) => call.method === 'GET' || call.route === '/api/connect'),
    );
    assert.match(result.stderr, /^DANT_UPDATE_DEFERRED:work-still-active:rollback$/m);
  }
});

test('rollback validates the current online idle executor without starting an offline executor', () => {
  const ready = run([session(), state(idle()), witness(), state(idle())], { mode: 'idle' });
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.report.remaining, 0);
  const offline = run([session(), state({ ...idle(), worker: { status: 'offline' } })], {
    mode: 'idle',
  });
  assert.equal(offline.status, 79);
  assert.ok(offline.report.calls.every((call) => call.method === 'GET'));
  assert.match(offline.stderr, /^DANT_UPDATE_DEFERRED:executor-offline:rollback$/m);
});

test('idle automatic check accepts paused or completed work without changing saved records', () => {
  const result = run(
    [
      session(),
      state({
        ...idle(),
        workTasks: [
          { id: 'saved', status: 'paused' },
          { id: 'complete', status: 'completed' },
        ],
      }),
    ],
    { mode: 'check' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.calls.length, 2);
});

test('passive checks defer saved runnable work between turns and only accept an explicitly ended user wait', () => {
  const cases = ['check', 'final'].flatMap((mode) =>
    ['running', 'queued', 'accepted', 'continuing', 'pausing', 'unknown']
      .map((status) => ({ status }))
      .concat(
        [
          {},
          { executionEndedAt: 0 },
          { executionEndedAt: -1 },
          { executionEndedAt: true },
          { executionEndedAt: '1' },
        ].map((extra) => ({ status: 'waiting_user', ...extra })),
      )
      .map((record) => ({ mode, record })),
  );
  const results = runMany(
    cases.map(({ mode, record }) => ({
      mode,
      replies: [session(), state({ ...idle(), workTasks: [record] })],
    })),
  );
  for (const [index, { mode, record }] of cases.entries()) {
    const result = defined(results[index]);
    assert.equal(result.status, 79, JSON.stringify({ mode, record }));
    assert.match(
      result.stderr,
      new RegExp(
        '^DANT_UPDATE_DEFERRED:work-still-active:' +
          (mode === 'idle' ? 'rollback' : mode === 'final' ? 'final' : 'initial') +
          '$',
        'm',
      ),
    );
    assert.ok(result.report.calls.every((call) => call.method === 'GET'));
  }
  for (const mode of ['check', 'final']) {
    const ended = run(
      [
        session(),
        state({ ...idle(), workTasks: [{ status: 'waiting_user', executionEndedAt: 1 }] }),
      ],
      { mode },
    );
    assert.equal(ended.status, 0, ended.stderr);
  }
});

test('passive checks defer every unconfirmed executor status using GET only, including a post-pause offline race', () => {
  const cases = ['check', 'final', 'idle'].flatMap((mode) =>
    [
      undefined,
      null,
      {},
      { status: 'offline' },
      { status: 'connecting' },
      { status: 'unknown' },
    ].map((worker) => ({ mode, worker })),
  );
  const results = runMany(
    cases.map(({ mode, worker }) => ({
      mode,
      replies: [session(), state({ ...idle(), worker })],
    })),
  );
  for (const [index, { mode }] of cases.entries()) {
    const result = defined(results[index]);
    assert.equal(result.status, 79);
    assert.match(result.stderr, /^DANT_WORK_ACTIVE$/m);
    assert.match(
      result.stderr,
      new RegExp(
        '^DANT_UPDATE_DEFERRED:executor-offline:' +
          (mode === 'idle' ? 'rollback' : mode === 'final' ? 'final' : 'initial') +
          '$',
        'm',
      ),
    );
    assert.ok(result.report.calls.every((call) => call.method === 'GET'));
  }
  const race = run([
    session(),
    state(idle()),
    pause(),
    state(idle()),
    pause(),
    state(idle()),
    witness(),
    state({ ...idle(), worker: { status: 'offline' } }),
  ]);
  assert.equal(race.status, 1);
  assert.match(race.stderr, /^DANT_UPDATE_FAILED:executor-offline:final$/m);
  assert.equal(race.report.calls.filter((call) => call.method === 'POST').length, 3);
});

test('fixed guard reasons identify the failed stage without exposing private responses or replaying requests', () => {
  const cases: [Reply[], string, string][] = [
    [[{ ...session(), error: true }], 'session-unavailable', 'initial'],
    [[step('/api/session', {})], 'session-invalid', 'initial'],
    [[session(), state({})], 'state-invalid', 'initial'],
    [[session(), state({ ...idle(), computer: { status: 'human' } })], 'control-busy', 'initial'],
    [
      [session(), state({ ...idle(), messages: [{ status: 'paused', submission: 'unknown' }] })],
      'work-unconfirmed',
      'initial',
    ],
    [[session(), state({ ...idle(), call: { id: '' } })], 'call-owner-invalid', 'initial'],
    [[session(), state(idle()), { ...pause(), error: true }], 'pause-unconfirmed', 'pause'],
    [
      [session(), state(idle()), pause(), { ...state(idle()), error: true }],
      'state-unavailable',
      'post-pause',
    ],
    [
      [
        session(),
        state({ ...idle(), call: { id: 'old' } }),
        pause(),
        state({ ...idle(), call: { id: 'other' } }),
      ],
      'call-owner-changed',
      'post-pause',
    ],
    [
      [
        session(),
        state({ ...idle(), call: { id: 'old' } }),
        pause(),
        state({ ...idle(), call: { id: 'old' } }),
        step('/api/call/stop', { stopped: false }, { method: 'POST', body: { callId: 'old' } }),
      ],
      'call-stop-unconfirmed',
      'call-stop',
    ],
    [
      [session(), state(idle()), pause(), state(idle()), { ...pause(), error: true }],
      'saved-pause-unconfirmed',
      'saved-pause',
    ],
    [
      [
        session(),
        state(idle()),
        pause(),
        state(idle()),
        pause(),
        state(idle()),
        { ...witness(), error: true },
      ],
      'idle-unconfirmed',
      'final',
    ],
    [
      [
        session(),
        state(idle()),
        pause(),
        state(idle()),
        pause(),
        state(idle()),
        witness(),
        state({ ...idle(), active: { turnId: 'new' } }),
      ],
      'work-still-active',
      'final',
    ],
  ];
  const results = runMany(cases.map(([replies]) => ({ replies })));
  for (const [index, [, reason, stage]] of cases.entries()) {
    const result = defined(results[index]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp('^DANT_UPDATE_FAILED:' + reason + ':' + stage + '$', 'm'),
    );
    assert.doesNotMatch(result.stderr, /PRIVATE|fixture-session|Traceback|TimeoutError/);
    assert.equal(result.report.remaining, 0);
    assert.ok(result.report.calls.filter((call) => call.route === '/api/connect').length <= 1);
  }
});

const bash =
  process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
    : 'bash';
// Real Git Bash file operations need headroom under parallel Windows coverage runs.
const DEPLOYMENT_FIXTURE_TIMEOUT_MS = 60_000;
const shellPath = (value: string) =>
  process.platform === 'win32'
    ? value
        .replaceAll('\\', '/')
        .replace(/^([A-Za-z]):/, (_: string, drive: string) => '/' + drive.toLowerCase())
    : value;

function currentDeployment(
  t: NodeTestContext,
  { manual = false, workerActive = true, guestActive = true, reconcileRequested = false } = {},
) {
  const testRoot = path.resolve('.cache/tests');
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'worker-current-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'),
    stage = path.join(home, 'dant/releases/source.fixture');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'deploy-manifest.json'), 'same-source');
  fs.writeFileSync(path.join(home, 'dant/deployed-source.json'), 'same-source');
  const current = script.slice(
    script.indexOf('if ! "$reconcile_requested" && [ -f "$HOME/dant/deployed-source.json" ]'),
    script.indexOf('if [ -e "$HOME/dant/app" ]'),
  );
  const harness = String.raw`
set -euo pipefail
export HOME="$1"
source_dir="$2"
update_running_work="$3"
worker_active="$4"
guest_active="$5"
reconcile_requested="$6"
cd "$source_dir"
prepare_transcription() { printf 'transcription\n' >> "$HOME/events"; }
python3() { printf 'go-readiness:%s\n' "$*" >> "$HOME/events"; }
systemctl() {
  printf 'systemctl:%s\n' "$*" >> "$HOME/events"
  if [[ "$*" == '--user is-active --quiet dant-worker.service' ]]; then [[ "$worker_active" == true ]];
  elif [[ "$*" == '--user is-active --quiet dant-guest-local.service' ]]; then [[ "$guest_active" == true ]];
  else return 2; fi
}
check_idle_worker() { printf 'pause-check\n' >> "$HOME/events"; exit 9; }
`;
  const runFile = path.join(root, 'current-fixture.sh');
  fs.writeFileSync(runFile, harness + '\n' + current + '\nprintf "DANT_INSTALL_CONTINUES\\n"\n');
  const result = spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      shellPath(runFile),
      shellPath(home),
      shellPath(stage),
      String(manual),
      String(workerActive),
      String(guestActive),
      String(reconcileRequested),
    ],
    { encoding: 'utf8', shell: false, timeout: 10000 },
  );
  if (result.error) throw result.error;
  return {
    ...result,
    events: fs.existsSync(path.join(home, 'events'))
      ? fs.readFileSync(path.join(home, 'events'), 'utf8')
      : '',
  };
}

test('the same deployed manifest returns current without pausing work or restarting services, including manual reconnect', (t) => {
  for (const manual of [false, true]) {
    const result = currentDeployment(t, { manual });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^DANT_UPDATE_CURRENT$/m);
    assert.doesNotMatch(result.stdout, /DANT_INSTALL_CONTINUES/);
    assert.match(result.events, /is-active --quiet dant-worker.service/);
    assert.match(result.events, /is-active --quiet dant-guest-local.service/);
    assert.doesNotMatch(result.events, /pause-check|restart|stop/);
  }
});

test('a current manifest with only one running service still proceeds through installation', (t) => {
  for (const manual of [false, true])
    for (const workerActive of [false, true]) {
      const result = currentDeployment(t, { manual, workerActive, guestActive: !workerActive });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /DANT_UPDATE_CURRENT/);
      assert.match(result.stdout, /^DANT_INSTALL_CONTINUES$/m);
      assert.doesNotMatch(result.events, /transcription|node:|pause-check|restart|stop/);
    }
});

test('explicit stopped-attempt reconciliation never mistakes the target manifest for a completed cutover', (t) => {
  const result = currentDeployment(t, { reconcileRequested: true });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /DANT_UPDATE_CURRENT/);
  assert.match(result.stdout, /^DANT_INSTALL_CONTINUES$/m);
  assert.equal(result.events, '');
});

// The Go cutover replaces the former Node rollback transaction. Its isolated
// fixtures exercise stop/export/prepare/start failures and prohibit restarting
// legacy Node against data that Go preparation may already have migrated.
test('Go cutover validates provenance, proves shutdown and preserves failed migration outcomes', () => {
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['-m', 'unittest', 'discover', '-s', 'tests/vm', '-p', 'test_worker_install.py', '-v'],
    { encoding: 'utf8', shell: false, timeout: DEPLOYMENT_FIXTURE_TIMEOUT_MS },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /test_cutover_orders_stop_backup_prepare_go_start_and_commit/);
  assert.match(
    result.stderr,
    /test_failed_stop_backup_prepare_or_start_never_restarts_node_or_replays/,
  );
  assert.match(result.stderr, /test_cgroup_and_inherited_codex_owner_must_be_empty/);
});
