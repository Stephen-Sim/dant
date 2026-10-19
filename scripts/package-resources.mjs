import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveBuildPaths} from './ci/build-paths.mjs';
import {readVersion} from './ci/version.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directories=['src','dist','node_modules','scripts','vm'],files=['package.json','package-lock.json','LICENSE'];
const retryCodes=new Set(['EPERM','EACCES','EBUSY']),pauseBuffer=new Int32Array(new SharedArrayBuffer(4));
const samePath=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
const inside=(root,target)=>{const relative=path.relative(root,target);return !!relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};

// Reject junctions as well as symlinks on the output and every existing ancestor.
// A lexical prefix alone is insufficient before a recursive Windows cleanup.
function ordinaryAncestors(target){
 for(let current=target;;current=path.dirname(current)){
  const stat=fs.lstatSync(current,{throwIfNoEntry:false});if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw Error('Packaging directories must be ordinary directories, never links or junctions.');
  if(path.dirname(current)===current)break;
 }
}
function directory(target){ordinaryAncestors(target);if(!fs.lstatSync(target,{throwIfNoEntry:false})?.isDirectory())throw Error('Missing required packaging directory: '+path.basename(target));}
function file(target){const stat=fs.lstatSync(target,{throwIfNoEntry:false});ordinaryAncestors(path.dirname(target));if(!stat?.isFile()||stat.isSymbolicLink()||stat.size===0)throw Error('Missing or unsafe required packaging file: '+path.basename(target));}
function project(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||root.includes('\0'))throw Error('Packaging project root must be absolute.');
 root=path.resolve(root);directory(root);for(const name of [...files,'src-tauri/tauri.conf.json','src-tauri/Cargo.toml'])file(path.join(root,name));
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
 if(pkg.name!=='dant'||lock.name!=='dant'||lock.version!==pkg.version)throw Error('Packaging requires the matching dant project package and lockfile.');
 readVersion(root,{});return root;
}
export function assertGeneratedPath(root,target,env=process.env){
 if(typeof target!=='string'||!path.isAbsolute(target)||target.includes('\0'))throw Error('Generated packaging path must be absolute.');
 const paths=resolveBuildPaths(root,env),resolved=path.resolve(target);let base;
 if(samePath(resolved,paths.resources))base=path.resolve(root);
 else if(samePath(resolved,paths.backend))base=paths.target;
 else throw Error('Refusing to clean a directory outside the generated packaging outputs.');
 if(!inside(base,resolved))throw Error('Generated packaging output must stay inside its intended root.');
 ordinaryAncestors(resolved);return resolved;
}
function removeStaging(parent,staging){
 const relative=path.relative(parent,staging);
 if(!relative||relative.includes(path.sep)||!relative.startsWith('.dant-resources-')||path.isAbsolute(relative))throw Error('Refusing to clean an unowned packaging staging directory.');
 ordinaryAncestors(staging);fs.rmSync(staging,{recursive:true,force:true});
}
function replaceTree(root,target,env,copy,{renameSync=fs.renameSync,platform=process.platform,pause=ms=>Atomics.wait(pauseBuffer,0,0,ms)}={}){
 const destination=assertGeneratedPath(root,target,env),parent=path.dirname(destination);fs.mkdirSync(parent,{recursive:true});ordinaryAncestors(parent);
 const staging=fs.mkdtempSync(path.join(parent,'.dant-resources-'));
 try{
  copy(staging);
  // Revalidate immediately before removing only this exact generated directory.
  assertGeneratedPath(root,destination,env);fs.rmSync(destination,{recursive:true,force:true,maxRetries:6,retryDelay:50});
  for(let attempt=0;attempt<6;attempt++){try{renameSync(staging,destination);break;}catch(error){if(platform!=='win32'||!retryCodes.has(error.code)||attempt===5)throw error;pause((attempt+1)*25);}}
 }finally{if(fs.existsSync(staging))removeStaging(parent,staging);}
 return destination;
}
const copyDirectory=(source,destination)=>fs.cpSync(source,destination,{recursive:true,filter:entry=>!path.relative(source,entry).split(path.sep).some(part=>part==='.cache'||part==='__pycache__'||/^\.env(?:\.|$)/i.test(part))});
function validateSources(root){
 for(const name of directories)directory(path.join(root,name));
 for(const name of ['src/server.mjs','dist/index.html','node_modules/express/package.json'])file(path.join(root,name));
}
export function prepareResources({projectRoot=defaultRoot,nodeExecutable=process.execPath,env=process.env,...replaceOptions}={}){
 const root=project(projectRoot);validateSources(root);file(nodeExecutable);
 const {resources}=resolveBuildPaths(root,env);
 return replaceTree(root,resources,env,staging=>{
  for(const name of directories)copyDirectory(path.join(root,name),path.join(staging,name));
  for(const name of files)fs.copyFileSync(path.join(root,name),path.join(staging,name));
  fs.copyFileSync(nodeExecutable,path.join(staging,'node.exe'));
 },replaceOptions);
}
export function stageReleaseResources({projectRoot=defaultRoot,env=process.env,...replaceOptions}={}){
 const root=project(projectRoot),{resources,backend}=resolveBuildPaths(root,env);assertGeneratedPath(root,resources,env);directory(resources);validateSources(resources);for(const name of [...files,'node.exe'])file(path.join(resources,name));
 const expected=new Set([...directories,...files,'node.exe']);if(fs.readdirSync(resources).some(name=>!expected.has(name)))throw Error('Prepared backend contains unexpected files. Prepare clean resources before staging.');
 const sourcePackage=JSON.parse(fs.readFileSync(path.join(resources,'package.json'),'utf8')),currentPackage=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 if(sourcePackage.name!=='dant'||sourcePackage.version!==currentPackage.version)throw Error('Prepared backend version does not match the current dant project.');
 if(inside(resources,backend)||inside(backend,resources)||samePath(resources,backend))throw Error('Generated backend and resources directories must not overlap.');
 return replaceTree(root,backend,env,staging=>{for(const name of directories)copyDirectory(path.join(resources,name),path.join(staging,name));for(const name of [...files,'node.exe'])fs.copyFileSync(path.join(resources,name),path.join(staging,name));},replaceOptions);
}
if(process.argv[1]&&samePath(path.resolve(process.argv[1]),fileURLToPath(import.meta.url))){
 if(process.argv.includes('--stage-release')){stageReleaseResources();console.log('Standalone desktop runtime staged beside dant.exe.');}
 else{prepareResources();console.log('Desktop backend resources prepared. User data and VM keys excluded.');}
}
