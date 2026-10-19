import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const file={id:'10000000-0000-4000-8000-000000000001',name:'Saved result.png',type:'image/png'};

test('task details use the shared chat reply selection and open saved files without requiring visible chat history',async()=>{
 let options;const selected=[],modals=[],previews=[],downloads=[],context={document:{},state:{messages:[]},language:()=> 'en',modal:null,eventConnected:true,api(){throw Error('Selecting a task must not submit it');},render(){},openModal:value=>modals.push(value),ico:()=>'',taskReplies:{select:target=>selected.push(target)},createTaskDetails:value=>{options=value;return {};},canPreviewFile:value=>value.type==='text/plain',filePreview:{open:value=>previews.push(value)},downloads:{save:async value=>downloads.push(value)},toast(){}};
 vm.createContext(context);vm.runInContext(source.match(/^const taskDetails=createTaskDetails\(.*$/m)[0],context);
 const target={workId:'saved-work',turnId:'saved-turn',conversationId:'chat'};options.onReply(target);assert.equal(selected[0],target);
 options.onFile(file);assert.deepEqual(JSON.parse(JSON.stringify(modals)),[{type:'image',fileId:file.id}]);assert.equal(previews.length,0);
 const text={...file,type:'text/plain',name:'Saved result.txt'};options.onFile(text);assert.equal(previews[0],text);
 const binary={...file,type:'application/pdf',name:'Saved result.pdf'};options.onFile(binary);await options.onDownload(file);assert.deepEqual(downloads,[binary,file]);
});

test('image and task detail modals resolve validated project files even after the source message was pruned',()=>{
 const lookups=[],context={modal:{type:'image',fileId:file.id},managedSettings:{renderModal:()=>null},chatHistory:{renderModal:()=>null},conversationFiles:()=>[],taskDetails:{file:id=>{lookups.push(id);return id===file.id?file:null;},renderModal:()=>'<section>Task details</section>'},esc:value=>String(value??''),t:key=>key,ico:()=>'',button:()=>'',fileURL:value=>'/api/files/'+value.id};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function renderModal(){'),source.indexOf('function openModal(')),context);
 assert.match(context.renderModal(),/Saved result\.png/);assert.deepEqual(lookups,[file.id]);context.modal.fileId='missing';assert.equal(context.renderModal(),'');context.modal={type:'task-detail'};assert.equal(context.renderModal(),'<section>Task details</section>');
});
