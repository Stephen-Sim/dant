import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatTaskStatus,DesktopPhase,isEnumValue,PlanStepStatus,ServiceUpdateStatus,TaskPriority,TaskStatus,VmPowerState,VmReceiptPhase,WorkStatus} from '../src/contracts/states.mjs';
import {TASK_STATES} from '../src/store.mjs';
import {TASK_PLAN_SCHEMA,taskPlanInput} from '../src/task-progress.mjs';
import {rawStateLiterals,checkStateContracts} from '../scripts/ci/check-state-contracts.mjs';

test('named enum domains retain existing persisted values and immutable narrow validators',()=>{
 assert.deepEqual(TASK_STATES,['draft','accepted','queued','running','waiting_user','pausing','paused','failed','review','completed','cancelled']);assert.deepEqual(TASK_STATES,Object.values(ChatTaskStatus));
 assert.equal(isEnumValue(ChatTaskStatus,TaskStatus.Continuing),false);assert.equal(isEnumValue(WorkStatus,TaskStatus.Continuing),true);assert.equal(isEnumValue(WorkStatus,TaskStatus.Draft),false);
 for(const domain of [ChatTaskStatus,WorkStatus,DesktopPhase,PlanStepStatus,TaskPriority,ServiceUpdateStatus]){
  assert.equal(Object.isFrozen(domain),true);for(const value of Object.values(domain))assert.equal(isEnumValue(domain,value),true);
  for(const value of [undefined,null,0,false,{},[],'invented-state'])assert.equal(isEnumValue(domain,value),false);
 }
 assert.throws(()=>{DesktopPhase.Idle='changed';},TypeError);
});
test('plan validation uses the shared step vocabulary without coercing invalid wire values',()=>{
 assert.deepEqual(TASK_PLAN_SCHEMA.steps.items.properties.status.enum,Object.values(PlanStepStatus));
 assert.equal(taskPlanInput({title:'Verify',steps:[{step:'Verify',status:PlanStepStatus.Pending}],status:WorkStatus.WaitingUser}).plan.steps[0].status,PlanStepStatus.Pending);
 assert.throws(()=>taskPlanInput({title:'Verify',steps:[{step:'Verify',status:'in_progress'}]}),/valid statuses/);
});
test('adopted modules forbid new raw state values while property keys and user-facing prose remain valid',()=>{
 assert.deepEqual(checkStateContracts(),[]);assert.equal(rawStateLiterals("const value={status:'paused'};")[0].value,'paused');assert.equal(rawStateLiterals("if (task.status === 'running') {};").length,1);
 assert.deepEqual(rawStateLiterals("const copy={'paused':'Paused',description:'This task is paused.'};"),[]);
 assert.deepEqual(rawStateLiterals('const value={status:TaskStatus.Paused};'),[]);
 assert.equal(rawStateLiterals("const value={state:'suspended'};",[VmPowerState]).length,1);
 assert.equal(rawStateLiterals("const value={phase:'suspending'};",[VmReceiptPhase]).length,1);
 assert.deepEqual(rawStateLiterals("const value={phase:VmReceiptPhase.Suspended};",[VmReceiptPhase]),[]);
});
