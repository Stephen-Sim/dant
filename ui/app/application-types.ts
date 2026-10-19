import type { RecordingDraftStatusValue } from '../../src/contracts/states.mts';
import type { ConnectionStatusValue } from '../../src/contracts/contracts.ts';
import type { Appearance } from '../../src/settings/appearance-types.ts';
import type {
  UiState,
  UiSettings,
  UiConnection,
  VmSettings,
  Attachment,
  UsageSnapshot,
} from '../shared/contracts.mts';
import type { MessageSubmission } from '../chat/pending.mts';

export interface AppSettings extends UiSettings, Partial<Appearance> {
  vm: VmSettings;
  model?: string;
  nativeVoice?: string;
  voice?: string;
  apiVoice?: string;
  notifications?: boolean;
  showWorkSummary?: boolean;
}
export interface TelegramSync {
  forwardMode: 'unread' | 'all';
  combineReplies: boolean;
  readState: 'independent';
}
export interface TelegramStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  paired: boolean;
  bot?: { username?: string } | null;
  owner?: { userId?: string | number; chatId?: string | number } | null;
  pairing?: { expiresAt: number } | null;
  lastError?: string | null;
  connectionError?: string | null;
  delivery?: {
    failed: number;
    unknown: number;
    lastIssue?: { status: string; reason?: string; at?: number | null } | null;
  };
  sync?: Partial<TelegramSync>;
}
export interface TelegramPairing {
  code: string;
  expiresAt: number;
  url?: string;
  botUrl?: string;
}
export interface RealtimeStatus {
  provider?: string;
  available?: boolean;
  key?: { configured?: boolean; source?: string | null };
  subscription?: { available?: boolean };
  api?: { available?: boolean };
}
export interface WorkerState extends UiConnection {
  status: ConnectionStatusValue;
  account?: { email?: string; planType?: string } | null;
  models: { model: string; displayName?: string }[];
  realtime?: RealtimeStatus;
  telegram?: Partial<TelegramStatus>;
  error?: string | null;
}
export interface ControllerState extends UiConnection {
  status: ConnectionStatusValue;
  updatesPaused?: boolean;
  serviceUpdateBusy?: boolean;
}
export interface VmProvider {
  id: string;
  available: boolean;
  reason?: string | null;
}
export interface VmProviderInfo {
  provider?: string | null;
  availableProviders: VmProvider[];
}
export interface ProvisioningState {
  status: string;
  running?: boolean;
  provider?: string | null;
  stage?: string;
  connection?: VmSettings | null;
  availableProviders?: VmProvider[];
  error?: string | null;
}
export interface AppState extends UiState {
  messages: NonNullable<UiState['messages']>;
  settings: AppSettings;
  worker: WorkerState;
  controller?: ControllerState;
  provisioning?: ProvisioningState;
  computer?: { status: string; sessionId?: string | null; acquiring?: boolean };
  telegram?: Partial<TelegramStatus>;
  usage?: UsageSnapshot;
}
export interface VmProfile extends VmSettings {
  id: string;
  label?: string;
  directory?: string;
}
export interface VmProfiles {
  candidates: VmProfile[];
  current?: VmProfile | null;
  error?: string;
}
export interface LoginDetails {
  userCode: string;
  verificationUrl: string;
}
export interface FontInventory {
  fonts: string[];
  source?: string;
}
export interface VoiceCatalogue {
  v1?: string[];
  v2?: string[];
  v3?: string[];
  voices?: string[] | { v1?: string[]; v2?: string[]; v3?: string[] };
  nativeV3?: string[];
  apiV2?: string[];
  api?: { voices?: string[] };
}
export interface CallStartResult {
  callId?: string;
  sdp?: string;
  transport?: { sdp?: string };
}
export interface SendResult {
  unknownOutcome?: boolean;
  submission?: string;
  message?: { submission?: string };
}
export interface RecordingDraft {
  generation: number;
  mimeType: string;
  chunks: Blob[];
  bytes: number;
  elapsedMs: number;
  startedAt: number;
  status: RecordingDraftStatusValue;
  previewURL: string;
  file: File | null;
  uploaded: Attachment | null;
  busy: boolean;
  stopped?: Promise<File | null>;
  resolveStop?: (file: File | null) => void;
  attempt?: MessageSubmission;
}
export interface DraftRecorder extends MediaRecorder {
  dantDiscard?: boolean;
}
export interface ConversationFile extends Attachment {
  role: 'user' | 'assistant' | 'system';
  time?: number;
}
