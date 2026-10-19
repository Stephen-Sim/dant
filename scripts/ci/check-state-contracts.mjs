import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/typescript';
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
const stateContractRules = Object.freeze([
  { file: 'src/conversation/store.mjs', domains: taskDomains },
  { file: 'src/work/task-progress.mts', domains: taskDomains },
  { file: 'src/work/work-continuation-state.mts', domains: taskDomains },
  { file: 'src/app/desktop-lifecycle.mts', domains: [DesktopPhase, ConnectionStatus] },
  { file: 'src/computer/vm-lifecycle.mjs', domains: [VmPowerState, VmReceiptPhase] },
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
function literalPropertyKey(node, parent) {
  return (
    parent?.key === node &&
    !parent.computed &&
    [
      'Property',
      'TSPropertySignature',
      'MethodDefinition',
      'PropertyDefinition',
      'TSMethodSignature',
    ].includes(parent.type)
  );
}
export function rawStateLiterals(source, domains = taskDomains) {
  const values = new Set(domains.flatMap((domain) => Object.values(domain)));
  const found = [];
  // The pinned TypeScript ESTree parser accepts the same erasable syntax as
  // runtime modules without starting a compiler process or hiding parse errors.
  const tree = parsers.typescript.parse(source, { filepath: 'state-contract.mts' });
  function visit(node, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'Literal' &&
      typeof node.value === 'string' &&
      values.has(node.value) &&
      !literalPropertyKey(node, parent)
    )
      found.push({ value: node.value, line: node.loc.start.line });
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
