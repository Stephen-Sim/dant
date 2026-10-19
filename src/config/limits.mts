// Fixed protocol deadlines. These preserve room for a verified work pause and
// VM operation before the native handoff expires; they are not user settings.
export const INSTALL_LEASE_TTL_MS = 30_000;
export const DESKTOP_TRANSITION_TIMEOUT_MS = 150_000;
export const VM_PAUSE_TIMEOUT_MS = 45_000;
export const VM_OPERATION_TIMEOUT_MS = 85_000;
