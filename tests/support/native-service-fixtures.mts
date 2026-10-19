import { EventEmitter } from 'node:events';
import type { EngineNativeVoice } from '../../src/work/engine.mts';
import { unexpectedFixtureOperation } from './service-fixtures.mts';

/** An inert local provider; each operation used by a test must be configured explicitly. */
export class NativeVoiceFixture extends EventEmitter implements EngineNativeVoice {
  call: EngineNativeVoice['call'] = null;
  session: EngineNativeVoice['session'] = null;
  active: EngineNativeVoice['active'] = null;
  progress: EngineNativeVoice['progress'] = null;
  acceptsChatInput = false;
  acceptsInteractiveChatInput = false;
  state: EngineNativeVoice['state'] = {
    call: null,
    error: null,
    lastStop: null,
    available: true,
    version: 'v3',
    model: 'fixture',
  };
  message(
    ..._arguments: Parameters<EngineNativeVoice['message']>
  ): ReturnType<EngineNativeVoice['message']> {
    return unexpectedFixtureOperation();
  }
  answerBackground(
    ..._arguments: Parameters<EngineNativeVoice['answerBackground']>
  ): ReturnType<EngineNativeVoice['answerBackground']> {
    return unexpectedFixtureOperation();
  }
  cancelWork(
    ..._arguments: Parameters<EngineNativeVoice['cancelWork']>
  ): ReturnType<EngineNativeVoice['cancelWork']> {
    return unexpectedFixtureOperation();
  }
  confirmConnected(
    ..._arguments: Parameters<EngineNativeVoice['confirmConnected']>
  ): ReturnType<EngineNativeVoice['confirmConnected']> {
    return unexpectedFixtureOperation();
  }
  handleEvent(
    ..._arguments: Parameters<EngineNativeVoice['handleEvent']>
  ): ReturnType<EngineNativeVoice['handleEvent']> {
    return unexpectedFixtureOperation();
  }
  pauseWork(
    ..._arguments: Parameters<EngineNativeVoice['pauseWork']>
  ): ReturnType<EngineNativeVoice['pauseWork']> {
    return unexpectedFixtureOperation();
  }
  pendingHandoffs(
    ..._arguments: Parameters<EngineNativeVoice['pendingHandoffs']>
  ): ReturnType<EngineNativeVoice['pendingHandoffs']> {
    return unexpectedFixtureOperation();
  }
  stop(
    ..._arguments: Parameters<EngineNativeVoice['stop']>
  ): ReturnType<EngineNativeVoice['stop']> {
    return unexpectedFixtureOperation();
  }
  submitCallMessage(
    ..._arguments: Parameters<EngineNativeVoice['submitCallMessage']>
  ): ReturnType<EngineNativeVoice['submitCallMessage']> {
    return unexpectedFixtureOperation();
  }
  ownsEvent(
    ..._arguments: Parameters<EngineNativeVoice['ownsEvent']>
  ): ReturnType<EngineNativeVoice['ownsEvent']> {
    return unexpectedFixtureOperation();
  }
  start(
    ..._arguments: Parameters<EngineNativeVoice['start']>
  ): ReturnType<EngineNativeVoice['start']> {
    return unexpectedFixtureOperation();
  }
  syncMemory(
    ..._arguments: Parameters<EngineNativeVoice['syncMemory']>
  ): ReturnType<EngineNativeVoice['syncMemory']> {
    return unexpectedFixtureOperation();
  }
  syncContext(
    ..._arguments: Parameters<EngineNativeVoice['syncContext']>
  ): ReturnType<EngineNativeVoice['syncContext']> {
    return unexpectedFixtureOperation();
  }
  canContinueWhileIdle(
    ..._arguments: Parameters<EngineNativeVoice['canContinueWhileIdle']>
  ): ReturnType<EngineNativeVoice['canContinueWhileIdle']> {
    return unexpectedFixtureOperation();
  }
  beginContinuationAdmission(
    ..._arguments: Parameters<EngineNativeVoice['beginContinuationAdmission']>
  ): ReturnType<EngineNativeVoice['beginContinuationAdmission']> {
    return unexpectedFixtureOperation();
  }
  replayContinuationEvents(
    ..._arguments: Parameters<EngineNativeVoice['replayContinuationEvents']>
  ): ReturnType<EngineNativeVoice['replayContinuationEvents']> {
    return unexpectedFixtureOperation();
  }
  confirmContinuationAdmission(
    ..._arguments: Parameters<EngineNativeVoice['confirmContinuationAdmission']>
  ): ReturnType<EngineNativeVoice['confirmContinuationAdmission']> {
    return unexpectedFixtureOperation();
  }
  finishContinuationAdmission(
    ..._arguments: Parameters<EngineNativeVoice['finishContinuationAdmission']>
  ): ReturnType<EngineNativeVoice['finishContinuationAdmission']> {
    return unexpectedFixtureOperation();
  }
  close(
    ..._arguments: Parameters<EngineNativeVoice['close']>
  ): ReturnType<EngineNativeVoice['close']> {
    return unexpectedFixtureOperation();
  }
  listVoices(
    ..._arguments: Parameters<EngineNativeVoice['listVoices']>
  ): ReturnType<EngineNativeVoice['listVoices']> {
    return unexpectedFixtureOperation();
  }
}
