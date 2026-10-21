import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parseAst } from 'rollup/parseAst';
import { isRecord } from '../core/manifest-json.mts';
import { resolveGoToolchain } from '../core/go.mts';
import type { GoRunner, GoToolchain } from '../core/go.mts';
import {
  ConnectionStatus,
  ContinuationDispatchPhase,
  PlanStepStatus,
  ServiceUpdateStatus,
  SubmissionStatus,
  TaskPriority,
  TaskProgressStage,
  TaskStatus,
  MemoryEntryStatus,
  BackupMode,
  BackupPhase,
} from '../../ui/shared/states.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Browser adopters retain their AST gate. The former backend adopters are now
// recursively checked in Go by core/internal/devcheck, not silently removed.
const taskDomains = Object.freeze([
  ContinuationDispatchPhase,
  PlanStepStatus,
  SubmissionStatus,
  TaskPriority,
  TaskProgressStage,
  TaskStatus,
]);
type Domain = Readonly<Record<string, string>>;
interface ContractRule {
  file: string;
  domains: readonly Domain[];
}
const stateContractRules: readonly ContractRule[] = Object.freeze([
  { file: 'ui/settings/vm-backups.mts', domains: [BackupMode, BackupPhase] },
  { file: 'ui/chat/chat-collections.mts', domains: [ConnectionStatus] },
  { file: 'ui/settings/memory-settings.mts', domains: [MemoryEntryStatus] },
  { file: 'ui/settings/memory-management-contracts.mts', domains: [MemoryEntryStatus] },
  {
    file: 'ui/app/recovery-settings.mts',
    domains: [BackupMode, BackupPhase, ConnectionStatus, ServiceUpdateStatus],
  },
]);
export const stateContractModules = Object.freeze(stateContractRules.map((rule) => rule.file));
function literalPropertyKey(
  node: Record<string, unknown>,
  parent: Record<string, unknown> | undefined,
): boolean {
  return (
    parent?.key === node &&
    !parent.computed &&
    [
      'Property',
      'TSPropertySignature',
      'MethodDefinition',
      'PropertyDefinition',
      'TSMethodSignature',
    ].includes(typeof parent.type === 'string' ? parent.type : '')
  );
}
export function rawStateLiterals(
  source: string,
  domains: readonly Domain[] = taskDomains,
): { value: string; line: number }[] {
  const values = new Set(domains.flatMap((domain) => Object.values(domain)));
  const found: { value: string; line: number }[] = [];
  // Native erasure preserves source positions and rejects non-erasable syntax.
  const tree = parseAst(stripTypeScriptTypes(source));
  function visit(node: unknown, parent?: Record<string, unknown>): void {
    if (!isRecord(node)) return;
    if (
      node.type === 'Literal' &&
      typeof node.value === 'string' &&
      values.has(node.value) &&
      !literalPropertyKey(node, parent)
    )
      found.push({
        value: node.value,
        line: source.slice(0, typeof node.start === 'number' ? node.start : 0).split('\n').length,
      });
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach((child) => visit(child, node));
      else if (value && typeof value === 'object') visit(value, node);
  }
  visit(tree);
  return found;
}
export function checkUIStateContracts(projectRoot = root): string[] {
  const failures = [];
  for (const { file, domains } of stateContractRules) {
    const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    for (const item of rawStateLiterals(source, domains))
      failures.push(
        `${file}:${item.line}: use the named domain enum instead of ${JSON.stringify(item.value)}`,
      );
  }
  return failures;
}

export interface GoStateReport {
  checkedFiles: number;
  violations: { file: string; line: number; column: number; value: string }[];
}

function readGoStateReport(raw: string): GoStateReport {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.checkedFiles) ||
    typeof value.checkedFiles !== 'number' ||
    value.checkedFiles < 1 ||
    !Array.isArray(value.violations)
  )
    throw Error('The Go state contract report is invalid.');
  const violations: GoStateReport['violations'] = [];
  for (const item of value.violations) {
    if (
      !isRecord(item) ||
      typeof item.file !== 'string' ||
      !/^core\/internal\/[a-zA-Z0-9_/-]+\.go$/.test(item.file) ||
      item.file.includes('//') ||
      typeof item.line !== 'number' ||
      !Number.isSafeInteger(item.line) ||
      item.line < 1 ||
      typeof item.column !== 'number' ||
      !Number.isSafeInteger(item.column) ||
      item.column < 1 ||
      typeof item.value !== 'string' ||
      item.value.length > 128
    )
      throw Error('The Go state contract report is invalid.');
    violations.push({
      file: item.file,
      line: item.line,
      column: item.column,
      value: item.value,
    });
  }
  return { checkedFiles: value.checkedFiles, violations };
}

export function checkGoStateContracts(
  projectRoot = root,
  {
    run = spawnSync,
    toolchain = resolveGoToolchain,
  }: { run?: GoRunner; toolchain?: (projectRoot: string) => GoToolchain } = {},
): GoStateReport {
  const compiler = toolchain(projectRoot);
  const result = run(compiler.go, ['run', '-p=1', './cmd/dant-checks', '--root', projectRoot], {
    cwd: path.join(projectRoot, 'core'),
    env: compiler.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (result.error || (result.status !== 0 && result.status !== 1) || !result.stdout)
    throw Error('The Go state contract check could not be completed.');
  const report = readGoStateReport(result.stdout);
  if (result.status !== 0 && report.violations.length === 0)
    throw Error('The Go state contract check could not be completed.');
  return report;
}

export function checkStateContracts(
  projectRoot = root,
  checkGo: (projectRoot: string) => GoStateReport = checkGoStateContracts,
): string[] {
  const failures = checkUIStateContracts(projectRoot);
  const report = checkGo(projectRoot);
  for (const item of report.violations)
    failures.push(
      `${item.file}:${item.line}:${item.column}: use the named domain enum instead of ${JSON.stringify(item.value)}`,
    );
  return failures;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const failures = checkStateContracts();
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else console.log(`Browser and recursive Go state contracts checked.`);
  } catch {
    console.error('State contract checks could not be completed.');
    process.exitCode = 1;
  }
}
