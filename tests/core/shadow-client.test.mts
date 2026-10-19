import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { ShadowClient } from '../../scripts/core/shadow-client.mts';

function fixture(t: TestContext, body: string) {
  const source = `import readline from 'node:readline';
    const input = readline.createInterface({input:process.stdin});
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    input.on('line',line=>{const request=JSON.parse(line);${body}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    shell: false,
  });
  const client = new ShadowClient(child);
  t.after(() => client.close());
  return client;
}

test('shadow client associates interleaved responses with exact request identity', async (t) => {
  const client = fixture(
    t,
    'setTimeout(()=>send({id:request.id,result:request.params}),request.params.wait);',
  );
  const [slow, fast] = await Promise.all([
    client.request('ping', { wait: 40, marker: 'first' }),
    client.request('ping', { wait: 1, marker: 'second' }),
  ]);
  assert.deepEqual(slow, { wait: 40, marker: 'first' });
  assert.deepEqual(fast, { wait: 1, marker: 'second' });
});

test('cancelled reads ignore one late response and keep the next request independent', async (t) => {
  const client = fixture(
    t,
    'if(!request.cancel)setTimeout(()=>send({id:request.id,result:request.params.marker}),request.params.wait);',
  );
  const controller = new AbortController();
  const pending = client.request(
    'search',
    { wait: 30, marker: 'discard' },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, /core_cancelled/);
  const next = await client.request('ping', { wait: 80, marker: 'next' });
  assert.equal(next, 'next');
});

test('unknown response identity fails all pending reads without replay', async (t) => {
  const client = fixture(t, 'send({id:"another-request",result:true});');
  const pending = [client.request('ping'), client.request('search')];
  for (const request of pending) await assert.rejects(request, /core_response_identity/);
  await assert.rejects(client.request('ping'), /core_response_identity/);
});

test('null success is preserved while ambiguous and oversized envelopes fail closed', async (t) => {
  const valid = fixture(t, 'send({id:request.id,result:null});');
  assert.equal(await valid.request('ping'), null);
  const ambiguous = fixture(t, 'send({id:request.id,result:null,error:{code:"invalid_request"}});');
  await assert.rejects(ambiguous.request('ping'), /core_invalid_response/);
  const oversized = fixture(t, 'process.stdout.write("x".repeat(262145));');
  await assert.rejects(oversized.request('ping'), /core_frame_too_large/);
});

test('client validates explicit deadlines and bounds pending work', async (t) => {
  const client = fixture(
    t,
    'if(request.cancel)send({id:request.cancel,error:{code:"cancelled"}});',
  );
  for (const deadlineMs of [0, -1, 0.5, 10001, Infinity])
    await assert.rejects(client.request('ping', {}, { deadlineMs }), /core_invalid_deadline/);
  await assert.rejects(
    client.request('search', { value: 'x'.repeat(262145) }),
    /core_frame_too_large/,
  );
  const controllers = Array.from({ length: 20 }, () => new AbortController());
  const pending = controllers.map((controller) =>
    client.request('ping', {}, { signal: controller.signal }).catch((error: unknown) => error),
  );
  await assert.rejects(client.request('ping'), /core_busy/);
  controllers.forEach((controller) => controller.abort());
  const results = await Promise.all(pending);
  assert(results.every((value) => value instanceof Error && value.message === 'core_cancelled'));
});

test('close rejects new and pending reads immediately and is idempotent', async (t) => {
  const client = fixture(t, 'if(request.method==="ping")send({id:request.id,result:true});');
  assert.equal(await client.request('ping'), true);
  const pending = client.request('search').catch((error: unknown) => error);
  const close = client.close();
  assert.equal(client.close(), close);
  await assert.rejects(client.request('ping'), /core_closed/);
  const rejected = await pending;
  assert(rejected instanceof Error && rejected.message === 'core_closed');
  await close;
});

test('close bounds a helper that ignores EOF and graceful signals', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    process.on('SIGTERM',()=>{});
    process.stdin.resume();
    process.stdin.on('end',()=>{});
    setInterval(()=>{},1000);
    process.stdout.write(JSON.stringify({id:'ready',result:true})+'\\n');
  `,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
  });
  const client = new ShadowClient(child);
  t.after(() => client.close());
  const started = performance.now();
  await client.close();
  assert(performance.now() - started < 5000);
  assert.notEqual(child.signalCode, null);
});
