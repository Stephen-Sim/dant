export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type OptionalTokenCounts = {
  [Field in keyof TokenCounts]: number | null;
};

export interface NativeUsageRecord {
  total: TokenCounts;
  last: TokenCounts;
  at: number;
}

export interface ApiVoiceUsageRecord {
  counts: OptionalTokenCounts;
  at: number;
}

export type UsageProvider = 'subscription' | 'apiVoice';
export type ProviderCounts = Record<UsageProvider, OptionalTokenCounts | null>;

export interface TokenActivity {
  timeZone: string;
  recordedSince: number | null;
  retainedFrom: string | null;
  days: Record<string, ProviderCounts>;
  unallocated: ProviderCounts;
}

export interface TokenUsageState {
  version: 2;
  recordedSince: number | null;
  native: Record<string, NativeUsageRecord>;
  apiVoice: Record<string, ApiVoiceUsageRecord>;
  activity: TokenActivity;
}

export interface CodexUsageObservation {
  threadId?: unknown;
  turnId?: unknown;
  tokenUsage?: { total?: unknown; last?: unknown };
}

export interface ApiVoiceUsageObservation {
  callId?: unknown;
  responseId?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_token_details?: { cached_tokens?: unknown };
  } | null;
}
