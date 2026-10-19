import {translate} from '../src/i18n.mjs';
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const label=language=>translate(language,"dant live captions","dant 实时字幕");

/** Ephemeral display only: no messages, storage, transport writes or history. */
export function createCallSubtitles({onChange=()=>{},schedule=setTimeout,cancel=clearTimeout,finalDelay=8000}={}){
 let callId=null,provider=null,text='',final=false,sequence=0,timer=null;
 const ended=new Set();
 const snapshot=()=>({callId,provider,text,final,sequence});
 function clearTimer(){if(timer!==null){cancel(timer);timer=null;}}
 function clear(){clearTimer();if(!text&&!final)return;text='';final=false;onChange(snapshot());}
 function end(){if(callId){ended.add(callId);while(ended.size>64)ended.delete(ended.values().next().value);}clear();callId=null;provider=null;sequence=0;}
 function sync(call){
  const next=call?.id||call?.callId;
  if(!next||ended.has(next)||!['subscription','api'].includes(call.provider)||['stopping','stop-unconfirmed'].includes(call.status)){end();return;}
  if(next===callId&&call.provider===provider)return;
  end();callId=next;provider=call.provider;
 }
 function receive(event){
  if(event?.method!=='dant/call/subtitle')return false;const value=event.params;
  if(!callId||value?.callId!==callId||value.provider!==provider||!Number.isSafeInteger(value.sequence)||value.sequence<=sequence||typeof value.text!=='string'||value.text.length>4000||typeof value.final!=='boolean')return false;
  clearTimer();sequence=value.sequence;text=value.text;final=value.final;onChange(snapshot());
  if(final&&text){const current=callId,revision=sequence;timer=schedule(()=>{if(current!==callId||revision!==sequence)return;timer=null;clear();},finalDelay);timer?.unref?.();}
  return true;
 }
 function render({mini=false,language='en'}={}){
  return `<div class="call-subtitles" data-call-subtitles role="status" aria-live="polite" aria-atomic="true" aria-label="${label(language)}" aria-hidden="${!text||mini}" aria-busy="${Boolean(text&&!final)}"${mini?' hidden':''}><span data-call-subtitle-text>${escape(text)}</span></div>`;
 }
 function update(document){for(const node of document.querySelectorAll('[data-call-subtitles]')){const value=node.querySelector('[data-call-subtitle-text]');if(value)value.textContent=text;node.setAttribute('aria-hidden',String(!text||node.hidden));node.setAttribute('aria-busy',String(Boolean(text&&!final)));if(text)node.scrollTop=node.scrollHeight;}}
 return {sync,receive,clear,end,render,update,get snapshot(){return snapshot();},dispose(){end();}};
}
