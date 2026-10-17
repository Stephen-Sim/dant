import {canPreviewFile} from './file-preview.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const messages={
 en:{title:'Text editor',hint:'Open text and code attachments in Notepad or your preferred editor. This opens a local copy; the chat attachment stays unchanged.',choose:'Choose editor…',reset:'Use Notepad',supported:'Supported editors include VS Code, Notepad++, Sublime Text, Zed and Cursor. Choose the editor’s .exe file.',desktop:'Available in the desktop app.',failed:'The editor setting could not be changed. Choose a supported installed editor and try again.',loading:'Loading…'},
 zh:{title:'文本编辑器',hint:'使用记事本或你选择的编辑器打开文本和代码附件。打开的是本地副本，聊天中的附件保持不变。',choose:'选择编辑器…',reset:'使用记事本',supported:'支持 VS Code、Notepad++、Sublime Text、Zed 和 Cursor 等编辑器，请选择编辑器的 .exe 文件。',desktop:'此功能适用于桌面应用。',failed:'无法更改编辑器设置，请选择已安装且受支持的编辑器后重试。',loading:'正在读取…'}
};
const failure=()=>Object.assign(Error('The text editor could not open this attachment. Check your editor in Settings.'),{code:'editor_failed'});
export function createTextEditor({desktop=Boolean(globalThis.window?.__TAURI_INTERNALS__),getLanguage=()=> 'en',getToken=()=>'',render=()=>{},document=globalThis.document,invoke,loadCore=()=>import('@tauri-apps/api/core')}={}){
 let preference={editor:'notepad',name:'Notepad'},loaded=false,busy=false,error=false,closed=false,loading=null;const pending=new Map();
 const tr=key=>messages[getLanguage()==='zh'?'zh':'en'][key];
 const call=async(command,args)=>{const core=invoke?{invoke}:await loadCore();if(closed)throw failure();return core.invoke(command,args);};
 function validate(value){if(!value||!['notepad','custom'].includes(value.editor)||typeof value.name!=='string'||!value.name||value.name.length>200||/[\\/\x00-\x1f]/.test(value.name))throw failure();return {editor:value.editor,name:value.name};}
 function load(){
  if(closed||!desktop||loaded||busy)return Promise.resolve();if(loading)return loading;
  loading=(async()=>{try{const value=validate(await call('editor_preferences'));if(!closed){preference=value;loaded=true;error=false;}}catch{if(!closed)error=true;}finally{loading=null;if(!closed)render();}})();render();return loading;
 }
 async function change(command){if(closed||!desktop||busy||loading)return;busy=true;error=false;render();try{const value=await call(command);if(value!==null&&!closed){preference=validate(value);loaded=true;}}catch{if(!closed)error=true;}finally{busy=false;if(!closed)render();}}
 function renderSettings(){return `<section class="settings-section setting-card text-editor-settings" aria-label="${tr('title')}"><div class="card-label"><h2>${tr('title')}</h2></div><div class="card-content"><p class="card-description">${tr('hint')}</p><strong data-editor-name>${escape(preference.name)}</strong><div class="form-actions"><button type="button" class="text-btn" data-editor-choose ${!desktop||busy||loading?'disabled':''}>${tr('choose')}</button><button type="button" class="text-btn" data-editor-reset ${!desktop||busy||loading||preference.editor==='notepad'?'disabled':''}>${tr('reset')}</button></div><p class="muted">${desktop?tr('supported'):tr('desktop')}</p>${loading?`<p role="status" class="muted">${tr('loading')}</p>`:''}${error?`<p role="status" class="error">${tr('failed')}</p>`:''}</div></section>`;}
 function bind(){document.querySelectorAll('[data-editor-choose]').forEach(node=>node.onclick=event=>{event.preventDefault();void change('choose_text_editor');});document.querySelectorAll('[data-editor-reset]').forEach(node=>node.onclick=event=>{event.preventDefault();void change('reset_text_editor');});}
 function open(file){
  if(closed||!desktop||!file||!uuid.test(file.id||'')||!canPreviewFile(file)||!/^[a-f0-9]{64}$/i.test(getToken()))return Promise.reject(failure());if(pending.has(file.id))return pending.get(file.id);
  const token=getToken(),operation=(async()=>{try{const result=await call('open_attachment_in_editor',{fileId:file.id,token,fileName:String(file.name||'')});if(result?.opened!==true)throw failure();return {opened:true};}catch{throw failure();}finally{if(pending.get(file.id)===operation)pending.delete(file.id);}})();pending.set(file.id,operation);return operation;
 }
 function dispose(){closed=true;}
 return {load,renderSettings,bind,open,dispose};
}
