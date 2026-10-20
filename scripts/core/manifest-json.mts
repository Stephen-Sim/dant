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

/** Read an error code without trusting an arbitrary thrown value. */
export function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error)
    return typeof error.code === 'string' ? error.code : undefined;
  return undefined;
}
