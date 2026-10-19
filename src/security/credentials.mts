import { isRecord } from '../contracts/json.mts';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { ordinaryDirectory, renameManaged } from '../files/managed-path.mts';

export interface CredentialMetadata {
  id: string;
  name: string;
  service: string;
  username: string;
  createdAt: number;
  updatedAt: number;
}
export interface CredentialEntry extends CredentialMetadata {
  secret: string;
}
export interface CredentialInput {
  id?: unknown;
  name?: unknown;
  service?: unknown;
  username?: unknown;
  secret?: unknown;
}
export interface CredentialRequestInput {
  name?: unknown;
  service?: unknown;
  reason?: unknown;
}
export interface CredentialRequestResult {
  stored: boolean;
  credential: CredentialMetadata;
}
interface PendingCredentialRequest {
  id: string;
  name: string;
  service: string;
  reason: string;
  owner: string;
  isCurrent: () => boolean;
  resolve: (result: CredentialRequestResult) => void;
  reject: (reason: Error) => void;
  promise: Promise<CredentialRequestResult>;
  timer?: ReturnType<typeof setTimeout>;
}
export type CredentialVaultPublic = Pick<
  CredentialVault,
  'list' | 'find' | 'get' | 'upsert' | 'remove' | 'containsSecret' | 'redact'
>;
interface RedactionOptions {
  partial?: boolean;
  additionalSecrets?: readonly string[];
}
const VAULT_ENTRY_LIMIT = 100;
const VAULT_KEY_BYTES = 32;
const VAULT_NONCE_BYTES = 12;
const VAULT_AUTH_TAG_BYTES = 16;

const MAX_FILE = 2 * 1024 * 1024;
function field(value: unknown, name: string, max: number, options?: { optional?: false }): string;
function field(
  value: unknown,
  name: string,
  max: number,
  options: { optional: true },
): string | undefined;
function field(
  value: unknown,
  name: string,
  max: number,
  { optional = false }: { optional?: boolean } = {},
): string | undefined {
  if (optional && value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!optional && !value.trim()) ||
    value.includes('\0')
  )
    throw Error('Invalid credential ' + name + '.');
  return value;
}
const metadata = ({ id, name, service, username, createdAt, updatedAt }: CredentialEntry) => ({
  id,
  name,
  service,
  username,
  createdAt,
  updatedAt,
});
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);

// Streaming subtitles can end midway through a credential. Suppress a matching
// secret prefix before it becomes a complete value in a later transport frame.
function matchingSuffix(text: string, pattern: string) {
  const table = new Uint32Array(pattern.length);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j && pattern[i] !== pattern[j]) j = table[j - 1] ?? 0;
    if (pattern[i] === pattern[j]) j++;
    table[i] = j;
  }
  let matched = 0;
  const tail = text.slice(-pattern.length);
  for (let i = 0; i < tail.length; i++) {
    while (matched && tail[i] !== pattern[matched]) matched = table[matched - 1] ?? 0;
    if (tail[i] === pattern[matched]) matched++;
    if (matched === pattern.length) matched = table[matched - 1] ?? 0;
  }
  return matched;
}
export function redactCredentialText(
  value: unknown,
  secrets: Iterable<string>,
  { partial = false }: { partial?: boolean } = {},
) {
  let result = String(value);
  for (const secret of [...secrets]
    .filter((value) => typeof value === 'string' && value.length >= 4)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[credential redacted]');
    if (partial) {
      const count = matchingSuffix(result, secret);
      if (count >= 4) result = result.slice(0, -count) + '[credential redacted]';
    }
  }
  return result;
}

