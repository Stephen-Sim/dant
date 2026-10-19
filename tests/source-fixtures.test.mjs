import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {sourceSection,sourceDeclaration,sourceIndex,compactCss} from './source-fixtures.mjs';

test('source sections use declaration identity across whitespace, wrapping, comments and quote formatting',()=>{
 for(const source of ["const zh={label:'ready'};\nfunction renderCall(){return zh.label;}\nasync function finish(){}",'const zh = {\n  label: "ready",\n};\n// declaration comment\nfunction renderCall() {\n  return zh.label;\n}\nasync function finish() {\n}\n']){
  const context={};vm.createContext(context);vm.runInContext(sourceSection(source,'const zh={','async function finish(){'),context);assert.equal(context.renderCall(),'ready');
  assert.match(sourceDeclaration(source,'function renderCall(){'),/^function renderCall/);assert.ok(sourceIndex(source,'async function finish(){')>0);
 }
});
test('source sections never silently select a missing or ambiguous declaration',()=>{
 assert.throws(()=>sourceSection('const a=1;','const absent=','const a='),/exactly one/);
 assert.throws(()=>sourceIndex('const a=1;','arbitrary source text'),/Unsupported/);
 assert.throws(()=>sourceIndex('document.addEventListener("keydown",()=>{});document.addEventListener("keydown",()=>{});',"document.addEventListener('keydown'"),/exactly one/);
 assert.equal(sourceDeclaration('document.addEventListener(\n"keydown",\n()=>{},\n);',"document.addEventListener('keydown'"),'document.addEventListener(\n"keydown",\n()=>{},\n);');
});
test('CSS assertion views normalize formatting without removing selectors or declarations',()=>{
 const source='.card {\n display: flex;\n gap: 8px;\n}\n';assert.equal(compactCss(source),'.card{display:flex;gap:8px}\n');assert.equal(source.includes('\n display: flex;'),true);
});
