import test from 'node:test';
import assert from 'node:assert/strict';
import { isRpcItem, readRpcEvent, readRpcResult } from '../../src/runtime/rpc-values.mts';

// Public v2 wire shapes from the installed app-server schema, including its explicit nulls.
const wireTurn = () => ({
  id: 'turn-fixture',
  items: [],
  status: 'inProgress',
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});
const wireItems = () => [
  {
    type: 'userMessage',
    id: 'human-fixture',
    content: [
      { type: 'text', text: 'Fixture request', text_elements: [] },
      { type: 'localImage', path: '/fixture/image.png' },
    ],
  },
  {
    type: 'agentMessage',
    id: 'assistant-fixture',
    text: 'Fixture answer',
    phase: null,
    memoryCitation: null,
  },
  {
    type: 'reasoning',
    id: 'reasoning-fixture',
    summary: ['Fixture summary'],
    content: ['First fragment', 'Second fragment'],
  },
  {
    type: 'commandExecution',
    id: 'command-fixture',
    command: 'fixture-command',
    cwd: '/fixture',
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  },
  {
    type: 'mcpToolCall',
    id: 'mcp-fixture',
    server: 'fixture-server',
    tool: 'fixture-tool',
    status: 'inProgress',
    arguments: null,
    result: null,
    error: null,
    durationMs: null,
  },
];

test('normal app-server turn and thread responses retain explicit nulls and heterogeneous item content', () => {
  const turn = wireTurn();
  assert.deepEqual(readRpcResult({ turn }), { turn });
  const thread = {
    id: 'thread-fixture',
    status: { type: 'idle' },
    turns: [{ ...turn, items: wireItems() }],
  };
  assert.deepEqual(readRpcResult({ thread }), { thread });
  for (const item of wireItems()) assert.equal(isRpcItem(item), true);
});

test('MCP JSON payloads remain opaque until their consumer validates the requested action', () => {
  for (const argumentsValue of [null, false, 0, 'text', ['value'], { text: 'value' }]) {
    const item = {
      type: 'mcpToolCall',
      id: 'mcp-fixture',
      arguments: argumentsValue,
      result: {
        content: [null, false, 0, 'text', { type: 'text', text: 'Fixture result' }],
        structuredContent: argumentsValue,
        _meta: null,
      },
    };
    const result = { turn: { ...wireTurn(), status: 'completed', items: [item], startedAt: 123 } };
    assert.deepEqual(readRpcResult(result), result);
  }
  const failed = {
    turn: {
      ...wireTurn(),
      status: 'failed',
      error: { message: 'Fixture failure', codexErrorInfo: null, additionalDetails: null },
    },
  };
  assert.deepEqual(readRpcResult(failed), failed);
});

test('known response fields still reject malformed values without dropping an invalid item', () => {
  const command = { type: 'commandExecution', id: 'fixture' };
  for (const item of [
    { ...command, phase: 1 },
    { ...command, aggregatedOutput: [] },
    { ...command, exitCode: false },
    { ...command, durationMs: '1' },
    { ...command, result: 'unconfirmed' },
    { ...command, result: { isError: 'false' } },
    { ...command, result: { content: { type: 'text' } } },
    { type: 'userMessage', id: 'fixture', content: ['not a user input block'] },
    {
      type: 'reasoning',
      id: 'fixture',
      content: [{ type: 'text', text: 'not a reasoning string' }],
    },
  ]) {
    assert.equal(isRpcItem(item), false);
    assert.throws(
      () => readRpcResult({ turn: { ...wireTurn(), items: [item] } }),
      /invalid response/,
    );
  }
  for (const turn of [
    { ...wireTurn(), startedAt: '123' },
    { ...wireTurn(), error: false },
  ])
    assert.throws(() => readRpcResult({ turn }), /invalid response/);
});

test('account responses follow their nullable account envelope and non-null ChatGPT metadata', () => {
  for (const account of [
    null,
    { type: 'apiKey' },
    { type: 'amazonBedrock' },
    { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' },
  ]) {
    const response = { account, requiresOpenaiAuth: true };
    assert.deepEqual(readRpcResult(response), response);
  }
  for (const account of [
    { type: 'chatgpt', email: null },
    { type: 'chatgpt', planType: null },
  ])
    assert.throws(() => readRpcResult({ account }), /invalid response/);
});

test('coarse event parsing preserves uncertain control fields for the owning identity validator', () => {
  const event = {
    method: 'item/started',
    id: null,
    params: { threadId: 'thread-fixture', item: { type: 'handoff_request', arguments: false } },
  };
  assert.deepEqual(readRpcEvent(event), event);
  assert.equal(readRpcEvent({ ...event, id: { invalid: true } }), null);
});
