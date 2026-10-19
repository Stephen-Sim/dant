import { observedArray } from '../support/service-fixtures.mts';
import { observedRecord } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareObserverEvent,
  getObserverProjectionKind,
  observerEventMetadata,
} from '../../src/runtime/observer-event.mts';

test('observer copies remove only MCP image data and retain text, ownership and structured delivery fields', () => {
  const text = Object.freeze({ type: 'text', text: 'A validated delivery marker' }),
    structured = Object.freeze({
      dantMessage: { text: 'Keep the requested text' },
      voiceFile: { path: '/workspace/output/result.wav' },
    }),
    image = Object.freeze({
      type: 'image',
      mimeType: 'image/png',
      data: 'original-model-base64',
      annotations: { audience: ['assistant'] },
    }),
    result = Object.freeze({
      content: Object.freeze([text, image]),
      structuredContent: structured,
      isError: false,
    }),
    item = Object.freeze({
      id: 'item',
      type: 'mcpToolCall',
      server: 'dant_desktop',
      tool: 'send_chat_message',
      status: 'completed',
      arguments: { text: 'Keep the requested text' },
      result,
    }),
    event = Object.freeze({
      method: 'item/completed',
      params: Object.freeze({ threadId: 'thread', turnId: 'turn', callId: 'call', item }),
    });
  const before = JSON.stringify(event),
    observed = prepareObserverEvent(event);
  assert.notEqual(observed, event);
  assert.notEqual(observedRecord(observed).params, event.params);
  assert.notEqual(observedRecord(observedRecord(observed).params).item, item);
  assert.notEqual(
    observedRecord(defined(observedRecord(observedRecord(observed).params).item)).result,
    result,
  );
  assert.equal(
    observedArray(
      defined(
        observedRecord(
          defined(
            observedRecord(defined(observedRecord(observedRecord(observed).params).item)).result,
          ),
        ).content,
      ),
    )[0],
    text,
  );
  assert.equal(
    observedRecord(
      defined(observedRecord(defined(observedRecord(observedRecord(observed).params).item)).result),
    ).structuredContent,
    structured,
  );
  assert.equal(
    observedRecord(defined(observedRecord(observedRecord(observed).params).item)).arguments,
    item.arguments,
  );
  assert.equal(
    observedRecord(defined(observedRecord(observedRecord(observed).params).item)).status,
    'completed',
  );
  assert.equal(
    observedRecord(
      defined(observedRecord(defined(observedRecord(observedRecord(observed).params).item)).result),
    ).isError,
    false,
  );
  assert.equal(
    Object.hasOwn(
      observedRecord(
        observedArray(
          defined(
            observedRecord(
              defined(
                observedRecord(defined(observedRecord(observedRecord(observed).params).item))
                  .result,
              ),
            ).content,
          ),
        )[1],
      ),
      'data',
    ),
    false,
  );
  assert.equal(
    observedRecord(
      defined(
        observedArray(
          defined(
            observedRecord(
              defined(
                observedRecord(defined(observedRecord(observedRecord(observed).params).item))
                  .result,
              ),
            ).content,
          ),
        )[1],
      ),
    ).mimeType,
    'image/png',
  );
  assert.deepEqual(
    observedRecord(
      defined(
        observedArray(
          defined(
            observedRecord(
              defined(
                observedRecord(defined(observedRecord(observedRecord(observed).params).item))
                  .result,
              ),
            ).content,
          ),
        )[1],
      ),
    ).annotations,
    { audience: ['assistant'] },
  );
  assert.equal(observedRecord(observedRecord(observed).params).threadId, 'thread');
  assert.equal(observedRecord(observedRecord(observed).params).turnId, 'turn');
  assert.equal(observedRecord(observedRecord(observed).params).callId, 'call');
  assert.equal(JSON.stringify(event), before);
  assert.equal(observedRecord(event.params.item.result.content[1]).data, 'original-model-base64');
  assert.equal(prepareObserverEvent(observed), observed);
  assert.equal(getObserverProjectionKind(observed), 'image');
  assert.equal(getObserverProjectionKind(event), null);
});

