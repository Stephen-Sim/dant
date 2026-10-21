import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const MODULE = 'github.com/Stephen-Sim/dant/core/';
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_FILES = 20_000;
const MAX_POWERSHELL_SOURCE_BYTES = 1024 * 1024;
const MAX_EMBEDDED_SCOPES = 1024;
const REPORTS = {
  typescript: '.cache/coverage/typescript/lcov.info',
  go: '.cache/core/coverage.out',
  rust: '.cache/coverage/rust/coverage.json',
  python: '.cache/coverage/python/coverage.json',
  powershell: '.cache/coverage/powershell/coverage.json',
  bash: '.cache/coverage/bash/summary.json',
} as const;
const REPORT_LINKS = {
  typescript: '#all-maintained-typescript-coverage',
  go: '#go-core-statement-coverage',
  rust: '#rust-native-llvm-coverage',
  python: '#python-coverage',
  powershell: '#powershell-command-coverage',
  bash: '#bash-shell-coverage',
} as const;
const LANGUAGES = [
  'TypeScript',
  'JavaScript',
  'Go',
  'Rust',
  'Python',
  'PowerShell',
  'Bash',
] as const;
type Collector = keyof typeof REPORTS;
export type CoverageLanguage = (typeof LANGUAGES)[number];
type Metric = 'lines' | 'branches' | 'functions' | 'statements' | 'regions' | 'commands';
export interface CoverageCount {
  covered: number;
  total: number;
  percent: number | null;
}
export type CoverageMetrics = Partial<Record<Metric, CoverageCount>>;
export interface CoverageInput {
  content: string;
  file: string;
  modifiedMs?: number;
}
export interface CoverageInventoryOptions {
  root: string;
  platform?: NodeJS.Platform;
  trackedFiles?: readonly string[];
  reports?: Partial<Record<Collector, CoverageInput>>;
  reportLinks?: Partial<Record<Collector, string>>;
  source?: { commit: string; dirty: boolean };
}
export interface CoverageInventoryFile {
  file: string;
  language: CoverageLanguage;
  generated: boolean;
  status: 'measured' | 'not-measured';
  reason?: string;
  metrics?: CoverageMetrics;
}
export interface EmbeddedCoverageScope {
  sourceFile: string;
  startLine: number;
  endLine: number;
  language: 'C#';
  status: 'not-measured';
  reason: string;
  sourceSHA256: string;
  bodySHA256: string;
}
export interface CoverageInventory {
  schemaVersion: 1;
  platform: NodeJS.Platform;
  sourceCommit: string | null;
  sourceDirty: boolean | null;
  target: 'Close to 100% through meaningful behavior and failure tests';
  files: CoverageInventoryFile[];
  embeddedScopes: EmbeddedCoverageScope[];
  excluded: { file: string; reason: string }[];
  reports: {
    collector: Collector;
    file: string;
    status: 'available' | 'missing' | 'invalid';
    link?: string;
    sha256?: string;
    modifiedMs?: number;
  }[];
  languages: {
    language: CoverageLanguage;
    files: number;
    measured: number;
    unmeasured: number;
    metrics: CoverageMetrics;
  }[];
  failures: string[];
}

