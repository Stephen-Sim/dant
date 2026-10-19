import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseAst} from 'rollup/parseAst';
import {ComputerControlStatus, ConnectionStatus, ContinuationDispatchPhase, DesktopPhase, PlanStepStatus, ServiceUpdateStatus, SubmissionStatus, TaskPriority, TaskProgressStage, TaskStatus, VmPowerState, VmReceiptPhase} from '../../src/contracts/states.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Adopted modules have a strict gate. Extending this list is part of migrating
// another domain; legacy modules are not silently exempted with inline ignores.
const taskDomains=Object.freeze([ContinuationDispatchPhase,PlanStepStatus,SubmissionStatus,TaskPriority,TaskProgressStage,TaskStatus]);
const stateContractRules=Object.freeze([
 {file:'src/store.mjs',domains:taskDomains},
 {file:'src/task-progress.mjs',domains:taskDomains},
 {file:'src/work-continuation-state.mjs',domains:taskDomains},
 {file:'src/desktop-lifecycle.mjs',domains:[DesktopPhase,ConnectionStatus]},
 {file:'src/vm-lifecycle.mjs',domains:[VmPowerState,VmReceiptPhase]},
 {file:'src/vm-service-update.mjs',domains:[ServiceUpdateStatus,ConnectionStatus,TaskStatus,ComputerControlStatus,SubmissionStatus]},
]);
export const stateContractModules=Object.freeze(stateContractRules.map(rule=>rule.file));
function walk(node,visit,parent=null){if(!node||typeof node!=='object')return;visit(node,parent);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(child=>walk(child,visit,node));else if(value&&typeof value==='object')walk(value,visit,node);}
export function rawStateLiterals(source,domains=taskDomains){
 const values=new Set(domains.flatMap(domain=>Object.values(domain)));
 const found=[];walk(parseAst(source),(node,parent)=>{
  if(node.type!=='Literal'||typeof node.value!=='string'||!values.has(node.value))return;
  if(parent?.type==='Property'&&parent.key===node&&!parent.computed)return;
  found.push({value:node.value,line:source.slice(0,node.start).split('\n').length});
 });return found;
}
export function checkStateContracts(projectRoot=root){
 const failures=[];for(const {file,domains} of stateContractRules){const source=fs.readFileSync(path.join(projectRoot,file),'utf8');for(const item of rawStateLiterals(source,domains))failures.push(`${file}:${item.line}: use the named domain enum instead of ${JSON.stringify(item.value)}`);}return failures;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const failures=checkStateContracts();if(failures.length){for(const failure of failures)console.error(failure);process.exitCode=1;}else console.log(`State contracts checked in ${stateContractModules.length} adopted modules.`);
}
