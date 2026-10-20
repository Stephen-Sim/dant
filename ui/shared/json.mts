/** Values accepted by JSON transport; optional object fields are omitted on serialization. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** Narrow object input without accepting arrays or null; validate each consumed field next. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Test known wire values while retaining the allowlist's literal domain. */
export function includesValue<const Value>(
  values: readonly Value[],
  value: unknown,
): value is Value {
  for (const entry of values) if (entry === value || Object.is(entry, value)) return true;
  return false;
}

/** Read an error code without trusting an arbitrary thrown value. */
export function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error)
    return typeof error.code === 'string' ? error.code : undefined;
  return undefined;
}

/** Keep error text separate from payloads and avoid serializing arbitrary objects. */
export function errorMessage(error: unknown, fallback = 'Operation failed.'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}
