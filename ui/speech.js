export const speechMessages={
 zh:{cancelled:'语音辅助已停止。',dictationUnsupported:'当前浏览器不支持听写，请使用 Windows 桌面版。',permissionDenied:'麦克风权限未获准，请在系统或浏览器设置中允许使用麦克风。',dictationFailed:'听写失败',noSpeech:'没有听到语音，请重试。',microphoneUnavailable:'无法读取麦克风，请检查设备连接或占用情况。',languageUnsupported:'当前听写语言不可用，请检查语音识别语言设置。',recognitionNetwork:'听写服务连接失败，请检查网络或使用 Windows 桌面版。',readUnsupported:'当前浏览器不支持朗读，请使用 Windows 桌面版。',readFailed:'朗读失败'},
 en:{cancelled:'Speech helper stopped.',dictationUnsupported:'Dictation is not supported in this browser. Use the Windows app.',permissionDenied:'Microphone permission was not granted. Allow it in system or browser settings.',dictationFailed:'Dictation failed',noSpeech:'No speech was heard. Please try again.',microphoneUnavailable:'The microphone could not be read. Check the device connection or whether it is in use.',languageUnsupported:'The dictation language is unavailable. Check the speech recognition language settings.',recognitionNetwork:'The dictation service could not connect. Check the network or use the Windows app.',readUnsupported:'Read aloud is not supported in this browser. Use the Windows app.',readFailed:'Read aloud failed'},
};
const speechText=(language,key)=>(speechMessages[language==='en'?'en':'zh'])[key];
const cancelled=language=>Object.assign(new Error(speechText(language,'cancelled')),{code:'speech-cancelled'});
export class SpeechHelper{
 constructor({desktop=!!globalThis.window?.__TAURI_INTERNALS__,invoke,recognizer=globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition,synthesis=globalThis.speechSynthesis,Utterance=globalThis.SpeechSynthesisUtterance}={}){this.desktop=desktop;this.invoke=invoke;this.Recognizer=recognizer;this.synthesis=synthesis;this.Utterance=Utterance;this.generation=0;}
 async native(command,args){const invoke=this.invoke||(await import('@tauri-apps/api/core')).invoke;return invoke(command,args);}
 async dictate(language='zh'){
  const generation=this.generation+1;await this.stop();if(generation!==this.generation)throw cancelled(language);
  if(this.desktop)return this.native('speech_start',{mode:'recognize',language,text:null});
  if(!this.Recognizer)throw Error(speechText(language,'dictationUnsupported'));
  return new Promise((resolve,reject)=>{
   const recognition=new this.Recognizer();this.recognition=recognition;recognition.lang=language==='zh'?'zh-CN':'en-US';recognition.continuous=false;recognition.interimResults=false;let text='',error;
   this.cancelRecognition=()=>{error=cancelled(language);recognition.abort();};
   recognition.onresult=event=>{text=Array.from(event.results||[]).filter(result=>result.isFinal).map(result=>result[0]?.transcript||'').join(' ');};
   recognition.onerror=event=>{const known={'not-allowed':'permissionDenied','service-not-allowed':'permissionDenied','no-speech':'noSpeech','audio-capture':'microphoneUnavailable','language-not-supported':'languageUnsupported',network:'recognitionNetwork'};error=Error(known[event.error]?speechText(language,known[event.error]):speechText(language,'dictationFailed')+': '+event.error);};
   recognition.onend=()=>{if(this.recognition===recognition){this.recognition=null;this.cancelRecognition=null;}if(generation!==this.generation)reject(cancelled(language));else if(error)reject(error);else resolve(text);};
   try{recognition.start();}catch(error){this.recognition=null;this.cancelRecognition=null;reject(error);}
  });
 }
 async speak(text,language='zh'){
  if(typeof text!=='string'||!text.trim())return;const generation=this.generation+1;await this.stop();if(generation!==this.generation)throw cancelled(language);
  if(this.desktop)return this.native('speech_start',{mode:'speak',language,text:text.slice(0,10000)});
  if(!this.synthesis||!this.Utterance)throw Error(speechText(language,'readUnsupported'));
  return new Promise((resolve,reject)=>{const utterance=new this.Utterance(text.slice(0,10000));utterance.lang=language==='zh'?'zh-CN':'en-US';const voice=this.synthesis.getVoices().find(voice=>voice.lang.startsWith(language==='zh'?'zh':'en'));if(voice)utterance.voice=voice;utterance.onend=()=>generation===this.generation?resolve():reject(cancelled(language));utterance.onerror=event=>reject(event.error==='canceled'||event.error==='interrupted'?cancelled(language):Error(speechText(language,'readFailed')+': '+event.error));this.synthesis.speak(utterance);});
 }
 async stop(){this.generation++;this.cancelRecognition?.();this.synthesis?.cancel();if(this.desktop)await this.native('speech_stop',{});}
}
