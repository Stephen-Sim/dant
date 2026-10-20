import canonical from '../../resources/config/computer.json' with { type: 'json' };
import { isRecord } from '../shared/contracts.mts';

const MAX_RESOURCE_BYTES = 4 * 1024;
const MAX_RESOURCE_VALUE = 2_147_483_647;
const RESOURCE_KEYS = ['cpu', 'memoryGB', 'diskGB'] as const;
const RANGE_KEYS = ['default', 'min', 'max'] as const;
const INVALID = 'Invalid computer resource configuration.';

export interface ResourceRange {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export type ComputerResources = Readonly<Record<(typeof RESOURCE_KEYS)[number], ResourceRange>>;

function resourceRange(input: unknown): ResourceRange {
  if (!isRecord(input) || Object.keys(input).length !== RANGE_KEYS.length) throw Error(INVALID);
  for (const name of RANGE_KEYS) {
    const value = input[name];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_RESOURCE_VALUE
    )
      throw Error(INVALID);
  }

  const { default: value, min, max } = input;
  if (
    typeof value !== 'number' ||
    typeof min !== 'number' ||
    typeof max !== 'number' ||
    value < min ||
    value > max
  )
    throw Error(INVALID);
  return Object.freeze({ default: value, min, max });
}

export function validateComputerResources(input: unknown): ComputerResources {
  if (!isRecord(input) || Object.keys(input).length !== RESOURCE_KEYS.length) throw Error(INVALID);
  return Object.freeze({
    cpu: resourceRange(input.cpu),
    memoryGB: resourceRange(input.memoryGB),
    diskGB: resourceRange(input.diskGB),
  });
}

/** Preserve duplicate keys until the canonical resource has been validated. */
export function parseComputerResources(text: string): ComputerResources {
  if (new TextEncoder().encode(text).length > MAX_RESOURCE_BYTES) throw Error(INVALID);
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const containers: (Set<string> | null)[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === '{') containers.push(new Set());
    else if (token === '[') containers.push(null);
    else if (token === '}' || token === ']') containers.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const name: unknown = JSON.parse(token);
      const current = containers.at(-1);
      if (typeof name !== 'string' || !current || current.has(name)) throw Error(INVALID);
      current.add(name);
    }
  }
  return validateComputerResources(value);
}

export const COMPUTER_RESOURCES = validateComputerResources(canonical);