test('small or unrecognized events retain text, arguments, structured payloads and non-MCP images', () => {
  for (const event of [
    {
      method: 'item/tool/call',
      params: { arguments: { data: 'private argument', type: 'image' } },
    },
    {
      params: {
        item: { type: 'agentMessage', result: { content: [{ type: 'image', data: 'keep' }] } },
      },
    },
    {
      params: {
        item: {
          type: 'mcpToolCall',
          arguments: { type: 'image', data: 'keep' },
          result: {
            content: [{ type: 'text', text: 'keep all text', data: 'text field' }],
            structuredContent: { type: 'image', data: 'structured marker must remain' },
          },
        },
      },
    },
  ])
    assert.equal(prepareObserverEvent(event), event);
  assert.equal(prepareObserverEvent(null), null);
  assert.deepEqual(
    observedRecord(
      defined(
        observedRecord(
          defined(
            observedRecord(
              observedRecord(
                prepareObserverEvent({
                  params: {
                    item: {
                      type: 'mcpToolCall',
                      result: {
                        content: [
                          null,
                          { type: 'image', data: 7 },
                          { type: 'image', url: 'https://example.invalid/image' },
                        ],
                      },
                    },
                  },
                }),
              ).params,
            ).item,
          ),
        ).result,
      ),
    ).content,
    [null, { type: 'image', data: 7 }, { type: 'image', url: 'https://example.invalid/image' }],
  );
});

test('large command completion retains bounded observer metadata without changing the full model result', () => {
  const item = {
      id: 'command-1',
      type: 'commandExecution',
      command: 'run-existing-tool',
      cwd: '/workspace',
      processId: 'process-1',
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'x'.repeat(1024 * 1024),
      exitCode: 0,
      durationMs: 42,
    },
    event = { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item } },
    before = JSON.stringify(event),
    observed = prepareObserverEvent(event);
  assert.ok(Buffer.byteLength(before) > 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 1024);
  assert.deepEqual(observedRecord(observedRecord(observed).params).item, {
    id: 'command-1',
    type: 'commandExecution',
    status: 'completed',
    exitCode: 0,
    durationMs: 42,
  });
  assert.equal(observedRecord(observedRecord(observed).params).threadId, 'thread');
  assert.equal(observedRecord(observedRecord(observed).params).turnId, 'turn');
  assert.equal(JSON.stringify(event), before);
  assert.equal(item.aggregatedOutput.length, 1024 * 1024);
  assert.equal(prepareObserverEvent(observed), observed);
});

test('a screenshot serialized as a one-MiB JSON text block is observer-only bulk data', () => {
  const image = { content: [{ type: 'image', data: 'x'.repeat(1048460), mimeType: 'image/png' }] },
    text = JSON.stringify(image),
    event = {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          id: 'json-screenshot',
          type: 'mcpToolCall',
          server: 'dant_desktop',
          tool: 'screenshot',
          status: 'completed',
          arguments: {},
          result: { content: [{ type: 'text', text }], isError: false },
        },
      },
    },
    before = JSON.stringify(event),
    observed = prepareObserverEvent(event);
  assert.equal(text.length, 1048523);
  assert.ok(Buffer.byteLength(before) > 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 1024);
  assert.equal(getObserverProjectionKind(observed), 'payload');
  assert.deepEqual(observedRecord(observedRecord(observed).params).item, {
    id: 'json-screenshot',
    type: 'mcpToolCall',
    status: 'completed',
  });
  assert.equal(defined(event.params.item.result.content[0]).text, text);
  assert.equal(JSON.stringify(event), before);
});

