import type { JsonValue } from '../contracts/json.mts';

export interface RpcInputText {
  type: 'text';
  text: string;
  text_elements?: readonly unknown[];
}
export interface RpcInputImage {
  type: 'image';
  url: string;
  detail?: string;
}
export interface RpcInputFile {
  type: 'localImage' | 'localFile';
  path: string;
}
export type RpcInput = RpcInputText | RpcInputImage | RpcInputFile;
export interface RpcContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}
export interface RpcToolResult {
  isError?: boolean;
  // MCP permits arbitrary JSON payloads. Consumers validate the fields they use.
  content?: unknown[];
  structuredContent?: unknown;
  [key: string]: unknown;
}
export interface RpcItemFields {
  type: string;
  status?: string;
  text?: string;
  phase?: string | null;
  role?: string;
  server?: string;
  tool?: string;
  callId?: string;
  realtimeSessionId?: string;
  realtime_session_id?: string;
  handoff_id?: string;
  item_id?: string;
  itemId?: string;
  sourcePath?: string;
  cwd?: string;
  arguments?: unknown;
  error?: { message?: string } | string | null;
  result?: RpcToolResult | null;
  content?: RpcContentBlock[] | string[];
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: Array<{ path?: string; kind?: string | { type?: string }; diff?: string }>;
  aggregatedOutput?: string | null;
  commandActions?: Array<{ type?: string }>;
  active_transcript?: Array<{ role: string; text: string }>;
  input_transcript?: string;
  [key: string]: unknown;
}
export interface RpcItem extends RpcItemFields {
  id: string;
}
export interface RpcHandoffItem extends RpcItemFields {
  type: 'handoff_request';
  id?: string;
}
export interface RpcTurn {
  id: string;
  items?: RpcItem[];
  status?: string;
  startedAt?: number | null;
  error?: { message?: string } | null;
}
export interface RpcThread {
  id: string;
  turns?: RpcTurn[];
  status?: string | { type: string };
}
export interface RpcQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
}
export interface RpcParams {
  threadId?: string;
  turnId?: string;
  turn?: RpcTurn;
  thread?: RpcThread;
  item?: RpcItem | RpcHandoffItem;
  itemId?: string;
  delta?: string;
  text?: string;
  role?: string;
  callId?: string;
  realtimeSessionId?: string;
  sdp?: string;
  version?: string;
  message?: string;
  tool?: string;
  arguments?: Record<string, unknown> | string;
  questions?: RpcQuestion[];
  plan?: Array<{ step: string; status: string }>;
  error?: { message?: string };
  input?: RpcInput[];
  prompt?: string;
  realtimeStartInstructions?: string;
  developerInstructions?: string;
  cwd?: string;
  model?: string | undefined;
  approvalPolicy?: string;
  sandbox?: string;
  persistExtendedHistory?: boolean;
  capabilities?: { experimentalApi?: boolean };
  [key: string]: unknown;
}
export interface RpcEvent {
  method: string;
  params: Record<string, unknown>;
  id?: string | number | null;
}
export interface RpcRequestEnvelope {
  id?: string | number;
  method: string;
  params?: RpcParams;
}
export interface RpcReplyEnvelope {
  id: string | number;
  result: unknown;
}
export interface RpcErrorEnvelope {
  id?: string | number | null | undefined;
  error: { code: number; message: string };
}
export type RpcEnvelope = RpcRequestEnvelope | RpcReplyEnvelope | RpcErrorEnvelope;
export interface RpcResult {
  thread?: RpcThread;
  turn?: RpcTurn;
  data?: unknown;
  status?: string;
  account?: { type?: string; email?: string; planType?: string } | null;
  authMode?: string | null;
  requiresOpenaiAuth?: boolean;
  authUrl?: string;
  loginId?: string;
  voices?: { v3?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}
export interface RpcRequestOptions {
  signal?: AbortSignal;
}
export type ToolArguments = Record<string, unknown>;
export type RpcJsonResult = JsonValue | undefined;
