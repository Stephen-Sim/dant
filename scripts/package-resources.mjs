import fs from 'node:fs';
import path from 'node:path';
import {resolveBuildPaths} from './ci/build-paths.mjs';
if(process.argv.includes('--stage-release')){
 const {resources,backend}=resolveBuildPaths(path.resolve('.'));
 if(!fs.existsSync(path.join(resources,'node.exe')))throw Error('Prepare backend resources before staging the desktop runtime.');
 fs.cpSync(resources,backend,{recursive:true});
 console.log('Standalone desktop runtime staged beside dant.exe.');
 process.exit(0);
}
const target=path.resolve('src-tauri/resources');fs.mkdirSync(target,{recursive:true});
for(const name of ['src','dist','node_modules','scripts','vm'])fs.cpSync(path.resolve(name),path.join(target,name),{recursive:true,filter:src=>!src.includes(`${path.sep}.cache${path.sep}`)&&!src.includes(`${path.sep}__pycache__${path.sep}`)});
for(const name of ['package.json','package-lock.json','LICENSE'])fs.copyFileSync(name,path.join(target,name));fs.copyFileSync(process.execPath,path.join(target,'node.exe'));
console.log('Desktop backend resources prepared. User data and VM keys excluded.');