test('known unused large notification payloads are projected without retaining raw output or image data', () => {
  const large = 'raw-observer-private-' + 'x'.repeat(200000),
    cases = [
      { type: 'userMessage', content: [{ type: 'text', text: large }] },
      { type: 'hookPrompt', fragments: [{ text: large }] },
      { type: 'plan', text: large },
      { type: 'reasoning', summary: [large], content: [large] },
      { type: 'commandExecution', aggregatedOutput: large },
      { type: 'fileChange', changes: [{ diff: large }] },
      {
        type: 'mcpToolCall',
        server: 'other',
        tool: 'send_chat_message',
        arguments: { text: large },
        result: { structuredContent: { private: large } },
      },
      {
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'screenshot',
        arguments: {},
        result: { content: [{ type: 'text', text: large }] },
      },
      {
        type: 'dynamicToolCall',
        arguments: { text: large },
        contentItems: [{ type: 'image', data: large }],
      },
      { type: 'collabAgentToolCall', prompt: large, agentsStates: { worker: { text: large } } },
      { type: 'webSearch', query: large },
      { type: 'imageView', path: large },
      { type: 'imageGeneration', result: large },
      { type: 'enteredReviewMode', review: large },
      { type: 'exitedReviewMode', review: large },
      { type: 'contextCompaction', extra: large },
    ];
  for (const method of ['item/started', 'item/completed'])
    for (const data of cases) {
      const event = {
          method,
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: { id: 'known-item', status: 'completed', ...data },
          },
        },
        before = JSON.stringify(event),
        observed = prepareObserverEvent(event);
      assert.deepEqual(observedRecord(observedRecord(observed).params).item, {
        id: 'known-item',
        type: data.type,
        status: 'completed',
      });
      assert.equal(getObserverProjectionKind(observed), 'payload');
      assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 1024);
      assert.equal(JSON.stringify(event), before);
      assert.equal(prepareObserverEvent(observed), observed);
    }
});

test('large assistant final and delta keep the existing voice output budget without altering source text', () => {
  const text = '中文\u0000'.repeat(150000),
    event = {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          id: 'agent-result',
          type: 'agentMessage',
          text,
          memoryCitation: { private: 'x'.repeat(1024 * 1024) },
        },
      },
    },
    observed = prepareObserverEvent(event);
  assert.equal(
    observedRecord(defined(observedRecord(observedRecord(observed).params).item)).text,
    text.slice(0, 120000),
  );
  assert.equal(
    Object.hasOwn(
      observedRecord(observedRecord(observedRecord(observed).params).item),
      'memoryCitation',
    ),
    false,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 1024 * 1024);
  assert.equal(event.params.item.text, text);
  assert.equal(event.params.item.memoryCitation.private.length, 1024 * 1024);
  assert.equal(getObserverProjectionKind(observed), 'payload');
  const delta = {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'agent-result', delta: text },
    },
    projected = prepareObserverEvent(delta);
  assert.equal(observedRecord(observedRecord(projected).params).delta, text.slice(0, 120000));
  assert.equal(delta.params.delta, text);
  assert.equal(prepareObserverEvent(projected), projected);
  assert.equal(getObserverProjectionKind(projected), 'payload');
});

test('validated MCP delivery candidates retain exact arguments and payload while unrelated large results do not', () => {
  const large = 'x'.repeat(100000);
  for (const tool of ['send_chat_message', 'create_voice_message', 'react_message']) {
    const args = { text: large, messageId: 'target', emoji: '👍' },
      payload = {
        dantMessage: { text: large },
        voiceFile: { path: '/workspace/output/result.wav' },
        dantReaction: { messageId: 'target', emoji: '👍' },
      },
      event = {
        method: 'item/completed',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: {
            id: 'delivery',
            type: 'mcpToolCall',
            server: 'dant_desktop',
            tool,
            status: 'completed',
            arguments: args,
            result: {
              structuredContent: payload,
              content: [{ type: 'text', text: JSON.stringify(payload) }],
              isError: false,
            },
          },
        },
      };
    assert.equal(prepareObserverEvent(event), event);
    for (const patch of [
      { status: 'failed' },
      { error: { message: large } },
      { result: { isError: true, content: [{ type: 'text', text: large }] } },
    ]) {
      const rejected = {
          ...event,
          params: { ...event.params, item: { ...event.params.item, ...patch } },
        },
        projected = prepareObserverEvent(rejected);
      assert.deepEqual(observedRecord(observedRecord(projected).params).item, {
        id: 'delivery',
        type: 'mcpToolCall',
        status: patch.status || 'completed',
      });
    }
  }
});

