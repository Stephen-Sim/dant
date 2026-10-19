import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { Readable, PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isRecord, errorCode } from '../contracts/json.mts';
import { ordinaryDirectory } from '../files/managed-path.mts';
import { BACKUP_MAX_BYTES } from './backup-constants.mts';
import { backupError, isBackupMetadata } from './backup-validation.mts';
import { inspectPortableArchive, portableArchiveStream } from './portable-archive.mts';
import type { BackupMetadata } from './backup-types.ts';
import type { PortableExportInput, PortableImportInput } from './portable-backup-types.ts';

const MAGIC = Buffer.from('DANT-PORTABLE-BACKUP/1\n');
const SCHEMA_VERSION = 1;
const HEADER_LIMIT = 8192;
const LENGTH_BYTES = 4;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const SCRYPT_N = 65536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 128 * 1024 * 1024;
const ARCHIVE_LIMIT = BACKUP_MAX_BYTES * 1.5 + 64 * 1024 * 1024;
export const PORTABLE_PASSPHRASE_MIN_BYTES = 12;
export const PORTABLE_PASSPHRASE_MAX_BYTES = 1024;
export const PORTABLE_MAX_FILE_BYTES =
  ARCHIVE_LIMIT + HEADER_LIMIT + MAGIC.length + LENGTH_BYTES + TAG_BYTES;
let deriving = false;
interface PortableHeader {
  schema: 1;
  cipher: 'aes-256-gcm';
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  metadata: BackupMetadata;
  archiveBytes: number;
}
interface Staged {
  file: string;
  fd: number;
  header: PortableHeader;
  aad: Buffer;
  start: number;
  size: number;
  directory: fs.BigIntStats;
  stat: fs.BigIntStats;
}
const invalid = () => backupError('backup_invalid', 400);
const keys = (value: object, allowed: readonly string[]) =>
  Object.keys(value).length === allowed.length &&
  Object.keys(value).every((key) => allowed.includes(key));
