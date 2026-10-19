import assert from 'node:assert/strict';
import { observedRecord } from './service-fixtures.mts';
export class TelegramFixtureBody {
  readonly raw: Record<string, unknown> | FormData;
  constructor(value: unknown) {
    this.raw = value instanceof FormData ? value : value === null ? {} : observedRecord(value);
  }
  field(name: string): unknown {
    return this.raw instanceof FormData ? this.raw.get(name) : this.raw[name];
  }
  get text(): string {
    const value = this.field('text');
    assert.ok(typeof value === 'string');
    return value;
  }
  get chat_id(): unknown {
    return this.field('chat_id');
  }
  get file_id(): unknown {
    return this.field('file_id');
  }
  get offset(): unknown {
    return this.field('offset');
  }
  get parse_mode(): unknown {
    return this.field('parse_mode');
  }
  get(name: 'document' | 'photo'): File;
  get(name: string): FormDataEntryValue | null;
  get(name: string): FormDataEntryValue | null {
    assert.ok(this.raw instanceof FormData);
    const value = this.raw.get(name);
    if (name === 'document' || name === 'photo') assert.ok(value instanceof File);
    return value;
  }
  has(name: string): boolean {
    assert.ok(this.raw instanceof FormData);
    return this.raw.has(name);
  }
}
export interface TelegramFixtureCall {
  method: string;
  url: string;
  body: TelegramFixtureBody;
  signal: AbortSignal | null | undefined;
}
export function telegramFixtureText(value: unknown): string {
  assert.ok(typeof value === 'string');
  return value;
}
