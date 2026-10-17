import fs from 'node:fs';
import path from 'node:path';
import {AttachmentStore} from '../src/attachments.mjs';

const source=path.resolve(process.argv[2]),target=path.resolve(process.argv[3]);
const manifestFile=path.join(source,'manifest.json');
if(!fs.existsSync(manifestFile))process.exit(0);
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')),receipt=path.join(target,'migration-imported.json');
if(fs.existsSync(receipt)){
 if(JSON.parse(fs.readFileSync(receipt,'utf8')).id!==manifest.id)throw Error('A different import already exists; VM work was preserved.');
 process.exit(0);
}
if(fs.existsSync(path.join(target,'state.json')))throw Error('The VM already has authoritative data; import refused and work preserved.');
const state=JSON.parse(fs.readFileSync(path.join(source,'state.json'),'utf8'));
const attachments=new AttachmentStore(path.join(target,'attachments')),mapped=new Map(),warnings=[];
for(const message of state.messages||[])for(let index=0;index<(message.attachments||[]).length;index++){
 const original=message.attachments[index];
 if(mapped.has(original.id)){message.attachments[index]=mapped.get(original.id);continue;}
 if(typeof original.id!=='string'||!/^[a-zA-Z0-9-]+$/.test(original.id))throw Error('Invalid legacy attachment identifier.');
 const file=path.join(source,'files',original.id),info=fs.lstatSync(file,{throwIfNoEntry:false});
 if(!info?.isFile()||info.isSymbolicLink()||info.nlink!==1){warnings.push(`Attachment missing: ${original.id}`);original.unavailable=true;continue;}
 const item=attachments.put({name:original.name,data:fs.readFileSync(file)});mapped.set(original.id,item);message.attachments[index]=item;
}
state.settings??={};state.settings.vm={host:'',user:'dant',port:22,keyPath:'',knownHosts:''};
state.migration={...manifest,warnings,importedAt:new Date().toISOString()};
// Commit state only after every available file has been safely imported.
fs.writeFileSync(path.join(target,'state.json'),JSON.stringify(state,null,2),{flag:'wx',mode:0o600});
fs.writeFileSync(receipt,JSON.stringify({...manifest,warnings}),{flag:'wx',mode:0o600});
