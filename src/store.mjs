import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export class Store {
  constructor(dir) {
    this.dir=dir; fs.mkdirSync(dir,{recursive:true}); this.file=path.join(dir,'state.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,messages:[],memory:'',settings:{language:'zh',voice:'marin',model:'',notifications:true,vm:{host:'',user:'dant',port:22,keyPath:'',knownHosts:''}},threadId:null,threadHost:null,schedules:[]};
    for(const m of this.state.messages) if(['queued','running','streaming'].includes(m.status)) m.status='interrupted';
    this.save();
  }
  save(){const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state,null,2));fs.renameSync(temp,this.file);}
  add(data){const m={id:randomUUID(),time:Date.now(),reactions:[],read:false,...data};this.state.messages.push(m);this.save();return m;}
  update(id,data){const m=this.state.messages.find(m=>m.id===id);if(!m)throw Error('Message not found');Object.assign(m,data);this.save();return m;}
}