function base64(value: unknown, size: number) {
  if (
    typeof value !== 'string' ||
    value.length !== 4 * Math.ceil(size / 3) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw invalid();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== size || decoded.toString('base64') !== value) throw invalid();
  return decoded;
}
function metadata(value: BackupMetadata): BackupMetadata {
  return {
    id: value.id,
    createdAt: value.createdAt,
    appVersion: value.appVersion,
    bytes: value.bytes,
    files: value.files,
    source: value.source,
  };
}
function readHeader(value: unknown): PortableHeader {
  if (
    !isRecord(value) ||
    !keys(value, ['schema', 'cipher', 'kdf', 'iv', 'metadata', 'archiveBytes']) ||
    value.schema !== SCHEMA_VERSION ||
    value.cipher !== 'aes-256-gcm' ||
    !isRecord(value.kdf) ||
    !keys(value.kdf, ['name', 'N', 'r', 'p', 'salt']) ||
    value.kdf.name !== 'scrypt' ||
    value.kdf.N !== SCRYPT_N ||
    value.kdf.r !== SCRYPT_R ||
    value.kdf.p !== SCRYPT_P ||
    typeof value.kdf.salt !== 'string' ||
    typeof value.iv !== 'string' ||
    !isBackupMetadata(value.metadata) ||
    !keys(value.metadata, ['id', 'createdAt', 'appVersion', 'bytes', 'files', 'source']) ||
    typeof value.archiveBytes !== 'number' ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes <= 0
  )
    throw invalid();
  if (value.archiveBytes > ARCHIVE_LIMIT) throw backupError('backup_size_limit', 400);
  base64(value.kdf.salt, SALT_BYTES);
  base64(value.iv, IV_BYTES);
  return {
    schema: 1,
    cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: value.kdf.salt },
    iv: value.iv,
    metadata: metadata(value.metadata),
    archiveBytes: value.archiveBytes,
  };
}
function password(value: unknown) {
  if (typeof value !== 'string') throw backupError('backup_passphrase_invalid', 400);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < PORTABLE_PASSPHRASE_MIN_BYTES || bytes > PORTABLE_PASSPHRASE_MAX_BYTES)
    throw backupError('backup_passphrase_invalid', 400);
  return Buffer.from(value, 'utf8');
}
async function derive(secret: Buffer, salt: Buffer) {
  if (deriving) throw backupError('backup_busy');
  deriving = true;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        secret,
        salt,
        KEY_BYTES,
        { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
        (error, key) => (error ? reject(invalid()) : resolve(key)),
      ),
    );
  } finally {
    deriving = false;
    secret.fill(0);
  }
}
function close(fd: number) {
  try {
    fs.closeSync(fd);
  } catch (error) {
    if (errorCode(error) !== 'EBADF') throw error;
  }
}
function write(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}
function bound(expected: number) {
  let length = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      callback(length > expected ? backupError('backup_size_limit', 400) : null, chunk);
    },
    flush(callback) {
      callback(length === expected ? null : invalid());
    },
  });
}
/** Portable ciphertext uses a password-derived key, never a host identity or embedded key. */
export class PortableBackup {
  readonly directory: string;
  constructor(dataDir: string) {
    this.directory = ordinaryDirectory(path.join(path.resolve(dataDir), 'portable-transfers'), {
      create: true,
    });
  }
  private unchanged(staged: Staged) {
    ordinaryDirectory(this.directory);
    const directory = fs.lstatSync(this.directory, { bigint: true }),
      named = fs.lstatSync(staged.file, { bigint: true }),
      opened = fs.fstatSync(staged.fd, { bigint: true });
    if (
      directory.dev !== staged.directory.dev ||
      directory.ino !== staged.directory.ino ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      named.dev !== staged.stat.dev ||
      named.ino !== staged.stat.ino ||
      opened.dev !== staged.stat.dev ||
      opened.ino !== staged.stat.ino ||
      opened.size !== staged.stat.size ||
      opened.mtimeNs !== staged.stat.mtimeNs ||
      opened.ctimeNs !== staged.stat.ctimeNs
    )
      throw invalid();
  }
  private cleanup(staged: Pick<Staged, 'file' | 'fd' | 'directory' | 'stat'>) {
    try {
      const opened = fs.fstatSync(staged.fd, { bigint: true });
      if (opened.dev !== staged.stat.dev || opened.ino !== staged.stat.ino) throw invalid();
    } catch (error) {
      if (errorCode(error) !== 'EBADF') throw error;
    }
    close(staged.fd);
    ordinaryDirectory(this.directory);
    const directory = fs.lstatSync(this.directory, { bigint: true }),
      named = fs.lstatSync(staged.file, { bigint: true, throwIfNoEntry: false });
    if (
      directory.dev !== staged.directory.dev ||
      directory.ino !== staged.directory.ino ||
      (named &&
        (named.dev !== staged.stat.dev ||
          named.ino !== staged.stat.ino ||
          !named.isFile() ||
          named.isSymbolicLink()))
    )
      throw invalid();
    if (named) fs.unlinkSync(staged.file);
  }
  private async stage(input: Readable, signal?: AbortSignal): Promise<Staged> {
    ordinaryDirectory(this.directory);
    const directory = fs.lstatSync(this.directory, { bigint: true }),
      file = path.join(this.directory, `.${randomUUID()}.portable`),
      fd = fs.openSync(file, 'wx+', 0o600);
    const identity = fs.fstatSync(fd, { bigint: true });
    let head = Buffer.alloc(0),
      size = 0,
      start = 0,
      header: PortableHeader | undefined;
    const abort = () => {
      input.destroy(backupError('backup_failed'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      for await (const value of input) {
        signal?.throwIfAborted();
        if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw invalid();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > PORTABLE_MAX_FILE_BYTES) throw backupError('backup_size_limit', 400);
        if (!header) {
          head = Buffer.concat([
            head,
            chunk.subarray(
              0,
              Math.max(0, MAGIC.length + LENGTH_BYTES + HEADER_LIMIT - head.length),
            ),
          ]);
          if (head.length >= MAGIC.length + LENGTH_BYTES) {
            if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid();
            const length = head.readUInt32BE(MAGIC.length);
            if (!length || length > HEADER_LIMIT) throw invalid();
            start = MAGIC.length + LENGTH_BYTES + length;
            if (head.length >= start)
              header = readHeader(
                JSON.parse(
                  new TextDecoder('utf8', { fatal: true }).decode(
                    head.subarray(MAGIC.length + LENGTH_BYTES, start),
                  ),
                ),
              );
          }
        }
        if (header && size > start + header.archiveBytes + TAG_BYTES) throw invalid();
        write(fd, chunk);
      }
      if (!header || size !== start + header.archiveBytes + TAG_BYTES) throw invalid();
      fs.fsyncSync(fd);
      const staged = {
        file,
        fd,
        header,
        aad: head.subarray(0, start),
        start,
        size,
        directory,
        stat: fs.fstatSync(fd, { bigint: true }),
      };
      this.unchanged(staged);
      return staged;
    } catch (error) {
      this.cleanup({ file, fd, directory, stat: identity });
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private async plaintext<Value>(
    staged: Staged,
    key: Buffer,
    consume: (stream: Readable) => Promise<Value>,
    signal?: AbortSignal,
  ) {
    this.unchanged(staged);
    const tag = Buffer.alloc(TAG_BYTES);
    if (fs.readSync(staged.fd, tag, 0, TAG_BYTES, staged.size - TAG_BYTES) !== TAG_BYTES)
      throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', key, base64(staged.header.iv, IV_BYTES));
    decipher.setAAD(staged.aad);
    decipher.setAuthTag(tag);
    const stream = new PassThrough();
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(null, chunk);
      },
      final: (callback) => {
        try {
          this.unchanged(staged);
          callback();
        } catch {
          callback(invalid());
        }
      },
    });
    const task = pipeline(
      fs.createReadStream(staged.file, {
        fd: staged.fd,
        start: staged.start,
        end: staged.size - TAG_BYTES - 1,
        autoClose: false,
      }),
      decipher,
      bound(staged.header.archiveBytes),
      guard,
      stream,
      { signal },
    );
    void task.catch(() => {});
    try {
      const value = await consume(stream);
      await task;
      return value;
    } finally {
      stream.destroy();
      await task.catch(() => {});
    }
  }
  async export({
    vault,
    id,
    passphrase,
    output,
    signal,
  }: PortableExportInput): Promise<BackupMetadata> {
    const secret = password(passphrase);
    let key: Buffer | undefined;
    try {
      const first = await vault.open(id, signal);
      const originalMetadata = metadata(first.metadata);
      let plan;
      try {
        if (first.archiveBytes > ARCHIVE_LIMIT) throw backupError('backup_size_limit', 400);
        plan = await inspectPortableArchive(first.stream(), first.metadata);
      } finally {
        await first.close();
      }
      const second = await vault.open(id, signal);
      try {
        if (JSON.stringify(metadata(second.metadata)) !== JSON.stringify(originalMetadata))
          throw invalid();
        const exported = {
          ...metadata(second.metadata),
          files: plan.manifest.files,
          bytes: plan.manifest.bytes,
        };
        if (!isBackupMetadata(exported) || plan.archiveBytes > ARCHIVE_LIMIT) throw invalid();
        const salt = randomBytes(SALT_BYTES),
          iv = randomBytes(IV_BYTES);
        key = await derive(secret, salt);
        signal?.throwIfAborted();
        const header: PortableHeader = {
          schema: 1,
          cipher: 'aes-256-gcm',
          kdf: {
            name: 'scrypt',
            N: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            salt: salt.toString('base64'),
          },
          iv: iv.toString('base64'),
          metadata: exported,
          archiveBytes: plan.archiveBytes,
        };
        const bytes = Buffer.from(JSON.stringify(header));
        if (bytes.length > HEADER_LIMIT) throw invalid();
        const prefix = Buffer.alloc(MAGIC.length + LENGTH_BYTES);
        MAGIC.copy(prefix);
        prefix.writeUInt32BE(bytes.length, MAGIC.length);
        const aad = Buffer.concat([prefix, bytes]),
          cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad);
        const encrypt = new Transform({
          construct(callback) {
            this.push(aad);
            callback();
          },
          transform(chunk: Buffer, _encoding, callback) {
            try {
              callback(null, cipher.update(chunk));
            } catch {
              callback(invalid());
            }
          },
          flush(callback) {
            try {
              this.push(cipher.final());
              this.push(cipher.getAuthTag());
              callback();
            } catch {
              callback(invalid());
            }
          },
        });
        await pipeline(
          portableArchiveStream(second.stream(), plan),
          bound(plan.archiveBytes),
          encrypt,
          output,
          { signal },
        );
        return exported;
      } finally {
        await second.close();
      }
    } finally {
      secret.fill(0);
      key?.fill(0);
    }
  }
  async import({ vault, input, passphrase, signal }: PortableImportInput): Promise<BackupMetadata> {
    const secret = password(passphrase);
    let staged: Staged | undefined, key: Buffer | undefined;
    try {
      staged = await this.stage(input, signal);
      key = await derive(secret, base64(staged.header.kdf.salt, SALT_BYTES));
      signal?.throwIfAborted();
      const ready = staged;
      await this.plaintext(
        ready,
        key,
        (stream) => inspectPortableArchive(stream, ready.header.metadata, true),
        signal,
      );
      return await this.plaintext(
        ready,
        key,
        (stream) => vault.save(stream, ready.header.metadata, signal),
        signal,
      );
    } catch (error) {
      if (
        [
          'backup_protection_unavailable',
          'backup_exists',
          'backup_busy',
          'backup_size_limit',
        ].includes(errorCode(error) ?? '')
      )
        throw error;
      throw invalid();
    } finally {
      secret.fill(0);
      key?.fill(0);
      if (staged) this.cleanup(staged);
    }
  }
}