function requireInventory(condition: unknown): asserts condition {
  if (!condition) throw Error('The source coverage inventory is incomplete or invalid.');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface PowerShellToken {
  kind: 'word' | 'literal' | 'here' | 'boundary';
  value: string;
  line: number;
  endLine?: number;
}

/** Recognizes direct source definitions without executing PowerShell or its CLR adapters. */
function embeddedPowerShellScopes(sourceFile: string, source: string): EmbeddedCoverageScope[] {
  const tokens: PowerShellToken[] = [];
  let offset = 0,
    line = 1;
  const advance = (end: number) => {
    for (; offset < end; offset++) if (source[offset] === '\n') line++;
  };
  const ambiguousInterpolation = (value: string) => {
    requireInventory(!value.includes('$(') || !/\bAdd-Type\b[\s\S]*-TypeDefinition\b/i.test(value));
  };
  while (offset < source.length) {
    const character = source[offset];
    if (character === '\n') {
      tokens.push({ kind: 'boundary', value: '\n', line });
      advance(offset + 1);
    } else if (/\s/.test(character ?? '')) advance(offset + 1);
    else if (source.startsWith('<#', offset)) {
      let depth = 1;
      advance(offset + 2);
      while (offset < source.length && depth) {
        if (source.startsWith('<#', offset)) {
          depth++;
          advance(offset + 2);
        } else if (source.startsWith('#>', offset)) {
          depth--;
          advance(offset + 2);
        } else advance(offset + 1);
      }
      requireInventory(depth === 0);
    } else if (character === '#') {
      const end = source.indexOf('\n', offset);
      advance(end < 0 ? source.length : end);
    } else if (source.startsWith('`\r\n', offset) || source.startsWith('`\n', offset)) {
      advance(offset + (source[offset + 1] === '\r' ? 3 : 2));
    } else if (character === '@' && /['"]/.test(source[offset + 1] ?? '')) {
      const quote = source[offset + 1],
        startLine = line;
      advance(offset + 2);
      requireInventory(source[offset] === '\r' || source[offset] === '\n');
      if (source[offset] === '\r') advance(offset + 1);
      requireInventory(source[offset] === '\n');
      advance(offset + 1);
      const start = offset;
      let closing = -1;
      while (offset < source.length) {
        const end = source.indexOf('\n', offset);
        const physical = source.slice(offset, end < 0 ? source.length : end);
        const delimiter = /^[\t ]*(['"]@)(?=$|[\s;|)}])/.exec(physical);
        if (delimiter?.[1] === quote + '@') {
          closing = offset;
          const body = source.slice(start, closing);
          if (quote === '"') ambiguousInterpolation(body);
          tokens.push({ kind: 'here', value: body, line: startLine, endLine: line });
          advance(offset + delimiter[0].length);
          break;
        }
        advance(end < 0 ? source.length : end + 1);
      }
      requireInventory(closing >= 0);
    } else if (character === "'" || character === '"') {
      const quote = character,
        startLine = line;
      let value = '',
        closed = false;
      advance(offset + 1);
      while (offset < source.length) {
        if (source[offset] === quote) {
          if (source[offset + 1] === quote) {
            value += quote;
            advance(offset + 2);
            continue;
          }
          advance(offset + 1);
          closed = true;
          break;
        }
        if (quote === '"' && source[offset] === '`') {
          advance(offset + 1);
          requireInventory(offset < source.length);
        }
        value += source[offset];
        advance(offset + 1);
      }
      requireInventory(closed);
      if (quote === '"') ambiguousInterpolation(value);
      tokens.push({ kind: 'literal', value, line: startLine });
    } else if (';|{}()=&'.includes(character ?? '')) {
      tokens.push({ kind: 'boundary', value: character ?? '', line });
      advance(offset + 1);
    } else {
      const startLine = line;
      let value = '';
      while (offset < source.length && !/[\s;|{}()=&#'"]/.test(source[offset] ?? '')) {
        if (source[offset] === '`') {
          advance(offset + 1);
          requireInventory(offset < source.length);
        }
        value += source[offset];
        advance(offset + 1);
      }
      requireInventory(value.length > 0);
      tokens.push({ kind: 'word', value, line: startLine });
    }
  }

  const scopes: EmbeddedCoverageScope[] = [];
  const sourceSHA256 = createHash('sha256').update(source).digest('hex');
  for (const [index, token] of tokens.entries()) {
    if (
      !['word', 'literal'].includes(token.kind) ||
      token.value.split('\\').at(-1)?.toLowerCase() !== 'add-type'
    )
      continue;
    let position = index - 1;
    while (
      position >= 0 &&
      ['&', '.', 'return'].includes(tokens[position]?.value.toLowerCase() ?? '')
    )
      position--;
    const previous = tokens[position];
    if (
      previous &&
      (previous.kind !== 'boundary' || !['\n', ';', '|', '{', '(', '='].includes(previous.value))
    )
      continue;
    if (
      token.kind === 'literal' &&
      tokens[index - 1]?.value !== '&' &&
      tokens[index - 1]?.value !== '.'
    )
      continue;

    const arguments_: PowerShellToken[] = [];
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const argument = tokens[cursor];
      if (!argument || argument.kind === 'boundary') break;
      arguments_.push(argument);
    }
    const definition = arguments_.findIndex((argument) =>
      /^-TypeDefinition:?$/i.test(argument.value),
    );
    if (definition < 0) continue;
    const body = arguments_[definition + 1];
    requireInventory(body?.kind === 'here' && body.endLine !== undefined);
    const language = arguments_.findIndex((argument) => /^-Language:?$/i.test(argument.value));
    requireInventory(language < 0 || arguments_[language + 1]?.value.toLowerCase() === 'csharp');
    scopes.push({
      sourceFile,
      startLine: token.line,
      endLine: body.endLine,
      language: 'C#',
      status: 'not-measured',
      reason:
        'Pester measures PowerShell commands, not the embedded CLR body. No C# instrumentation report is available.',
      sourceSHA256,
      bodySHA256: createHash('sha256').update(body.value).digest('hex'),
    });
    requireInventory(scopes.length <= MAX_EMBEDDED_SCOPES);
  }
  return scopes;
}
function count(covered: unknown, total: unknown): CoverageCount {
  requireInventory(typeof covered === 'number' && typeof total === 'number');
  requireInventory(Number.isSafeInteger(covered) && Number.isSafeInteger(total));
  requireInventory(covered >= 0 && total >= covered);
  return { covered, total, percent: total ? (covered / total) * 100 : null };
}
function sourceName(value: string): string {
  requireInventory(
    value.length > 0 && value.length <= 1024 && !value.includes('\\') && !value.includes('\0'),
  );
  requireInventory(/^[A-Za-z0-9_./@+ -]+$/.test(value));
  requireInventory(!path.posix.isAbsolute(value) && !value.includes(':'));
  requireInventory(value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
  return value;
}
function reportName(root: string, value: string): string | undefined {
  const file = value.startsWith(MODULE) ? 'core/' + value.slice(MODULE.length) : value;
  const relative = path.relative(root, path.resolve(root, file)).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
    return;
  return sourceName(relative);
}
function ordinary(file: string, directory = false): fs.Stats {
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    requireInventory(info.isDirectory() && !info.isSymbolicLink());
    if (path.dirname(current) === current) break;
  }
  const info = fs.lstatSync(file);
  requireInventory(
    !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1),
  );
  return info;
}
function boundedRead(file: string, maximum: number): { content: string; modifiedMs: number } {
  const before = ordinary(file);
  requireInventory(before.size <= maximum);
  const bytes = fs.readFileSync(file);
  const content = bytes.toString('utf8');
  requireInventory(Buffer.from(content).equals(bytes));
  const after = ordinary(file);
  requireInventory(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      Buffer.byteLength(content) <= maximum,
  );
  return { content, modifiedMs: before.mtimeMs };
}
function inventoryPaths(root: string): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  requireInventory(!result.error && result.status === 0 && typeof result.stdout === 'string');
  return result.stdout.split('\0').filter(Boolean);
}

function sourceIdentity(root: string): { commit: string; dirty: boolean } {
  const options = {
    cwd: root,
    encoding: 'utf8' as const,
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  };
  const declared = process.env.GITHUB_SHA;
  if (declared !== undefined) requireInventory(/^[a-f0-9]{40}$/.test(declared));
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], options);
  const resolved = !head.error && head.status === 0 ? head.stdout.trim() : undefined;
  const commit = declared ?? resolved;
  requireInventory(commit && /^[a-f0-9]{40}$/.test(commit));
  requireInventory(!declared || !resolved || declared === resolved);
  const status = spawnSync(
    'git',
    ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'],
    options,
  );
  requireInventory(!status.error && status.status === 0 && typeof status.stdout === 'string');
  return { commit, dirty: status.stdout.length > 0 };
}
function classify(file: string): CoverageLanguage | undefined {
  if (/\.(?:mts|ts|tsx)$/.test(file)) return 'TypeScript';
  if (/\.(?:mjs|js|cjs|jsx)$/.test(file)) return 'JavaScript';
  if (file.endsWith('.go')) return 'Go';
  if (file.endsWith('.rs')) return 'Rust';
  if (file.endsWith('.py')) return 'Python';
  if (file.endsWith('.ps1')) return 'PowerShell';
  if (file.endsWith('.sh')) return 'Bash';
  return;
}
function collector(language: CoverageLanguage): Collector | undefined {
  return language === 'TypeScript' || language === 'JavaScript'
    ? 'typescript'
    : language === 'Go'
      ? 'go'
      : language === 'Rust'
        ? 'rust'
        : language === 'Python'
          ? 'python'
          : language === 'PowerShell'
            ? 'powershell'
            : language === 'Bash'
              ? 'bash'
              : undefined;
}
function excludedReason(file: string): string | undefined {
  if (
    !/^(?:ui|scripts|core|src-tauri|native|vm)\//.test(file) &&
    !/^vite\.config\.[a-z]+$/.test(file)
  )
    return 'outside-executable-source-roots';
  if (/(?:^|\/)(?:node_modules|vendor|target|dist|\.cache|\.tools)(?:\/|$)/.test(file))
    return 'dependency-or-generated-output';
  if (
    /(?:^|\/)(?:tests?|testdata|fixtures)(?:\/|$)/.test(file) ||
    /(?:_test\.go|\.(?:test|spec)\.[a-z]+)$/.test(file)
  )
    return 'test-source';
  if (/\.d\.(?:ts|mts|cts)$/.test(file)) return 'type-declaration';
  if (!classify(file)) return 'non-executable-resource-or-configuration';
  return;
}

