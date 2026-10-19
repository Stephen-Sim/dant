import type { EventEmitter } from 'node:events';
import type { RpcEnvelope, RpcParams, RpcResult } from './protocol.ts';
import type { SkillLibrary } from '../skills/skill-library.mts';
import type { ConnectionSnapshot } from '../contracts/contracts.ts';

export interface WorkerRpcPublic {
  send: (message: RpcEnvelope) => void;
  reply: (id: string | number, result: unknown) => void;
}
export interface WorkerVoiceMessage {
  path: string;
  type: string;
  [key: string]: unknown;
}
/** The execution protocol consumed by Engine and subscription voice, independent of implementation. */
export interface WorkerPublic extends Pick<EventEmitter, 'on'> {
  status: ConnectionSnapshot['status'];
  runtimeId?: string;
  workspaceRoot?: string;
  desktopPath?: string;
  rpc?: WorkerRpcPublic | null | undefined;
  account?: RpcResult | null;
  skills?: Pick<SkillLibrary, 'context'>;
  request: (method: string, params?: RpcParams) => Promise<RpcResult>;
  terminateConfirmed?: (options?: { timeoutMs?: number }) => Promise<{ terminated: boolean }>;
  createVoiceMessage?: (input: {
    text?: string;
    voice?: string;
    outputDir?: string;
    language?: string;
  }) => Promise<WorkerVoiceMessage>;
}
