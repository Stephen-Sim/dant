/** Authenticated transport observations remain untrusted until their consumer validates them. */
export interface VmObservation {
  conversationId?: unknown;
  messages?: unknown;
  workTasks?: unknown;
  queue?: unknown;
  active?: unknown;
  call?: unknown;
  takeover?: unknown;
  acquiring?: unknown;
  worker?: {
    status?: unknown;
    error?: unknown;
    realtime?: unknown;
    account?: unknown;
    models?: unknown;
  };
  settings?: unknown;
  computer?: unknown;
  mode?: unknown;
  memory?: unknown;
  capabilities?: {
    languages?: unknown;
    workReply?: unknown;
    recurringSchedules?: unknown;
    backups?: unknown;
  };
  provisioning?: unknown;
  controller?: unknown;
  schedules?: unknown;
}

export interface PauseEntry {
  id?: unknown;
  turnId?: unknown;
  status?: unknown;
  unknownOutcome?: unknown;
  submission?: unknown;
  continuation?: {
    invalid?: unknown;
    dispatch?: { phase?: unknown } | null;
  } | null;
}

export interface PauseSnapshot {
  messages: PauseEntry[];
  workTasks: PauseEntry[];
  queue: unknown[];
  takeover: boolean;
  acquiring?: unknown;
  active: { turnId?: unknown; workId?: unknown } | null;
  call: { id?: unknown } | null;
  worker: { status?: unknown };
  computer: {
    status?: unknown;
    sessionId?: unknown;
    pending?: unknown;
    acquiring?: unknown;
  };
}
