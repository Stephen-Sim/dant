import fs from 'node:fs';
import path from 'node:path';
if(process.argv.includes('--stage-release')){
 const resources=path.resolve('src-tauri/resources'),backend=path.resolve('src-tauri/target/release/backend');
 if(!fs.existsSync(path.join(resources,'node.exe')))throw Error('Prepare backend resources before staging the desktop runtime.');
 fs.cpSync(resources,backend,{recursive:true});
 console.log('Standalone desktop runtime staged beside dant.exe.');
 process.exit(0);
}
const target=path.resolve('src-tauri/resources');fs.mkdirSync(target,{recursive:true});
for(const name of ['src','dist','node_modules','scripts','vm'])fs.cpSync(path.resolve(name),path.join(target,name),{recursive:true,filter:src=>!src.includes(`${path.sep}.cache${path.sep}`)&&!src.includes(`${path.sep}__pycache__${path.sep}`)});
fs.copyFileSync('package.json',path.join(target,'package.json'));fs.copyFileSync(process.execPath,path.join(target,'node.exe'));
console.log('Desktop backend resources prepared. User data and VM keys excluded.');