function parseLcov(content: string, root: string): Map<string, CoverageMetrics> {
  const result = new Map<string, CoverageMetrics>();
  for (const section of content.split('end_of_record')) {
    const fields = new Map<string, string>();
    for (const line of section.trim().split(/\r?\n/)) {
      const split = line.indexOf(':');
      if (split > 0) fields.set(line.slice(0, split), line.slice(split + 1));
    }
    const name = fields.get('SF');
    if (!name) continue;
    const file = reportName(root, name);
    if (!file) continue;
    requireInventory(!result.has(file));
    result.set(file, {
      lines: count(Number(fields.get('LH')), Number(fields.get('LF'))),
      branches: count(Number(fields.get('BRH') ?? 0), Number(fields.get('BRF') ?? 0)),
      functions: count(Number(fields.get('FNH') ?? 0), Number(fields.get('FNF') ?? 0)),
    });
  }
  requireInventory(result.size > 0);
  return result;
}
function parseGo(content: string, root: string): Map<string, CoverageMetrics> {
  const rows = content.trimEnd().split(/\r?\n/);
  requireInventory(
    /^mode: (?:set|count|atomic)$/.test(rows.shift() ?? '') && rows.length <= 1_000_000,
  );
  const blocks = new Map<string, { file: string; total: number; hit: boolean }>();
  for (const row of rows) {
    const matched =
      /^(github\.com\/Stephen-Sim\/dant\/core\/[^:]+\.go):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/.exec(
        row,
      );
    requireInventory(matched?.[1]);
    const file = reportName(root, matched[1]);
    requireInventory(file);
    const positions = matched.slice(2, 6).map(Number);
    requireInventory(positions.every((item) => Number.isSafeInteger(item) && item > 0));
    requireInventory(
      (positions[2] ?? 0) > (positions[0] ?? 0) ||
        (positions[2] === positions[0] && (positions[3] ?? 0) >= (positions[1] ?? 0)),
    );
    const units = count(0, Number(matched[6]));
    const hits = Number(matched[7]);
    requireInventory(Number.isSafeInteger(hits) && hits >= 0);
    const key = matched.slice(1, 6).join(':');
    const previous = blocks.get(key);
    requireInventory(!previous || previous.total === units.total);
    blocks.set(key, { file, total: units.total, hit: !!previous?.hit || hits > 0 });
    requireInventory(blocks.size <= 250_000);
  }
  const result = new Map<string, CoverageMetrics>();
  for (const block of blocks.values()) {
    const previous = result.get(block.file)?.statements ?? count(0, 0);
    result.set(block.file, {
      statements: count(
        previous.covered + (block.hit ? block.total : 0),
        previous.total + block.total,
      ),
    });
  }
  requireInventory(result.size > 0);
  return result;
}
function parseRust(content: string, root: string): Map<string, CoverageMetrics> {
  const value: unknown = JSON.parse(content);
  requireInventory(record(value) && Array.isArray(value.data));
  const result = new Map<string, CoverageMetrics>();
  for (const group of value.data) {
    requireInventory(record(group) && Array.isArray(group.files));
    for (const entry of group.files) {
      requireInventory(
        record(entry) && typeof entry.filename === 'string' && record(entry.summary),
      );
      const file = reportName(root, entry.filename);
      if (!file) continue;
      requireInventory(!result.has(file));
      const metrics: CoverageMetrics = {};
      for (const kind of ['lines', 'functions', 'regions'] as const) {
        const item = entry.summary[kind];
        requireInventory(record(item));
        metrics[kind] = count(item.covered, item.count);
      }
      result.set(file, metrics);
    }
  }
  requireInventory(result.size > 0);
  return result;
}
function parsePython(content: string, root: string): Map<string, CoverageMetrics> {
  const value: unknown = JSON.parse(content);
  requireInventory(
    record(value) &&
      record(value.meta) &&
      value.meta.branch_coverage === true &&
      record(value.files),
  );
  const result = new Map<string, CoverageMetrics>();
  for (const [name, entry] of Object.entries(value.files)) {
    requireInventory(record(entry) && record(entry.summary));
    const file = reportName(root, name);
    if (!file) continue;
    requireInventory(!result.has(file));
    result.set(file, {
      lines: count(entry.summary.covered_lines, entry.summary.num_statements),
      branches: count(entry.summary.covered_branches, entry.summary.num_branches),
    });
  }
  requireInventory(result.size > 0);
  return result;
}

