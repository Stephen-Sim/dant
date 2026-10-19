import { EventEmitter } from 'node:events';
import type { LocalRpcPort } from '../../src/runtime/local-worker.mts';
import type { EngineVoice } from '../../src/work/engine.mts';
import { unexpectedFixtureOperation } from './service-fixtures.mts';

/** Explicitly configured wire transports; an unused capability never invents success. */
export class RpcFixture extends EventEmitter implements LocalRpcPort {
  closed = false;
  request: LocalRpcPort['request'] = unexpectedFixtureOperation;
  send: LocalRpcPort['send'] = unexpectedFixtureOperation;
  reply: LocalRpcPort['reply'] = unexpectedFixtureOperation;
  close: LocalRpcPort['close'] = unexpectedFixtureOperation;
}

export class VoiceFixture extends EventEmitter implements EngineVoice {
  start: EngineVoice['start'] = unexpectedFixtureOperation;
  stop: EngineVoice['stop'] = unexpectedFixtureOperation;
  close: NonNullable<EngineVoice['close']> = unexpectedFixtureOperation;
}
