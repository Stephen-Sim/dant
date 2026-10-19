import type { EventEmitter } from 'node:events';
import type { ClientOptions } from 'ws';
import type { EngineToolContext } from '../work/engine-types.ts';
import type { ToolArguments } from '../runtime/protocol.ts';
import type { LiveContextQueue } from './call-context.mts';
import type { createSpokenSubtitles } from './call-subtitles.mts';
export interface VoiceSocket extends Pick<EventEmitter, 'on'> {
  readyState: number;
  send(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
}
export interface VoiceSocketConstructor {
  new (url: string, options: ClientOptions): VoiceSocket;
}
export interface VoiceOptions {
  getKey?: () => unknown | Promise<unknown>;
  runTask?: (text: string, context: EngineToolContext) => unknown | Promise<unknown>;
  tool?: (
    name: string,
    args: ToolArguments,
    context: EngineToolContext,
  ) => unknown | Promise<unknown>;
  context?:
    string | object | ((options?: { reactionsOnly: boolean }) => unknown | Promise<unknown>);
  onConversationItem?: (value: VoiceConversationValue) => void | Promise<unknown>;
  redactSubtitle?: (text: string, additionalSecrets: string[]) => string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: VoiceSocketConstructor;
  model?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  hangupTimeoutMs?: number;
  contextTimeoutMs?: number;
}
export interface VoiceConversationValue {
  callId: string;
  itemId: string;
  previousItemId?: string | null;
  role: 'assistant' | 'user';
  text: string;
}
export interface VoiceConversationNode {
  id: string;
  state: 'pending' | 'skip' | 'final';
  known: boolean;
  previousItemId?: string | null;
  role?: string | undefined;
  inputAudio?: boolean | undefined;
  emitted?: boolean;
  text?: string;
}
export interface VoiceInputResult {
  messageId: string;
  callId: string;
  status: string;
  submission: string;
  confirmedAt: number | undefined;
}
export interface VoiceInputEntry {
  messageId: string;
  text: string;
  itemId: string;
  eventId: string;
  submission: string;
  confirmedAt?: number;
  promise?: Promise<VoiceInputResult>;
}
export interface VoiceContextAck {
  contextId: string;
  instructions: string;
  entries: Map<string, string>;
  memory: string | undefined;
  base: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  sent: boolean;
}
export interface VoiceSession {
  callId: string;
  started: number;
  status: string;
  voice: string;
  abort: AbortController;
  tools: Set<string>;
  pendingTools: number;
  activeResponse: boolean;
  needsResponse: boolean;
  ready: boolean;
  closed: boolean;
  contextEntries: Map<string, string>;
  conversationItems: Map<string, VoiceConversationNode>;
  conversationCallbacks: Promise<unknown>;
  conversationWaiters: Set<() => void>;
  messageChain: Promise<unknown>;
  messages: Map<string, VoiceInputEntry>;
  id?: string | null | undefined;
  socket?: VoiceSocket;
  subtitles?: ReturnType<typeof createSpokenSubtitles>;
  baseMemory?: string | undefined;
  baseReference?: string;
  baseInstructions?: string;
  stopping?: boolean;
  inputUnknown?: boolean;
  contextQueue?: LiveContextQueue;
  contextAck?: VoiceContextAck | null;
  inputAck?: { entry: VoiceInputEntry; finish: (error?: Error) => void } | null;
  unconfirmedContextId?: string;
  conversationError?: boolean;
  cleanup?: Promise<void>;
  notified?: boolean;
}
export interface ApiContent {
  type?: string;
  text?: string;
  transcript?: string;
}
export interface ApiItem {
  id?: string;
  type?: string;
  role?: string;
  status?: string;
  content?: ApiContent[];
  call_id?: string;
  name?: string;
  arguments?: unknown;
}
export interface ApiEvent {
  type: string;
  response_id?: unknown;
  delta?: unknown;
  output_index?: unknown;
  content_index?: unknown;
  item?: ApiItem;
  item_id?: string;
  previous_item_id?: string | null;
  transcript?: string;
  session?: { instructions?: string };
  error?: { event_id?: string; code?: string };
  response?: {
    id?: string;
    usage?: unknown;
    output?: ApiItem[];
    status?: string;
    conversation_id?: string | null;
  };
}
