// Providers sometimes encode an error object inside the RPC message string.
// Keep the actionable message and avoid showing JSON wrappers in chat.
export function readableError(value: unknown): string | undefined {
  if (value == null) return undefined;
  let current: unknown = value;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current === 'string') {
      const text = current;
      try {
        const parsed: unknown = JSON.parse(current);
        if (parsed && typeof parsed === 'object') {
          current = parsed;
          continue;
        }
      } catch {}
      return text;
    }
    if (current && typeof current === 'object') {
      const nested: unknown = Reflect.get(current, 'error');
      current =
        (nested && typeof nested === 'object' && 'message' in nested
          ? nested.message
          : undefined) ||
        nested ||
        Reflect.get(current, 'message');
      continue;
    }
    break;
  }
  return typeof current === 'string' ? current : 'The task could not be completed.';
}

export interface OperationError extends Error {
  code?: unknown;
  status?: unknown;
  submission?: unknown;
  steerReason?: unknown;
  unknownOutcome?: unknown;
}
/** Keep real Error identity while safely inspecting optional transport metadata. */
export function operationError(value: unknown): OperationError {
  if (value instanceof Error) return value;
  const result: OperationError = Error(readableError(value));
  if (value && typeof value === 'object') {
    for (const field of ['code', 'status', 'submission', 'steerReason', 'unknownOutcome'] as const)
      if (field in value) result[field] = Reflect.get(value, field);
  }
  return result;
}
