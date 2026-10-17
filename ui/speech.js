export class SpeechHelper{
 constructor({desktop=!!globalThis.window?.__TAURI_INTERNALS__,invoke,recognizer=globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition,synthesis=globalThis.speechSynthesis,Utterance=globalThis.SpeechSynthesisUtterance}={}){this.desktop=desktop;this.invoke=invoke;this.Recognizer=recognizer;this.synthesis=synthesis;this.Utterance=Utterance;this.generation=0;}
 async native(command,args){const invoke=this.invoke||(await import('@tauri-apps/api/core')).invoke;return invoke(command,args);}
 async dictate(language='zh'){
  const generation=this.generation+1;await this.stop();if(generation!==this.generation)throw Error('Speech cancelled');
  if(this.desktop)return this.native('speech_start',{mode:'recognize',language,text:null});
  if(!this.Recognizer)throw Error(language==='zh'?'当前浏览器不支持听写，请使用 Windows 桌面版。':'Dictation is not supported in this browser. Use the Windows app.');
  return new Promise((resolve,reject)=>{
   const recognition=new this.Recognizer();this.recognition=recognition;recognition.lang=language==='zh'?'zh-CN':'en-US';recognition.continuous=false;recognition.interimResults=false;let text='',error;
   this.cancelRecognition=()=>{error=Error('Speech cancelled');recognition.abort();};
   recognition.onresult=event=>{text=Array.from(event.results||[]).filter(result=>result.isFinal).map(result=>result[0]?.transcript||'').join(' ');};
   recognition.onerror=event=>{error=Error(event.error==='not-allowed'?'Microphone permission was not granted':'Dictation failed: '+event.error);};
   recognition.onend=()=>{if(this.recognition===recognition){this.recognition=null;this.cancelRecognition=null;}if(generation!==this.generation)reject(Error('Speech cancelled'));else if(error)reject(error);else resolve(text);};
   try{recognition.start();}catch(error){this.recognition=null;this.cancelRecognition=null;reject(error);}
  });
 }
 async speak(text,language='zh'){
  if(typeof text!=='string'||!text.trim())return;const generation=this.generation+1;await this.stop();if(generation!==this.generation)throw Error('Speech cancelled');
  if(this.desktop)return this.native('speech_start',{mode:'speak',language,text:text.slice(0,10000)});
  if(!this.synthesis||!this.Utterance)throw Error('Read aloud is unavailable in this browser.');
  return new Promise((resolve,reject)=>{const utterance=new this.Utterance(text.slice(0,10000));utterance.lang=language==='zh'?'zh-CN':'en-US';const voice=this.synthesis.getVoices().find(voice=>voice.lang.startsWith(language==='zh'?'zh':'en'));if(voice)utterance.voice=voice;utterance.onend=()=>generation===this.generation?resolve():reject(Error('Speech cancelled'));utterance.onerror=event=>reject(Error(event.error==='canceled'?'Speech cancelled':'Read aloud failed'));this.synthesis.speak(utterance);});
 }
 async stop(){this.generation++;this.cancelRecognition?.();this.synthesis?.cancel();if(this.desktop)await this.native('speech_stop',{});}
}
