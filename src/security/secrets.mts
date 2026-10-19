import { errorCode } from '../contracts/json.mts';
import type { SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
interface DpapiChild {
  on(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  kill(): unknown;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
}
export type DpapiSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => DpapiChild;
import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

const MIN_KEY_BYTES = 16;
const DPAPI_TIMEOUT_MS = 15000;
const MAX_KEY_BYTES = 4096,
  MAX_BLOB_BYTES = 64 * 1024;

// This fixed script contains no credentials. Sensitive values enter through
// stdin only. Decryption returns a one-time-pad-wrapped value, so child stdout
// never contains the plaintext API key either.
const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$plain=$null
$mask=$null
try {
  Add-Type -AssemblyName System.Security | Out-Null
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $entropy=[Text.Encoding]::UTF8.GetBytes('dant.voice-key.dpapi.v1')
  $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.mode -eq 'protect') {
    $plain=[Text.Encoding]::UTF8.GetBytes([string]$request.value)
    if ($plain.Length -lt 16 -or $plain.Length -gt 4096) { throw 'Invalid length' }
    $blob=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,$scope)
    [Console]::Out.Write([Convert]::ToBase64String($blob))
  } elseif ($request.mode -eq 'unprotect') {
    $blob=[Convert]::FromBase64String([string]$request.blob)
    $mask=[Convert]::FromBase64String([string]$request.mask)
    $plain=[Security.Cryptography.ProtectedData]::Unprotect($blob,$entropy,$scope)
    if ($plain.Length -lt 16 -or $plain.Length -gt 4096 -or $mask.Length -ne 4096) { throw 'Invalid length' }
    for ($i=0; $i -lt $plain.Length; $i++) { $plain[$i]=$plain[$i] -bxor $mask[$i] }
    [Console]::Out.Write([Convert]::ToBase64String($plain))
  } else { throw 'Unknown operation' }
} catch {
  [Console]::Error.Write('Windows credential protection failed.')
  exit 1
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
  if ($null -ne $mask) { [Array]::Clear($mask,0,$mask.Length) }
}
`;

export function validateApiKey(value: unknown) {
  if (typeof value !== 'string') throw Error('API key must be text.');
  const key = value.trim();
  // Accept modern project keys and future printable token formats. Never put
  // the rejected value in an error message.
  if (key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES || !/^[\x21-\x7e]+$/.test(key))
    throw Error('API key must contain 16–4096 printable characters without spaces.');
  return key;
}

function decodeBase64(value: string, max = MAX_BLOB_BYTES) {
  const text = value.trim();
  if (
    !text ||
    text.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw Error('Invalid protected credential response.');
  const bytes = Buffer.from(text, 'base64');
  if (!bytes.length || bytes.length > max) throw Error('Invalid protected credential response.');
  return bytes;
}

export interface WindowsDpapiOptions {
  spawnProcess?: DpapiSpawner;
  powershellPath?: string;
  timeoutMs?: number;
}
type DpapiRequest =
  { mode: 'protect'; value: string } | { mode: 'unprotect'; blob: string; mask: string };
export interface SecretStoreOptions extends WindowsDpapiOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  protect?: (key: string) => Promise<Buffer>;
  unprotect?: (blob: Buffer) => Promise<string>;
}

export function createWindowsDpapi({
  spawnProcess = spawn,
  powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  ),
  timeoutMs = DPAPI_TIMEOUT_MS,
}: WindowsDpapiOptions = {}) {
  function invoke(request: DpapiRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: DpapiChild | undefined;
      let output = '',
        settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error | null, value = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const fail = () => finish(Error('Windows credential protection is unavailable or failed.'));
      try {
        child = spawnProcess(
          powershellPath,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64'),
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        timer = setTimeout(() => {
          child?.kill();
          fail();
        }, timeoutMs);
        child.on('error', fail);
        if (!child.stdout || !child.stderr || !child.stdin)
          throw Error('Missing credential protection streams.');
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4 + 16) {
            child?.kill();
            fail();
          }
        });
        // Do not relay PowerShell stderr or attach it to errors.
        child.stderr.on('data', () => {});
        child.stdin.on('error', fail);
        child.on('close', (code) => (code === 0 ? finish(null, output) : fail()));
        child.stdin.end(JSON.stringify(request));
      } catch {
        child?.kill();
        fail();
      }
    });
  }
  return {
    async protect(key: unknown) {
      return decodeBase64(await invoke({ mode: 'protect', value: validateApiKey(key) }));
    },
    async unprotect(blob: Buffer) {
      const mask = randomBytes(MAX_KEY_BYTES);
      let wrapped: Buffer | undefined;
      try {
        wrapped = decodeBase64(
          await invoke({
            mode: 'unprotect',
            blob: blob.toString('base64'),
            mask: mask.toString('base64'),
          }),
          MAX_KEY_BYTES,
        );
        for (let i = 0; i < wrapped.length; i++) wrapped[i] = (wrapped[i] ?? 0) ^ (mask[i] ?? 0);
        return validateApiKey(wrapped.toString('utf8'));
      } finally {
        mask.fill(0);
        wrapped?.fill(0);
      }
    },
  };
}

export class VoiceKeyStore {
  #env: NodeJS.ProcessEnv;
  readonly file: string;
  readonly platform: NodeJS.Platform;
  protect: (key: string) => Promise<Buffer>;
  unprotect: (blob: Buffer) => Promise<string>;
  pending: Promise<unknown>;
  constructor(
    dataDir: string,
    {
      platform = process.platform,
      env = process.env,
      protect,
      unprotect,
      ...dpapiOptions
    }: SecretStoreOptions = {},
  ) {
    this.file = path.join(path.resolve(dataDir), 'voice-key.dpapi');
    this.platform = platform;
    this.#env = env;
    this.pending = Promise.resolve();
    const dpapi = createWindowsDpapi(dpapiOptions);
    this.protect = protect || dpapi.protect;
    this.unprotect = unprotect || dpapi.unprotect;
  }
  environmentKey() {
    const value = this.#env.OPENAI_API_KEY;
    if (value == null || value === '') return null;
    return validateApiKey(value);
  }
  stored() {
    if (this.platform !== 'win32') return false;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BLOB_BYTES)
        throw Error('Invalid protected credential file.');
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw Error('Cannot inspect the protected voice credential.');
    }
  }
  status() {
    let environment = false;
    try {
      environment = Boolean(this.environmentKey());
    } catch {}
    const stored = this.stored();
    return {
      configured: stored || environment,
      source: stored ? 'stored' : environment ? 'environment' : null,
      storage: this.platform === 'win32' ? 'windows-dpapi' : 'environment',
    };
  }
  serialize<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  async set(value: unknown) {
    const key = validateApiKey(value);
    if (this.platform !== 'win32')
      throw Error('Saving API keys requires Windows DPAPI. On this platform use OPENAI_API_KEY.');
    return this.serialize(async () => {
      let blob: Buffer;
      try {
        blob = await this.protect(key);
      } catch {
        throw Error('Could not protect the voice API key with Windows DPAPI.');
      }
      if (!Buffer.isBuffer(blob) || !blob.length || blob.length > MAX_BLOB_BYTES)
        throw Error('Invalid protected voice credential.');
      const directory = path.dirname(this.file),
        temporary = path.join(directory, `.voice-key.dpapi.${randomUUID()}.tmp`);
      let handle: FileHandle | null = null;
      try {
        await fs.promises.mkdir(directory, { recursive: true });
        handle = await fs.promises.open(temporary, 'wx', 0o600);
        await handle.writeFile(blob);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporary, this.file);
      } catch {
        throw Error('Could not save the protected voice API key.');
      } finally {
        await handle?.close().catch(() => {});
        await fs.promises.unlink(temporary).catch(() => {});
      }
      return this.status();
    });
  }
  async get() {
    await this.pending;
    if (!this.stored()) return this.environmentKey();
    try {
      return validateApiKey(await this.unprotect(await fs.promises.readFile(this.file)));
    } catch {
      throw Error(
        'Cannot unlock the voice API key for the current Windows user. Save it again or remove it.',
      );
    }
  }
  async clear() {
    return this.serialize(async () => {
      try {
        await fs.promises.unlink(this.file);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT')
          throw Error('Could not remove the protected voice API key.');
      }
      return this.status();
    });
  }
}

export const createSecretStore = (dataDir: string, options?: SecretStoreOptions) =>
  new VoiceKeyStore(dataDir, options);
