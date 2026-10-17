import test from 'node:test';
import assert from 'node:assert/strict';
import {createTransport} from '../ui/transport.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = value => ({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Test condition was not reached');
    await pause(3);
  }
}

test('desktop JSON requests use the native bridge serially and recover after a failed request', async () => {
  const requests = [];
  let active = 0, maximum = 0;
  const transport = createTransport({desktop: true, invokeRequest: async (command, args) => {
    assert.equal(command, 'api_request');
    active++; maximum = Math.max(maximum, active); requests.push(args);
    await pause(5); active--;
    return args.route === '/api/fail'
      ? {status: 409, body: JSON.stringify({error: 'Task changed',code:'name_exists'})}
      : response({ok: true});
  }});
  transport.setToken('test-session');
  const results = await Promise.allSettled([
    transport.json('/api/settings', {method: 'PATCH', body: {language: 'en'}}),
    transport.json('/api/fail'),
    transport.json('/api/state'),
  ]);
  assert.equal(maximum, 1);
  assert.deepEqual(requests.map(item => item.route), ['/api/settings', '/api/fail', '/api/state']);
  assert.equal(requests[0].body, '{"language":"en"}');
  assert.equal(requests[0].token, 'test-session');
  assert.equal(requests[2].body, null);
  assert.equal(results[1].reason.status, 409);
  assert.equal(results[1].reason.code,'name_exists');
  assert.equal(results[2].status, 'fulfilled');
  transport.close();
});

test('a remote skill preview cannot delay native call shutdown or state polling',async()=>{
 let finishPreview;const starts=[];
 const transport=createTransport({desktop:true,invokeRequest:async(_command,args)=>{starts.push(args.route);if(args.route==='/api/skills/import/preview')return new Promise(resolve=>finishPreview=resolve);return response({ok:true});}});
 const preview=transport.json('/api/skills/import/preview',{method:'POST',body:{url:'https://github.com/example/skills'}});
 const stopping=transport.json('/api/call/stop',{method:'POST',body:{callId:'current'}}),reading=transport.json('/api/state');
 try{await until(()=>starts.includes('/api/state'));assert.deepEqual(await stopping,{ok:true});assert.deepEqual(await reading,{ok:true});}
 finally{finishPreview?.(response({id:'preview'}));await preview;transport.close();}
});

test('a slow update check does not delay call shutdown or state polling over native IPC', async () => {
  let finishUpdate;const starts=[];
  const transport=createTransport({desktop:true,invokeRequest:async(_command,args)=>{
    starts.push(args.route);
    if(args.route==='/api/updates')return new Promise(resolve=>{finishUpdate=resolve;});
    return response({ok:true});
  }});
  const checking=transport.json('/api/updates');
  const stopping=transport.json('/api/call/stop',{method:'POST',body:{callId:'current-call'}});
  const reading=transport.json('/api/state');
  try{
    await until(()=>starts.includes('/api/state'));
    assert.deepEqual(await stopping,{ok:true});assert.deepEqual(await reading,{ok:true});
    assert.deepEqual(starts,['/api/updates','/api/call/stop','/api/state']);
  }finally{finishUpdate?.(response({latestVersion:'0.4.5'}));await checking;transport.close();}
});

test('only the two exact read-only app routes bypass pending native mutations', async () => {
  let finishMutation;const starts=[];
  const transport=createTransport({desktop:true,invokeRequest:async(_command,args)=>{
    starts.push(args.route);
    if(args.route==='/api/settings')return new Promise(resolve=>{finishMutation=resolve;});
    return response({ok:true});
  }});
  const saving=transport.json('/api/settings',{method:'PATCH',body:{language:'en'}});
  await until(()=>finishMutation);
  const version=transport.json('/api/version'),checking=transport.json('/api/updates');
  const mutation=transport.json('/api/updates',{method:'POST'}),other=transport.json('/api/updates/other');
  try{
    await until(()=>starts.includes('/api/version')&&starts.includes('/api/updates'));
    assert.deepEqual(await version,{ok:true});assert.deepEqual(await checking,{ok:true});
    assert.deepEqual(starts,['/api/settings','/api/version','/api/updates']);
  }finally{finishMutation(response({ok:true}));await Promise.all([saving,mutation,other]);transport.close();}
  assert.deepEqual(starts,['/api/settings','/api/version','/api/updates','/api/updates','/api/updates/other']);
});