function parsePowerShell(content: string, root: string): Map<string, CoverageMetrics> {
  const value: unknown = JSON.parse(content);
  requireInventory(
    record(value) &&
      value.metric === 'PowerShell executable commands' &&
      value.tool === 'Pester 5.9.0' &&
      typeof value.platform === 'string' &&
      Array.isArray(value.files),
  );
  const result = new Map<string, CoverageMetrics>();
  let covered = 0,
    total = 0;
  for (const entry of value.files) {
    requireInventory(
      record(entry) && typeof entry.file === 'string' && Array.isArray(entry.missingLines),
    );
    requireInventory(
      entry.missingLines.every(
        (line) => typeof line === 'number' && Number.isSafeInteger(line) && line > 0,
      ),
    );
    requireInventory(new Set(entry.missingLines).size === entry.missingLines.length);
    const commands = count(entry.covered, entry.total);
    requireInventory((commands.covered === commands.total) === (entry.missingLines.length === 0));
    const file = reportName(root, entry.file);
    requireInventory(file && file.endsWith('.ps1') && !result.has(file));
    result.set(file, { commands });
    covered += commands.covered;
    total += commands.total;
  }
  requireInventory(result.size > 0 && value.covered === covered && value.total === total);
  return result;
}

function parseBash(content: string, root: string): Map<string, CoverageMetrics> {
  const value: unknown = JSON.parse(content);
  requireInventory(record(value) && value.tool === 'kcov 43' && Array.isArray(value.files));
  const result = new Map<string, CoverageMetrics>();
  let covered = 0,
    total = 0;
  for (const entry of value.files) {
    requireInventory(record(entry) && typeof entry.file === 'string');
    const lines = count(entry.covered, entry.total);
    const file = reportName(root, entry.file);
    requireInventory(file && /^vm\/[\w-]+\.sh$/.test(file) && !result.has(file));
    result.set(file, { lines });
    covered += lines.covered;
    total += lines.total;
  }
  requireInventory(result.size > 0 && value.covered === covered && value.total === total);
  return result;
}
function unmeasuredReason(
  file: string,
  language: CoverageLanguage,
  platform: NodeJS.Platform,
  header: string,
): string {
  if (language === 'Bash')
    return `The kcov Linux shell collector was not measured on ${platform}; syntax and behavior fixtures are not coverage.`;
  if (language === 'PowerShell' && platform !== 'win32')
    return `The Windows PowerShell command collector was not measured on ${platform}.`;
  if (language === 'Go') {
    const os = /_(windows|linux|darwin)(?:_[a-z0-9]+)?\.go$/.exec(file)?.[1];
    if (os && os !== (platform === 'win32' ? 'windows' : platform))
      return `${os}-specific Go source is not measured on ${platform}.`;
    if (platform === 'win32' && /^\/\/go:build !windows\s*$/m.test(header))
      return 'Non-Windows Go source is not measured on win32.';
  }
  return `No matching file measurement was supplied on ${platform}.`;
}

