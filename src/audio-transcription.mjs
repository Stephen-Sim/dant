import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {MAX_ATTACHMENT_BYTES,inspectContent} from './attachments.mjs';

const MAX_OUTPUT_BYTES=128*1024;
const AUDIO_TYPES=new Set(['audio/wav','audio/ogg','audio/mpeg','audio/webm']);
const FAILURE='Audio recognition failed in the VM.';
const UNAVAILABLE='Audio recognition is unavailable in the VM. Reconnect to prepare its runtime.';
const ERRORS={no_speech:'No speech was detected in the audio message.',invalid_audio:'The audio message could not be decoded.',too_long:'Audio messages for recognition must be at most 10 minutes.',unavailable:UNAVAILABLE,failed:FAILURE};
const cancelled=()=>Object.assign(Error('Audio recognition was cancelled.'),{name:'AbortError',code:'ABORT_ERR'});

// Recognition is local to the VM; original recordings remain in AttachmentStore.
export class AudioTranscriber{
 constructor({attachments,home=os.homedir(),platform=process.platform,spawnImpl=spawn,timeoutMs=180000}={}){
  this.attachments=attachments;this.home=home;this.platform=platform;this.spawn=spawnImpl;this.timeoutMs=timeoutMs;this.pending=Promise.resolve();this.blocked=false;this.closed=false;this.shutdown=new AbortController();
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw Error('Invalid audio recognition timeout.');
 }
 transcribe(attachment,{signal}={}){
  if(this.closed)return Promise.reject(Error('Audio recognition has stopped.'));
  signal=signal?AbortSignal.any([signal,this.shutdown.signal]):this.shutdown.signal;
  if(signal?.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
   let started=false;const abort=()=>{if(!started)reject(cancelled());};signal?.addEventListener('abort',abort,{once:true});
   const operation=this.pending.then(()=>{
    started=true;signal?.removeEventListener('abort',abort);if(signal?.aborted)throw cancelled();
    return this.recognize(attachment,signal);
   });
   this.pending=operation.catch(()=>{});operation.then(resolve,reject);
  });
 }
 async close(){this.closed=true;this.shutdown.abort();await this.pending;if(this.blocked)throw Error('Audio recognition did not confirm shutdown. Restart the VM service before retrying.');}
 async recognize(attachment,signal){
  if(this.platform!=='linux')throw Error('Audio recognition is available only inside the Linux VM.');
  if(this.blocked)throw Error('Audio recognition did not confirm shutdown. Restart the VM service before retrying.');
  let data;
  try{
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachment?.id||''))throw Error();
   const stored=this.attachments.read(attachment.id),meta=stored.meta;data=stored.data;
   if(!Buffer.isBuffer(data)||!data.length||data.length>MAX_ATTACHMENT_BYTES||meta.id!==attachment.id||meta.size!==data.length||!AUDIO_TYPES.has(meta.type)||inspectContent(data,meta.name)!==meta.type||meta.hash!==createHash('sha256').update(data).digest('hex'))throw Error();
  }catch{throw Error('Audio attachment is missing or invalid.');}
  if(signal?.aborted)throw cancelled();
  const root=path.join(this.home,'dant'),runtime=path.join(root,'runtime/transcription');
  return await new Promise((resolve,reject)=>{
   let child;try{child=this.spawn(path.join(runtime,'venv/bin/python'),[path.join(root,'vm/transcribe_audio.py'),'--model-dir',path.join(runtime,'model')],{
    shell:false,windowsHide:true,cwd:root,stdio:['pipe','pipe','pipe'],
    env:{HOME:this.home,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',PYTHONNOUSERSITE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'2',TOKENIZERS_PARALLELISM:'false',CUDA_VISIBLE_DEVICES:''}
   });}catch{reject(Error(UNAVAILABLE));return;}
   let settled=false,stopping=null,outputBytes=0,errorBytes=0,errorOverflow=false;const output=[],errors=[];let killTimer,shutdownTimer;
   const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);clearTimeout(shutdownTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
   const kill=signal=>{try{child.kill(signal);}catch{}};
   const stop=error=>{
    if(settled||stopping)return;stopping=error;clearTimeout(timer);
    killTimer=setTimeout(()=>kill('SIGKILL'),1000);
    shutdownTimer=setTimeout(()=>{this.blocked=true;finish(Error('Audio recognition did not confirm shutdown. Restart the VM service before retrying.'));},2000);
    kill('SIGTERM');
   };
   const abort=()=>stop(cancelled());
   const timer=setTimeout(()=>stop(Error('Audio recognition timed out.')),this.timeoutMs);
   signal?.addEventListener('abort',abort,{once:true});
   child.once('error',()=>stop(Error(UNAVAILABLE)));
   child.stdout.on('data',chunk=>{if(settled||stopping)return;const bytes=Buffer.from(chunk);outputBytes+=bytes.length;if(outputBytes>MAX_OUTPUT_BYTES){stop(Error('Audio recognition returned an invalid result.'));return;}output.push(bytes);});
   child.stderr.on('data',chunk=>{if(errorOverflow)return;const bytes=Buffer.from(chunk);errorBytes+=bytes.length;if(errorBytes>8192){errorOverflow=true;errors.length=0;return;}errors.push(bytes);});
   child.stdin.on('error',()=>stop(Error(FAILURE)));
   child.once('close',code=>{
    if(stopping){finish(stopping);return;}
    if(code!==0){let reason;try{const value=JSON.parse(Buffer.concat(errors).toString('utf8'));if(!errorOverflow&&Object.hasOwn(ERRORS,value?.error))reason=ERRORS[value.error];}catch{}finish(Error(reason||FAILURE));return;}
    try{
     const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output)));
     if(!value||Array.isArray(value)||typeof value.text!=='string')throw Error();
     if(!value.text.trim()){finish(Error(ERRORS.no_speech));return;}
     if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text)||typeof value.language!=='string'||!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.language)||value.language.length>32||!Number.isFinite(value.duration)||value.duration<=0||value.duration>600)throw Error();
     finish(null,{text:value.text.trim(),language:value.language,duration:value.duration});
    }catch{finish(Error('Audio recognition returned an invalid result.'));}
   });
   if(signal?.aborted){abort();return;}
   try{child.stdin.end(data);}catch{stop(Error(FAILURE));}
  });
 }
}
