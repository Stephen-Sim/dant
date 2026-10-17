import {EventEmitter} from 'node:events';

export class ComputerSession extends EventEmitter{
 constructor(engine,worker){super();this.engine=engine;this.worker=worker;this.state={status:'dant',sessionId:null,expiresAt:0};this.pending=false;this.timer=null;}
 snapshot(){return {...this.state};}
 change(){clearTimeout(this.timer);this.timer=null;if(this.state.sessionId){this.timer=setTimeout(()=>{this.state={status:'dant',sessionId:null,expiresAt:0};this.engine.release();this.change();},Math.max(1,this.state.expiresAt-Date.now()+20));this.timer.unref?.();}this.emit('change');}
 async control(body){return (await this.worker.guest('/control',body)).json();}
 async acquire(){
  if(this.pending||this.state.sessionId)throw Error('Desktop takeover is already active.');
  this.engine.assertTakeoverCall();
  this.pending=true;this.engine.acquiring=true;this.engine.pauseQueue?.();
  try{
   this.state=await this.control({action:'acquire'});this.change();
   this.engine.acquiring=false;
   await this.engine.acquire();
   this.state=await this.control({action:'confirm',sessionId:this.state.sessionId});this.change();return this.snapshot();
  }catch(error){
   if(this.state.sessionId)await this.control({action:'release',sessionId:this.state.sessionId}).catch(()=>{});
   this.state={status:'dant',sessionId:null,expiresAt:0};this.engine.takeover=false;this.change();throw error;
  }finally{this.pending=false;this.engine.acquiring=false;}
 }
 assertSession(sessionId){if(this.state.status!=='human'||!sessionId||sessionId!==this.state.sessionId||Date.now()>=this.state.expiresAt)throw Error('Desktop control session expired. Take control again.');}
 async input(body){this.assertSession(body.sessionId);const expected=this.state.sessionId;const result=await (await this.worker.guest('/input',body)).json();if(this.state.sessionId===expected){this.state.expiresAt=result.expiresAt||Date.now()+120000;this.change();}return result;}
 async release(sessionId){
  this.assertSession(sessionId);if(this.pending)throw Error('Desktop control is changing.');this.pending=true;
  try{await this.control({action:'release',sessionId});this.state={status:'dant',sessionId:null,expiresAt:0};this.engine.release();this.change();return this.snapshot();}
  finally{this.pending=false;}
 }
 close(){clearTimeout(this.timer);}
}