test('RPC requests including zero and null IDs, lifecycle events, unknown items and malformed identities retain the safety budget', () => {
  const large = 'x'.repeat(1024 * 1024),
    notification = {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { id: 'command-1', type: 'commandExecution', aggregatedOutput: large },
      },
    };
  for (const id of [0, null, 1, 'request-1']) {
    const request = { ...notification, id };
    assert.equal(prepareObserverEvent(request), request);
    assert.equal(getObserverProjectionKind(request), null);
  }
  for (const value of [
    { ...notification, method: 'item/tool/call' },
    { ...notification, method: 'turn/completed' },
    { ...notification, method: 'thread/realtime/itemAdded' },
    {
      ...notification,
      params: {
        ...notification.params,
        item: { ...notification.params.item, type: 'unknownFutureItem' },
      },
    },
    {
      ...notification,
      params: { ...notification.params, item: { ...notification.params.item, id: '' } },
    },
    {
      ...notification,
      params: {
        ...notification.params,
        item: { ...notification.params.item, id: 'x'.repeat(257) },
      },
    },
    {
      ...notification,
      params: {
        ...notification.params,
        item: { ...notification.params.item, id: 'bad\nidentity' },
      },
    },
    { method: 'item/agentMessage/delta', params: { itemId: '', delta: large } },
    { method: 'item/agentMessage/delta', params: { itemId: 'item', delta: [] } },
    {
      method: 'item/completed',
      params: { item: { id: 'item', type: 'agentMessage', text: { private: large } } },
    },
  ])
    assert.equal(prepareObserverEvent(value), value);
  const image = {
    ...notification,
    id: null,
    params: {
      ...notification.params,
      item: {
        id: 'image-request',
        type: 'mcpToolCall',
        result: { content: [{ type: 'image', data: large }] },
      },
    },
  };
  assert.equal(prepareObserverEvent(image), image);
  for (const id of [undefined, '', 'bad\nidentity', 'x'.repeat(257)]) {
    const malformed = { ...image };
    Reflect.deleteProperty(malformed, 'id');
    Reflect.set(malformed, 'params', { ...image.params, item: { ...image.params.item, id } });
    assert.equal(prepareObserverEvent(malformed), malformed);
  }
  assert.equal(prepareObserverEvent(undefined), undefined);
  assert.equal(getObserverProjectionKind(null), null);
});

test('diagnostic item metadata is fixed, bounded and excludes raw content and unsafe identifiers', () => {
  assert.deepEqual(
    observerEventMetadata({
      params: {
        item: {
          id: 'command-1',
          type: 'commandExecution',
          status: 'completed',
          aggregatedOutput: 'private',
          arguments: { token: 'private' },
        },
      },
    }),
    { itemType: 'commandExecution', itemStatus: 'completed', itemId: 'command-1' },
  );
  assert.deepEqual(observerEventMetadata({ params: { itemId: 'delta-1' } }), { itemId: 'delta-1' });
  assert.deepEqual(observerEventMetadata(null), {});
  for (const id of [
    'sk-live-secret',
    'Bearer-secret',
    'ghp_secret',
    'a'.repeat(129),
    'path/private',
    'private value',
  ])
    assert.deepEqual(
      observerEventMetadata({
        params: { item: { id, type: 'unknown-secret', status: 'raw secret' } },
      }),
      { itemType: 'other' },
    );
});
