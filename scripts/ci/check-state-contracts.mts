import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { parseAst } from 'rollup/parseAst';
import { isRecord } from '../../src/contracts/json.mts';
import {
  ComputerControlStatus,
  ConnectionStatus,
  ContinuationDispatchPhase,
  DesktopPhase,
  PlanStepStatus,
  ServiceUpdateStatus,
  SubmissionStatus,
  TaskPriority,
  TaskProgressStage,
  TaskStatus,
  VmPowerState,
  VmReceiptPhase,
  ScheduleStatus,
  MemoryEntryStatus,
} from '../../src/contracts/states.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Adopted modules have a strict gate. Extending this list is part of migrating
// another domain; legacy modules are not silently exempted with inline ignores.
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
  { file: 'src/conversation/store.mts', domains: taskDomains },
  { file: 'src/work/task-progress.mts', domains: taskDomains },
  { file: 'src/work/work-continuation-state.mts', domains: taskDomains },
  { file: 'src/work/work-continuation.mts', domains: [...taskDomains, ConnectionStatus] },
  ...['memory-entries', 'memory-sqlite', 'memory-search'].map((name) => ({
    file: 'src/conversation/' + name + '.mts',
    domains: [MemoryEntryStatus],
  })),
  { file: 'src/app/desktop-lifecycle.mts', domains: [DesktopPhase, ConnectionStatus] },
  { file: 'src/computer/vm-lifecycle.mts', domains: [VmPowerState, VmReceiptPhase] },
  { file: 'src/schedules/scheduler.mts', domains: [ScheduleStatus] },
  {
    file: 'src/computer/vm-service-update.mts',
    domains: [
      ServiceUpdateStatus,
      ConnectionStatus,
      TaskStatus,
      ComputerControlStatus,
      SubmissionStatus,
    ],
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
export function checkStateContracts(projectRoot = root) {
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkStateContracts();
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else console.log(`State contracts checked in ${stateContractModules.length} adopted modules.`);
}
