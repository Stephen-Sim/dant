import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const renameRetryCodes=new Set(['EPERM','EACCES','EBUSY']);
const pauseBuffer=new Int32Array(new SharedArrayBuffer(4));
export class Store {
  constructor(dir,{renameSync=fs.renameSync,platform=process.platform,pause=ms=>Atomics.wait(pauseBuffer,0,0,ms)}={}) {
    this.renameSync=renameSync;this.platform=platform;this.pause=pause;
    this.dir=dir; fs.mkdirSync(dir,{recursive:true}); this.file=path.join(dir,'state.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,messages:[],memory:'',settings:{language:'zh',voice:'marin',model:'',notifications:true,vm:{host:'',user:'dant',port:22,keyPath:'',knownHosts:''}},threadId:null,threadHost:null,schedules:[]};
    for(const m of this.state.messages) if(['queued','running','streaming'].includes(m.status)) m.status='interrupted';
    this.save();
  }
  save(){const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state,null,2));
    for(let attempt=0;attempt<6;attempt++){
      try{this.renameSync(temp,this.file);return;}
      catch(error){if(this.platform!=='win32'||!renameRetryCodes.has(error.code)||attempt===5)throw error;this.pause((attempt+1)*10);}
    }
  }
  add(data){const m={id:randomUUID(),time:Date.now(),reactions:[],read:false,...data};this.state.messages.push(m);this.save();return m;}
  update(id,data){const m=this.state.messages.find(m=>m.id===id);if(!m)throw Error('Message not found');Object.assign(m,data);this.save();return m;}
}