test('desktop state polling waits until the prior request completes and never opens browser streams', async () => {
  let finishFirst, finishSecond, firstCompleted = 0;
  const starts = [], events = [];
  class ForbiddenStream { constructor() { throw new Error('Desktop must not use browser event streams'); } }
  const transport = createTransport({desktop: true, pollDelay: 20, EventSourceImpl: ForbiddenStream, WebSocketImpl: ForbiddenStream,
    invokeRequest: async (_command, args) => {
      assert.equal(args.route, '/api/state'); starts.push(Date.now());
      return new Promise(resolve => {
        if (starts.length === 1) finishFirst = () => { firstCompleted = Date.now(); resolve(response({number: 1})); };
        else finishSecond = () => resolve(response({number: 2}));
      });
    },
  });
  transport.startEvents({onEvent: event => events.push(event)});
  await until(() => finishFirst);
  await pause(25);
  assert.equal(starts.length, 1, 'an unresolved state request must not overlap another poll');
  finishFirst();
  await until(() => finishSecond);
  assert.ok(starts[1] - firstCompleted >= 18, 'the poll delay begins after completion');
  transport.stopEvents();
  finishSecond();
  await pause(25);
  assert.equal(starts.length, 2);
  assert.deepEqual(events.map(event => event.data.number), [1], 'responses from a stopped poll must be discarded');
});

test('browser state uses SSE first, handles named and envelope events, and falls back to WebSocket', () => {
  const sources = [], sockets = [], events = [];
  class Source {
    constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
    addEventListener(name, listener) { this.handlers[name] = listener; }
    close() { this.closed = true; }
  }
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.closed = true; }
  }
  const transport = createTransport({desktop: false, origin: 'http://127.0.0.1:4318', EventSourceImpl: Source, WebSocketImpl: Socket});
  transport.setToken('test-token');
  transport.startEvents({onEvent: event => events.push(event)});
  assert.equal(sources.length, 1);
  assert.equal(sockets.length, 0);
  assert.equal(sources[0].url, '/api/events?token=test-token');
  sources[0].handlers.state({data: '{"messages":[]}'});
  sources[0].onmessage({data: '{"type":"notice","data":{"message":"ready"}}'});
  assert.deepEqual(events.map(event => event.type), ['state', 'notice']);
  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  assert.equal(sockets[0].url, 'ws://127.0.0.1:4318/events?token=test-token');
  sources[0].onerror();
  sources[0].handlers.state({data: '{"messages":["stale"]}'});
  assert.equal(sockets.length, 1, 'a closed SSE connection must not create duplicate fallback sockets');
  assert.equal(events.length, 2, 'closed SSE events must not overwrite a newer transport');
  sockets[0].onmessage({data: '{"type":"state","data":{"messages":[1]}}'});
  assert.deepEqual(events.at(-1).data.messages, [1]);
  transport.stopEvents();
  sources[0].handlers.state({data: '{"messages":[2]}'});
  assert.equal(events.length, 3, 'events from the previous transport must be ignored');
});

test('JSON transport rejects invalid responses and external or traversing routes', async () => {
  let requests = 0;
  const transport = createTransport({desktop: false, fetchRequest: async () => { requests++; return {status: 200, text: async () => '<html>not JSON</html>'}; }});
  await assert.rejects(transport.json('https://example.test/api/state'), /Invalid local API route/);
  await assert.rejects(transport.json('/api/../state'), /Invalid local API route/);
  assert.equal(requests, 0);
  await assert.rejects(transport.json('/api/state'), /Invalid JSON response/);
  transport.close();
});

test('ambiguous mutations retain their outcome marker across HTTP and native IPC failures', async () => {
  const browser = createTransport({desktop:false,fetchRequest:async()=>({status:502,text:async()=>JSON.stringify({error:'Result unconfirmed',unknownOutcome:true})})});
  await assert.rejects(browser.json('/api/messages',{method:'POST',body:{text:'one attempt'}}),error=>error.status===502&&error.unknownOutcome===true);
  const native = createTransport({desktop:true,invokeRequest:async()=>{throw 'The request outcome is unconfirmed. It has not been resent.';}});
  await assert.rejects(native.json('/api/messages',{method:'POST',body:{text:'one attempt'}}),error=>error instanceof Error&&error.unknownOutcome===true&&/unconfirmed/.test(error.message));
  await assert.rejects(native.json('/api/state'),error=>error instanceof Error&&!error.unknownOutcome,'a failed read does not create a mutation warning');
  browser.close();native.close();
});