/** VM-owned encrypted vault. The master key is restricted to the ordinary VM user. */
export class CredentialVault {
  readonly dir: string;
  readonly file: string;
  readonly keyFile: string;
  constructor({ dataDir }: { dataDir: string }) {
    this.dir = path.join(path.resolve(dataDir), 'credentials');
    this.file = path.join(this.dir, 'vault.enc');
    this.keyFile = path.join(this.dir, 'master.key');
  }
  privateFile(file: string, max: number) {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > max ||
      (process.platform !== 'win32' && stat.mode & 0o077)
    )
      throw Error('Invalid credential storage.');
    return stat;
  }
  directory() {
    ordinaryDirectory(this.dir, { create: true });
    const stat = fs.lstatSync(this.dir);
    if (process.platform !== 'win32' && stat.mode & 0o077)
      throw Error('Invalid credential storage.');
  }
  key(create = false) {
    this.directory();
    if (!fs.existsSync(this.keyFile)) {
      if (!create || fs.existsSync(this.file))
        throw Error('Credential storage cannot be unlocked.');
      fs.writeFileSync(this.keyFile, randomBytes(VAULT_KEY_BYTES), { flag: 'wx', mode: 0o600 });
    }
    if (this.privateFile(this.keyFile, VAULT_KEY_BYTES).size !== VAULT_KEY_BYTES)
      throw Error('Credential storage cannot be unlocked.');
    return fs.readFileSync(this.keyFile);
  }
  read(): CredentialEntry[] {
    try {
      this.directory();
      if (!fs.lstatSync(this.file, { throwIfNoEntry: false })) return [];
      this.privateFile(this.file, MAX_FILE);
      const key = this.key();
      try {
        const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (
          !isRecord(value) ||
          value.version !== 1 ||
          typeof value.iv !== 'string' ||
          typeof value.tag !== 'string' ||
          typeof value.data !== 'string'
        )
          throw Error();
        const iv = Buffer.from(value.iv, 'base64'),
          tag = Buffer.from(value.tag, 'base64'),
          ciphertext = Buffer.from(value.data, 'base64');
        if (iv.length !== VAULT_NONCE_BYTES || tag.length !== VAULT_AUTH_TAG_BYTES) throw Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from('dant.credentials.v1'));
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        try {
          const entries: unknown = JSON.parse(plain.toString('utf8'));
          if (
            !Array.isArray(entries) ||
            entries.length > VAULT_ENTRY_LIMIT ||
            entries.some((item) => !isCredentialEntry(item))
          )
            throw Error();
          return entries as CredentialEntry[];
        } finally {
          plain.fill(0);
        }
      } finally {
        key.fill(0);
      }
    } catch {
      throw Error('Credential storage cannot be unlocked. Existing data was preserved.');
    }
  }
  write(entries: readonly CredentialEntry[]) {
    let key: Buffer | undefined, plain: Buffer | undefined, temporary: string | undefined;
    try {
      if (entries.length > VAULT_ENTRY_LIMIT) throw Error();
      key = this.key(true);
      plain = Buffer.from(JSON.stringify(entries));
      const iv = randomBytes(VAULT_NONCE_BYTES),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('dant.credentials.v1'));
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const value = JSON.stringify({
        version: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      });
      if (Buffer.byteLength(value) > MAX_FILE) throw Error();
      temporary = path.join(this.dir, '.vault-' + randomUUID() + '.tmp');
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, value);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      renameManaged(temporary, this.file);
    } catch {
      throw Error('The credential could not be saved. Existing data was preserved.');
    } finally {
      key?.fill(0);
      plain?.fill(0);
      if (temporary)
        try {
          fs.unlinkSync(temporary);
        } catch {
          /* Renamed or already absent. */
        }
    }
  }
  list() {
    return this.read().map(metadata);
  }
  find(query: unknown = '') {
    const text = field(query, 'query', 300, { optional: true }) ?? '';
    const value = text.toLowerCase().trim();
    return this.list()
      .filter((item) =>
        [item.name, item.service, item.username].some((part) => part.toLowerCase().includes(value)),
      )
      .slice(0, 50);
  }
  get(id: unknown) {
    if (!validId(id)) throw Error('Invalid credential identifier.');
    const item = this.read().find((item) => item.id === id);
    if (!item) throw Error('Credential not found.');
    return { ...item };
  }
  upsert(input: unknown) {
    if (!isRecord(input)) throw Error('Invalid credential.');
    const entries = this.read();
    let item;
    if (input.id !== undefined) {
      if (!validId(input.id)) throw Error('Invalid credential identifier.');
      item = entries.find((item) => item.id === input.id);
      if (!item) throw Error('Credential not found.');
    }
    const name = field(input.name ?? item?.name, 'name', 100),
      service = field(input.service ?? item?.service ?? '', 'service', 200, { optional: true }),
      username = field(input.username ?? item?.username ?? '', 'username', 300, { optional: true }),
      secret = field(input.secret ?? item?.secret, 'secret', 16384);
    if (!item && entries.length >= 100) throw Error('The credential vault is full.');
    const now = Date.now(),
      updated = {
        id: item?.id || randomUUID(),
        name: name.trim(),
        service: (service ?? '').trim(),
        username: username ?? '',
        secret,
        createdAt: item?.createdAt || now,
        updatedAt: now,
      };
    if (item) entries[entries.indexOf(item)] = updated;
    else entries.push(updated);
    this.write(entries);
    return metadata(updated);
  }
  remove(id: unknown) {
    if (!validId(id)) throw Error('Invalid credential identifier.');
    const entries = this.read(),
      filtered = entries.filter((item) => item.id !== id);
    if (filtered.length === entries.length) throw Error('Credential not found.');
    this.write(filtered);
    return { removed: true, id };
  }
  containsSecret(value: unknown) {
    return this.read().some(
      (item) => item.secret.length >= 4 && String(value).includes(item.secret),
    );
  }
  redact(value: unknown, { partial = false, additionalSecrets = [] }: RedactionOptions = {}) {
    if (
      !Array.isArray(additionalSecrets) ||
      additionalSecrets.some((secret) => typeof secret !== 'string')
    )
      throw Error('Invalid additional redaction values.');
    return redactCredentialText(
      value,
      [...this.read().map((item) => item.secret), ...additionalSecrets],
      { partial },
    );
  }
  toJSON() {
    return { items: this.list() };
  }
}

