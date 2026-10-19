import type { EventEmitter } from 'node:events';
import type { Store } from '../conversation/store.mts';
import type { WorkerPublic } from '../runtime/worker-types.ts';
import type { Engine, EngineTranscriber, EngineVoice, EngineNativeVoice } from '../work/engine.mts';
import type { EngineToolContext } from '../work/engine-types.ts';
import type { RpcResult, ToolArguments } from '../runtime/protocol.ts';
import type { VoiceConversationValue } from '../voice/voice-types.ts';
import type { TelegramGateway } from '../telegram/telegram.mts';
import type { CredentialVault, CredentialRequests } from '../security/credentials.mts';
import type { SkillLibrary } from '../skills/skill-library.mts';
import type { SkillImporter } from '../skills/skill-import.mts';
import type { Diagnostics, DiagnosticsOptions } from '../diagnostics/diagnostics.mts';
import type { UpdateService, UpdateServiceOptions } from '../updates/updates.mts';
import type { AudioTranscriber } from '../voice/audio-transcription.mts';
import type { ControllerAppOptions, ControllerVoiceKeys } from './controller-types.ts';

export interface WorkerService extends WorkerPublic {
  error?: string | null;
  models?: RpcResult | null;
  connect(): Promise<unknown>;
  disconnect(): void;
  guest(route: string, body?: unknown): Promise<Response>;
}

export interface ApiVoiceFactoryOptions {
  getKey: () => string | null | Promise<string | null>;
  onConversationItem: (item: VoiceConversationValue) => Promise<unknown>;
  runTask: (text: string, context?: EngineToolContext) => Promise<unknown>;
  tool: (name: string, args: ToolArguments, context?: EngineToolContext) => unknown;
  context: (options?: { reactionsOnly?: boolean }) => string;
  redactSubtitle: (text: unknown, additionalSecrets: string[]) => string;
  hangupTimeoutMs: number;
}

export type ApiVoiceService = EngineVoice &
  Pick<EventEmitter, 'on'> &
  Required<Pick<EngineVoice, 'close'>>;
export type NativeVoiceService = EngineNativeVoice;
export type TelegramService = Pick<
  TelegramGateway,
  'close' | 'status' | 'start' | 'configure' | 'pair' | 'disconnect'
> &
  Pick<EventEmitter, 'on'>;
export type VaultService = Pick<
  CredentialVault,
  'list' | 'find' | 'get' | 'upsert' | 'remove' | 'containsSecret' | 'redact'
>;
export type CredentialService = Pick<
  CredentialRequests,
  | 'snapshot'
  | 'find'
  | 'get'
  | 'upsert'
  | 'remove'
  | 'containsSecret'
  | 'redact'
  | 'request'
  | 'fulfill'
  | 'cancel'
  | 'cancelOwner'
  | 'close'
>;
export type SkillService = Pick<
  SkillLibrary,
  | 'list'
  | 'get'
  | 'save'
  | 'setEnabled'
  | 'remove'
  | 'containsSecret'
  | 'locate'
  | 'context'
  | 'exportSnapshot'
  | 'fileName'
>;
export type ImportService = Pick<SkillImporter, 'preview' | 'commit' | 'discard' | 'close'>;
export type TranscriberService = EngineTranscriber;

export interface WorkerAppOptions {
  dataDir?: string;
  workerFactory?: (store: Store) => WorkerService;
  secretFactory?: (directory: string) => ControllerVoiceKeys;
  voiceFactory?: (options: ApiVoiceFactoryOptions) => ApiVoiceService;
  nativeVoiceFactory?: (options: { worker: WorkerService; engine: Engine }) => NativeVoiceService;
  telegramFactory?: (options: ConstructorParameters<typeof TelegramGateway>[0]) => TelegramService;
  credentialVaultFactory?: (options: { dataDir: string }) => VaultService;
  credentialRequestsFactory?: (options: {
    vault: VaultService;
    change: () => void;
  }) => CredentialService;
  skillLibraryFactory?: (options: {
    workspace: string;
    containsSecret: (value: string) => boolean;
  }) => SkillService;
  skillImporterFactory?: (options: { skills: SkillService }) => ImportService;
  diagnosticsFactory?: (
    options: DiagnosticsOptions,
  ) => Pick<Diagnostics, 'log' | 'recent' | 'status' | 'close'>;
  updatesFactory?: (
    options: UpdateServiceOptions,
  ) => Pick<UpdateService, 'info' | 'check' | 'close'>;
  audioTranscriberFactory?: (
    options: NonNullable<ConstructorParameters<typeof AudioTranscriber>[0]>,
  ) => TranscriberService;
}

export type ApplicationOptions = WorkerAppOptions &
  ControllerAppOptions & {
    mode?: 'test' | 'vm-worker' | 'vm-controller' | 'prepare';
  };
