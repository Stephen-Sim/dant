import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Readable, PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isRecord, errorCode } from '../contracts/json.mts';
import { ordinaryDirectory } from '../files/managed-path.mts';
import type { HostSecretProtection } from '../platform/host-types.ts';
import type { BackupMetadata } from './backup-types.ts';
import {
  BACKUP_MAX_BYTES,
  BACKUP_SCHEMA_VERSION,
  BACKUP_CATALOG_LIMIT,
} from './backup-constants.mts';
import { backupError, backupId, isBackupMetadata } from './backup-validation.mts';

const MAGIC = Buffer.from('DANT-LOCAL-BACKUP/1\n');
const HEADER_LIMIT = 64 * 1024;
const TAG_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
async function closeFile(handle: fs.promises.FileHandle) {
  try {
    await handle.close();
  } catch (error) {
    if (errorCode(error) !== 'EBADF') throw error;
  }
}
// Includes the base64 stream format, record headers and incompressible input.
const ARCHIVE_LIMIT = BACKUP_MAX_BYTES * 1.5 + 64 * 1024 * 1024;
interface Header {
  schema: number;
  metadata: BackupMetadata;
  wrappedKey: string;
  iv: string;
}
function base64(value: unknown, maximum: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw backupError('backup_invalid');
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length > maximum) throw backupError('backup_invalid');
  return decoded;
}
function header(value: unknown): Header {
  if (
    !isRecord(value) ||
    value.schema !== BACKUP_SCHEMA_VERSION ||
    !isBackupMetadata(value.metadata) ||
    typeof value.wrappedKey !== 'string' ||
    typeof value.iv !== 'string'
  )
    throw backupError('backup_invalid');
  base64(value.wrappedKey, HEADER_LIMIT / 2);
  if (base64(value.iv, IV_BYTES).length !== IV_BYTES) throw backupError('backup_invalid');
  return {
    schema: BACKUP_SCHEMA_VERSION,
    metadata: value.metadata,
    wrappedKey: value.wrappedKey,
    iv: value.iv,
  };
}
function boundedStream() {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > ARCHIVE_LIMIT ? backupError('backup_size_limit') : null, chunk);
    },
  });
}
/** Only encrypted, authenticated snapshots are persisted on the Controller. */
export class LocalBackupVault {
  readonly directory: string;
  readonly protection: HostSecretProtection | undefined;
  constructor(dataDir: string, protection?: HostSecretProtection) {
    this.directory = ordinaryDirectory(path.join(path.resolve(dataDir), 'vm-backups'), {
      create: true,
    });
    this.protection = protection;
  }
  file(id: string) {
    if (!backupId(id)) throw backupError('backup_invalid', 400);
    ordinaryDirectory(this.directory);
    return path.join(this.directory, `${id}.dantbak`);
  }
  privateFile(id: string) {
    const file = this.file(id),
      stat = fs.lstatSync(file, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.size > BigInt(ARCHIVE_LIMIT + HEADER_LIMIT) ||
      stat.size < BigInt(MAGIC.length + 4 + TAG_BYTES)
    )
      throw backupError('backup_invalid');
    return { file, stat };
  }
  readHeader(id: string) {
    const { file, stat } = this.privateFile(id);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw backupError('backup_invalid');
      const prefix = Buffer.alloc(MAGIC.length + 4);
      if (
        fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length ||
        !prefix.subarray(0, MAGIC.length).equals(MAGIC)
      )
        throw backupError('backup_invalid');
      const length = prefix.readUInt32BE(MAGIC.length);
      if (
        !length ||
        length > HEADER_LIMIT ||
        BigInt(prefix.length + length + TAG_BYTES) > stat.size
      )
        throw backupError('backup_invalid');
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, prefix.length) !== length)
        throw backupError('backup_invalid');
      const parsed: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      const value = header(parsed);
      if (value.metadata.id !== id) throw backupError('backup_invalid');
      return { value, bytes, start: prefix.length + length, stat };
    } finally {
      fs.closeSync(fd);
    }
  }
  listResult(): { backups: BackupMetadata[]; invalidCount: number } {
    ordinaryDirectory(this.directory);
    const initial = fs.lstatSync(this.directory, { bigint: true });
    const trusted = () => {
      ordinaryDirectory(this.directory);
      const current = fs.lstatSync(this.directory, { bigint: true });
      if (current.dev !== initial.dev || current.ino !== initial.ino)
        throw backupError('backup_invalid');
    };
    const names = fs.readdirSync(this.directory);
    if (names.length > BACKUP_CATALOG_LIMIT) throw backupError('backup_catalog_limit');
    const backups: BackupMetadata[] = [];
    let invalidCount = 0;
    for (const name of names) {
      if (!name.endsWith('.dantbak')) continue;
      const id = name.slice(0, -'.dantbak'.length);
      try {
        if (!backupId(id)) throw backupError('backup_invalid');
        backups.push(this.readHeader(id).value.metadata);
      } catch {
        // Isolate only an unreadable entry. A replaced or linked vault is not a catalog.
        trusted();
        invalidCount++;
      }
      trusted();
    }
    trusted();
    return { backups: backups.sort((a, b) => b.createdAt - a.createdAt), invalidCount };
  }
  list(): BackupMetadata[] {
    return this.listResult().backups;
  }
  async save(input: Readable, metadata: BackupMetadata, signal?: AbortSignal) {
    if (!this.protection) throw backupError('backup_protection_unavailable');
    if (!isBackupMetadata(metadata)) throw backupError('backup_invalid');
    const destination = this.file(metadata.id),
      temporary = path.join(this.directory, `.${randomUUID()}.partial`);
    if (fs.existsSync(destination)) throw backupError('backup_exists');
    const key = randomBytes(KEY_BYTES),
      iv = randomBytes(IV_BYTES);
    let handle: fs.promises.FileHandle | undefined;
    try {
      const wrappedKey = await this.protection.protect(key.toString('hex'));
      const bytes = Buffer.from(
        JSON.stringify({
          schema: BACKUP_SCHEMA_VERSION,
          metadata,
          wrappedKey: wrappedKey.toString('base64'),
          iv: iv.toString('base64'),
        }),
      );
      if (bytes.length > HEADER_LIMIT) throw backupError('backup_invalid');
      const prefix = Buffer.alloc(MAGIC.length + 4);
      MAGIC.copy(prefix);
      prefix.writeUInt32BE(bytes.length, MAGIC.length);
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(Buffer.concat([prefix, bytes]));
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(bytes);
      await pipeline(
        input,
        boundedStream(),
        cipher,
        fs.createWriteStream(temporary, {
          fd: handle.fd,
          start: prefix.length + bytes.length,
          autoClose: false,
        }),
        { signal },
      );
      const stat = await handle.stat();
      await handle.write(cipher.getAuthTag(), 0, TAG_BYTES, stat.size);
      await handle.sync();
      await closeFile(handle);
      handle = undefined;
      ordinaryDirectory(this.directory);
      if (fs.existsSync(destination)) throw backupError('backup_exists');
      await fs.promises.rename(temporary, destination);
      return metadata;
    } finally {
      key.fill(0);
      try {
        if (handle) await closeFile(handle);
      } finally {
        await fs.promises.rm(temporary, { force: true });
      }
    }
  }
  /** Authenticate every byte before exposing plaintext to a restore transport. */
  async open(id: string, signal?: AbortSignal) {
    if (!this.protection) throw backupError('backup_protection_unavailable');
    const inspected = this.readHeader(id),
      { file } = this.privateFile(id);
    const handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let key: Buffer | undefined;
    try {
      const initial = await handle.stat({ bigint: true });
      if (
        initial.ino !== inspected.stat.ino ||
        initial.dev !== inspected.stat.dev ||
        initial.mtimeNs !== inspected.stat.mtimeNs
      )
        throw backupError('backup_invalid');
      const secret = await this.protection.unprotect(
        base64(inspected.value.wrappedKey, HEADER_LIMIT / 2),
      );
      if (!/^[0-9a-f]{64}$/.test(secret)) throw backupError('backup_invalid');
      key = Buffer.from(secret, 'hex');
      const tag = Buffer.alloc(TAG_BYTES);
      const size = Number(initial.size);
      if ((await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES)).bytesRead !== TAG_BYTES)
        throw backupError('backup_invalid');
      const decode = () => {
        if (!key) throw backupError('backup_invalid');
        const decipher = createDecipheriv('aes-256-gcm', key, base64(inspected.value.iv, IV_BYTES));
        decipher.setAAD(inspected.bytes);
        decipher.setAuthTag(tag);
        return decipher;
      };
      await pipeline(
        fs.createReadStream(file, {
          fd: handle.fd,
          start: inspected.start,
          end: size - TAG_BYTES - 1,
          autoClose: false,
        }),
        decode(),
        boundedStream(),
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        { signal },
      );
      const unchanged = async () => {
        const current = await handle.stat({ bigint: true });
        ordinaryDirectory(this.directory);
        const named = fs.lstatSync(file, { bigint: true });
        if (
          !named.isFile() ||
          named.isSymbolicLink() ||
          named.ino !== initial.ino ||
          named.dev !== initial.dev ||
          current.size !== initial.size ||
          current.mtimeNs !== initial.mtimeNs ||
          current.ctimeNs !== initial.ctimeNs
        )
          throw backupError('backup_invalid');
      };
      await unchanged();
      const decryptedKey = key;
      let closed = false,
        started = false;
      return {
        metadata: inspected.value.metadata,
        archiveBytes: size - inspected.start - TAG_BYTES,
        stream: () => {
          if (closed || started) throw backupError('backup_invalid');
          started = true;
          const source = fs.createReadStream(file, {
            fd: handle.fd,
            start: inspected.start,
            end: size - TAG_BYTES - 1,
            autoClose: false,
          });
          const decipher = decode();
          const stream = new PassThrough();
          const guard = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              callback(null, chunk);
            },
            final(callback) {
              void unchanged().then(
                () => callback(),
                () => callback(backupError('backup_invalid')),
              );
            },
          });
          // The final file-identity check precedes EOF seen by the receiver.
          void pipeline(source, decipher, boundedStream(), guard, stream, { signal }).catch(() =>
            stream.destroy(backupError('backup_invalid')),
          );
          return stream;
        },
        close: async () => {
          if (closed) return;
          closed = true;
          decryptedKey.fill(0);
          key = undefined;
          await closeFile(handle);
        },
      };
    } catch {
      key?.fill(0);
      await closeFile(handle);
      throw backupError('backup_invalid');
    }
  }
  retain(count: number) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100)
      throw backupError('backup_settings_invalid');
    const bySource = new Map<string, number>();
    for (const entry of this.list()) {
      const retained = bySource.get(entry.source) ?? 0;
      bySource.set(entry.source, retained + 1);
      if (retained < count) continue;
      this.privateFile(entry.id);
      fs.unlinkSync(this.file(entry.id));
    }
  }
}