/** Indexes real per-file reports without replacing language-specific gates or inventing missing denominators. */
export function collectCoverageInventory({
  root,
  platform = process.platform,
  trackedFiles,
  reports,
  reportLinks = {},
  source,
}: CoverageInventoryOptions): CoverageInventory {
  requireInventory(path.isAbsolute(root));
  ordinary(root, true);
  if (source)
    requireInventory(/^[a-f0-9]{40}$/.test(source.commit) && typeof source.dirty === 'boolean');
  const paths = [...new Set(trackedFiles ?? inventoryPaths(root))].sort();
  requireInventory(paths.length > 0 && paths.length <= MAX_SOURCE_FILES);
  const inputs = { ...reports };
  const statuses: CoverageInventory['reports'] = [];
  const measurements = new Map<Collector, Map<string, CoverageMetrics>>();
  const failures: string[] = [];
  const parsers = {
    typescript: parseLcov,
    go: parseGo,
    rust: parseRust,
    python: parsePython,
    powershell: parsePowerShell,
    bash: parseBash,
  };
  for (const key of Object.keys(REPORTS) as Collector[]) {
    let input = inputs[key];
    let readFailed = false;
    const file = input?.file ?? REPORTS[key];
    if (reports === undefined && fs.existsSync(path.join(root, file))) {
      try {
        input = { ...boundedRead(path.join(root, file), MAX_REPORT_BYTES), file };
      } catch {
        readFailed = true;
        failures.push(`${key} coverage report could not be read safely.`);
      }
    }
    const status: CoverageInventory['reports'][number] = {
      collector: key,
      file,
      status: input ? 'available' : readFailed ? 'invalid' : 'missing',
    };
    const link = reportLinks[key] ?? REPORT_LINKS[key];
    if (link) {
      requireInventory(
        /^#[a-z0-9-]+$/.test(link) || /^https:\/\/[A-Za-z0-9./_#?=&%-]+$/.test(link),
      );
      status.link = link;
    }
    if (input) {
      try {
        requireInventory(Buffer.byteLength(input.content) <= MAX_REPORT_BYTES);
        status.sha256 = createHash('sha256').update(input.content).digest('hex');
        if (input.modifiedMs !== undefined) {
          requireInventory(Number.isFinite(input.modifiedMs) && input.modifiedMs >= 0);
          status.modifiedMs = input.modifiedMs;
        }
        measurements.set(key, parsers[key](input.content, root));
      } catch {
        status.status = 'invalid';
        failures.push(`${key} coverage report is invalid; no files were credited.`);
      }
    }
    statuses.push(status);
    if (input) inputs[key] = input;
  }
  const files: CoverageInventoryFile[] = [];
  const embeddedScopes: EmbeddedCoverageScope[] = [];
  const excluded: CoverageInventory['excluded'] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const file = sourceName(entry);
    requireInventory(!seen.has(file.toLowerCase()));
    seen.add(file.toLowerCase());
    const reason = excludedReason(file);
    if (reason) {
      excluded.push({ file, reason });
      continue;
    }
    const language = classify(file);
    requireInventory(language);
    const absolute = path.join(root, file);
    const stat = ordinary(absolute);
    const powershell = language === 'PowerShell';
    if (powershell) requireInventory(stat.size <= MAX_POWERSHELL_SOURCE_BYTES);
    const descriptor = fs.openSync(absolute, 'r');
    const buffer = Buffer.alloc(powershell ? stat.size + 1 : 4096);
    let header: string;
    let fullSource: string | undefined;
    try {
      const opened = fs.fstatSync(descriptor);
      requireInventory(
        opened.dev === stat.dev &&
          opened.ino === stat.ino &&
          opened.nlink === 1 &&
          opened.size === stat.size &&
          opened.mtimeMs === stat.mtimeMs &&
          opened.ctimeMs === stat.ctimeMs,
      );
      if (powershell) {
        let received = 0;
        while (received < buffer.length) {
          const length = fs.readSync(
            descriptor,
            buffer,
            received,
            buffer.length - received,
            received,
          );
          if (!length) break;
          received += length;
        }
        requireInventory(received === stat.size && received <= MAX_POWERSHELL_SOURCE_BYTES);
        const bytes = buffer.subarray(0, received);
        fullSource = bytes.toString('utf8');
        requireInventory(Buffer.from(fullSource).equals(bytes));
        header = fullSource.slice(0, 4096);
      } else {
        header = buffer
          .subarray(0, fs.readSync(descriptor, buffer, 0, buffer.length, 0))
          .toString('utf8');
      }
      const after = ordinary(absolute);
      requireInventory(
        after.dev === stat.dev &&
          after.ino === stat.ino &&
          after.size === stat.size &&
          after.mtimeMs === stat.mtimeMs &&
          after.ctimeMs === stat.ctimeMs,
      );
    } finally {
      fs.closeSync(descriptor);
    }
    if (fullSource !== undefined) {
      embeddedScopes.push(...embeddedPowerShellScopes(file, fullSource));
      requireInventory(embeddedScopes.length <= MAX_EMBEDDED_SCOPES);
    }
    const key = collector(language);
    const measurement = key ? measurements.get(key)?.get(file) : undefined;
    const modifiedMs = key ? inputs[key]?.modifiedMs : undefined;
    const fresh = modifiedMs === undefined || modifiedMs >= stat.mtimeMs;
    const measured =
      measurement && Object.values(measurement).some((item) => item.total > 0) && fresh;
    files.push({
      file,
      language,
      generated: /(?:Code generated|@generated|automatically generated)/i.test(header),
      status: measured ? 'measured' : 'not-measured',
      ...(measured
        ? { metrics: measurement }
        : {
            reason: !fresh
              ? 'Source changed after this report was produced.'
              : measurement
                ? 'The report has no executable units for this file; no percentage is inferred.'
                : unmeasuredReason(file, language, platform, header),
          }),
    });
  }
  requireInventory(files.length > 0);
  const languages = LANGUAGES.map((language) => {
    const members = files.filter((file) => file.language === language);
    const metrics: CoverageMetrics = {};
    for (const member of members)
      for (const kind of Object.keys(member.metrics ?? {}) as Metric[]) {
        const item = member.metrics?.[kind];
        if (!item) continue;
        const previous = metrics[kind] ?? count(0, 0);
        metrics[kind] = count(previous.covered + item.covered, previous.total + item.total);
      }
    return {
      language,
      files: members.length,
      measured: members.filter((file) => file.status === 'measured').length,
      unmeasured: members.filter((file) => file.status !== 'measured').length,
      metrics,
    };
  });
  return {
    schemaVersion: 1,
    platform,
    sourceCommit: source?.commit ?? null,
    sourceDirty: source?.dirty ?? null,
    target: 'Close to 100% through meaningful behavior and failure tests',
    files,
    embeddedScopes,
    excluded,
    reports: statuses,
    languages,
    failures,
  };
}