/** Pending secure forms are ephemeral, owner-scoped, and never become chat messages. */
export class CredentialRequests {
  readonly vault: CredentialVaultPublic;
  readonly change: () => void;
  readonly timeoutMs: number;
  readonly pending: Map<string, PendingCredentialRequest>;
  closed: boolean;
  constructor({
    vault,
    change = () => {},
    timeoutMs = 10 * 60 * 1000,
  }: {
    vault: CredentialVaultPublic;
    change?: () => void;
    timeoutMs?: number;
  }) {
    this.vault = vault;
    this.change = change;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.closed = false;
  }
  snapshot() {
    const requests = [...this.pending.values()].map((item) => ({
      id: item.id,
      name: item.name,
      service: item.service,
      reason: item.reason,
    }));
    try {
      return { items: this.vault.list(), requests };
    } catch {
      return {
        items: [],
        requests,
        error: 'Credential storage cannot be unlocked. Existing data was preserved.',
      };
    }
  }
  find(query: unknown) {
    return this.vault.find(query);
  }
  get(id: unknown) {
    return this.vault.get(id);
  }
  upsert(input: unknown) {
    const item = this.vault.upsert(input);
    this.change();
    return item;
  }
  remove(id: unknown) {
    const result = this.vault.remove(id);
    this.change();
    return result;
  }
  containsSecret(value: unknown) {
    return this.vault.containsSecret(value);
  }
  redact(value: unknown, options?: RedactionOptions) {
    return this.vault.redact(value, options);
  }
  request(
    input: CredentialRequestInput | null | undefined,
    { owner, isCurrent }: { owner?: string; isCurrent?: () => boolean } = {},
  ): Promise<CredentialRequestResult> {
    if (this.closed || typeof owner !== 'string' || typeof isCurrent !== 'function' || !isCurrent())
      return Promise.reject(Error('The credential request is no longer active.'));
    const name = field(input?.name, 'name', 100).trim(),
      service = (field(input?.service ?? '', 'service', 200, { optional: true }) ?? '').trim(),
      reason = field(input?.reason ?? '', 'reason', 500, { optional: true }) ?? '';
    const prior = [...this.pending.values()].find(
      (item) => item.owner === owner && item.name === name && item.service === service,
    );
    if (prior) return prior.promise;
    if (this.pending.size >= 10)
      return Promise.reject(Error('Too many pending credential requests.'));
    let resolve: (result: CredentialRequestResult) => void = () => {};
    let reject: (reason: Error) => void = () => {};
    const promise = new Promise<CredentialRequestResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    promise.catch(() => {});
    const item: PendingCredentialRequest = {
      id: randomUUID(),
      name,
      service,
      reason,
      owner,
      isCurrent,
      resolve,
      reject,
      promise,
    };
    item.timer = setTimeout(() => this.cancel(item.id), this.timeoutMs);
    item.timer.unref?.();
    this.pending.set(item.id, item);
    this.change();
    return promise;
  }
  fulfill(id: string, input: CredentialInput | null | undefined) {
    const request = this.pending.get(id);
    if (!request) throw Error('The credential request is no longer active.');
    if (!request.isCurrent()) {
      this.cancel(id);
      throw Error('The credential request is no longer active.');
    }
    const username = field(input?.username ?? '', 'username', 300, { optional: true }),
      secret = field(input?.secret, 'secret', 16384);
    const existing = this.vault
      .list()
      .find(
        (item) =>
          item.name === request.name &&
          item.service === request.service &&
          item.username === username,
      );
    const item = this.vault.upsert({
      ...(existing ? { id: existing.id } : {}),
      name: request.name,
      service: request.service,
      username,
      secret,
    });
    clearTimeout(request.timer);
    this.pending.delete(id);
    request.resolve({ stored: true, credential: item });
    this.change();
    return { stored: true, credential: item };
  }
  cancel(id: string) {
    const item = this.pending.get(id);
    if (!item) throw Error('The credential request is no longer active.');
    clearTimeout(item.timer);
    this.pending.delete(id);
    item.reject(Error('The credential request was cancelled.'));
    this.change();
    return { cancelled: true };
  }
  cancelOwner(owner: string) {
    for (const item of [...this.pending.values()]) if (item.owner === owner) this.cancel(item.id);
  }
  close() {
    this.closed = true;
    for (const item of [...this.pending.values()]) this.cancel(item.id);
  }
}

function isCredentialEntry(value: unknown): value is CredentialEntry {
  return (
    isRecord(value) &&
    validId(value.id) &&
    typeof value.name === 'string' &&
    typeof value.service === 'string' &&
    typeof value.username === 'string' &&
    typeof value.secret === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}
