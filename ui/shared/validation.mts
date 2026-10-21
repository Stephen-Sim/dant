import { isRecord } from './contracts.mts';

export type Validator<T> = (value: unknown) => value is T;
export const stringValue: Validator<string> = (value): value is string => typeof value === 'string';
export const booleanValue: Validator<boolean> = (value): value is boolean =>
  typeof value === 'boolean';
export const numberValue: Validator<number> = (value): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export const unknownValue: Validator<unknown> = (_value): _value is unknown => true;
export const optional =
  <T,>(validate: Validator<T>): Validator<T | undefined> =>
  (value): value is T | undefined =>
    value === undefined || validate(value);
export const nullable =
  <T,>(validate: Validator<T>): Validator<T | null> =>
  (value): value is T | null =>
    value === null || validate(value);
export const arrayOf =
  <T,>(validate: Validator<T>): Validator<T[]> =>
  (value): value is T[] =>
    Array.isArray(value) && value.every(validate);
export const recordOf =
  <T,>(validate: Validator<T>): Validator<Record<string, T>> =>
  (value): value is Record<string, T> =>
    isRecord(value) && Object.values(value).every(validate);
export const objectOf =
  <T extends object>(fields: { [Key in keyof T]-?: Validator<T[Key]> }): Validator<T> =>
  (value): value is T => {
    if (!isRecord(value)) return false;
    for (const key in fields) if (!fields[key](value[key])) return false;
    return true;
  };
export function validated<T>(value: unknown, validate: Validator<T>, label: string): T {
  if (!validate(value)) throw Error(`Invalid ${label}`);
  return value;
}