export function coverageInventoryMarkdown(report: CoverageInventory): string {
  const counts = (metrics: CoverageMetrics): string =>
    Object.entries(metrics)
      .map(
        ([kind, value]) =>
          `${kind} ${value.covered}/${value.total} (${value.percent === null ? 'not measured' : value.percent.toFixed(2) + '%'})`,
      )
      .join('; ') || 'Not measured';
  return [
    '# Source coverage inventory',
    '',
    `Platform: ${report.platform}. Target: ${report.target}.`,
    `Source: ${report.sourceCommit ?? 'not supplied'}; dirty checkout: ${report.sourceDirty ?? 'not supplied'}.`,
    '',
    'Percentages below cover only measured files. Missing files have unknown denominators and are never credited as 100%. Different language metrics are not combined.',
    '',
    '| Language | Source files | Measured | Not measured | Measured-file counts |',
    '| --- | ---: | ---: | ---: | --- |',
    ...report.languages
      .filter((item) => item.files)
      .map(
        (item) =>
          `| ${item.language} | ${item.files} | ${item.measured} | ${item.unmeasured} | ${counts(item.metrics)} |`,
      ),
    '',
    '## Reports',
    '',
    ...report.reports.map(
      (item) =>
        `- ${item.link ? `[${item.collector}](${item.link})` : item.collector}: ${item.status}; \`${item.file}\`.`,
    ),
    '',
    '## Unmeasured source',
    '',
    '| File | Reason |',
    '| --- | --- |',
    ...report.files
      .filter((item) => item.status !== 'measured')
      .map((item) => `| ${item.file} | ${item.reason ?? 'Not measured'} |`),
    '',
    '## Embedded source outside instrumentation',
    '',
    'PowerShell command coverage does not instrument embedded CLR code. These C# scopes have no measured percentage and are not credited by the surrounding PowerShell result.',
    '',
    ...(report.embeddedScopes.length
      ? report.embeddedScopes.flatMap((item) => [
          `- [${item.sourceFile}:${item.startLine}](${encodeURI(item.sourceFile)}#L${item.startLine}) — ${item.language}: ${item.status}. ${item.reason}`,
          `  Source SHA256: \`${item.sourceSHA256}\`; body SHA256: \`${item.bodySHA256}\`.`,
        ])
      : ['No direct embedded C# definitions were detected in the maintained PowerShell source.']),
    '',
    `Explicitly classified non-runtime/test/dependency files: ${report.excluded.length}. Full exclusions and per-file counts are in inventory.json.`,
    '',
    ...report.failures.map((failure) => `- ${failure}`),
    '',
  ].join('\n');
}

function main(): void {
  requireInventory(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--always'),
  );
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const report = collectCoverageInventory({ root, source: sourceIdentity(root) });
  const output = path.join(root, '.cache/coverage');
  fs.mkdirSync(output, { recursive: true });
  ordinary(output, true);
  const markdown = coverageInventoryMarkdown(report);
  fs.writeFileSync(path.join(output, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'inventory.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  if (report.failures.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
