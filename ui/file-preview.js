const MAX_BYTES=1024*1024,MAX_FORMATTED=2*1024*1024;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jsonType=value=>value==='application/json'||/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(value);
const textType=value=>value.startsWith('text/')||['application/xml','application/javascript','application/x-javascript','application/typescript','application/x-typescript','application/yaml','application/x-yaml','application/toml','application/sql','application/graphql','application/x-sh','application/x-shellscript'].includes(value);
const mediaType=value=>String(value||'').split(';')[0].trim().toLowerCase();
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function untilAbort(value,signal){let abort;try{return await Promise.race([value,new Promise((resolve,reject)=>{abort=()=>reject(Error('File preview cancelled.'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}}
const words={
 en:{view:'View',download:'Download',close:'Close',editor:'Open in editor',editorFailed:'The text editor could not open this file. Check your editor in Settings.',loading:'Loading file…',failed:'This file could not be opened. Check the connection and try again.',retry:'Try again',large:'This file is larger than the 1 MiB preview limit. Download it to view the complete file.',unsupported:'This file cannot be previewed as UTF-8 text. Download it to open it with a suitable app.',json:'Formatted JSON',raw:'JSON shown as original text because formatting would be too large or deeply nested.',invalid:'This file is not valid JSON. Showing its original text.',text:'Plain text'},
 zh:{view:'查看',download:'下载',close:'关闭',editor:'在编辑器中打开',editorFailed:'文本编辑器无法打开此文件，请检查设置中的编辑器。',loading:'正在读取文件…',failed:'无法打开此文件，请检查连接后重试。',retry:'重试',large:'文件超过 1 MiB 预览限制，请下载后查看完整内容。',unsupported:'此文件无法作为 UTF-8 文本预览，请下载后使用合适的应用打开。',json:'格式化 JSON',raw:'JSON 过大或嵌套过深，已显示完整原始文本。',invalid:'此文件不是有效的 JSON，已显示原始文本。',text:'纯文本'}
};
export function canPreviewFile(file){const type=mediaType(file?.type),name=String(file?.name||'');return !/\.(?:exe|com|msi|dll|scr)$/i.test(name)&&!/^(?:image|audio|video)\//.test(type)&&(jsonType(type)||textType(type)||/\.(?:json|txt|md|csv|tsv|log|ya?ml|xml|svg|toml|ini|conf|cfg|py|js|mjs|cjs|jsx|ts|tsx|css|html?|sh|bash|ps1|bat|cmd|sql|rs|go|java|c|h|cpp|hpp)$/i.test(name));}

// Format validated JSON tokens rather than converting values through JS numbers.
// Bounded scanning keeps deep structures and large pretty expansions as exact text.
export function formatFileText(text,{json=false}={}){
 if(!json)return {text,format:'text'};
 const source=text.replace(/^\uFEFF/, '');let depth=0,quoted=false,escaped=false,punctuation=0,growth=0;
 for(const char of source){
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
  if(char==='"'){quoted=true;continue;}
  if(char==='{'||char==='['){depth++;growth+=depth*2+1;}else if(char==='}'||char===']'){depth--;growth+=Math.max(0,depth)*2+1;}else if(char===',')growth+=depth*2+1;else if(char===':')growth++;
  if('{}[],:'.includes(char)&&++punctuation>20000||depth>64||growth+source.length>MAX_FORMATTED)return {text,format:'raw'};
 }
 try{JSON.parse(source);}catch{return {text,format:'invalid'};}
 const tokens=source.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)||[],parts=[];depth=0;let length=0;
 const add=value=>{length+=value.length;parts.push(value);};
 for(let index=0;index<tokens.length;index++){
  const token=tokens[index],previous=tokens[index-1],next=tokens[index+1];
  if(token==='{'||token==='['){add(token);depth++;if(next!=='}'&&next!==']')add('\n'+'  '.repeat(depth));}
  else if(token==='}'||token===']'){depth--;if(previous!=='{'&&previous!=='[')add('\n'+'  '.repeat(depth));add(token);}
  else if(token===',')add(',\n'+'  '.repeat(depth));else if(token===':')add(': ');else add(token);
  if(length>MAX_FORMATTED)return {text,format:'raw'};
 }
 const formatted=parts.join('');return new TextEncoder().encode(formatted).length>MAX_FORMATTED?{text,format:'raw'}:{text:formatted,format:'json'};
}

export function createFilePreview({getState,getModal,openModal,render,getToken=()=>'',base='',fetchImpl=(...args)=>fetch(...args),document=globalThis.document,window=globalThis.window,schedule=setTimeout,cancel=clearTimeout,timeoutMs=30000,icon=()=>'',openExternal,desktop=Boolean(window?.__TAURI_INTERNALS__)}={}){
 let active=null,sequence=0,closed=false;
 const scope=()=>{const state=getState(),vm=state?.settings?.vm;return JSON.stringify([state?.conversationId??null,vm?.host??null,vm?.user??null,vm?.port??null,vm?.keyPath??null]);};
 const language=()=>getState()?.settings?.language==='en'?'en':'zh',tr=key=>words[language()][key];
 const owns=operation=>!closed&&active===operation&&getModal()===operation.modal&&scope()===operation.scope;
 function clear(){if(!active)return;active.controller?.abort();active.text='';active=null;}
 function syncModal(modal){if(active&&(!owns(active)||modal!==active.modal))clear();return modal?.type==='file'&&(!active||active.modal!==modal)?null:modal;}
 async function load(operation){
  operation.controller?.abort();const controller=new AbortController(),generation=++operation.generation;operation.controller=controller;operation.status='loading';operation.text='';render();
  const current=()=>owns(operation)&&operation.generation===generation&&!controller.signal.aborted,timer=schedule(()=>controller.abort(),timeoutMs);let reader;
  const fail=key=>{throw Object.assign(Error('File preview unavailable.'),{previewReason:key});};
  try{
   if(Number(operation.file.size)>MAX_BYTES)fail('large');const token=getToken();if(!/^[a-f0-9]{64}$/i.test(token)||!['','http://127.0.0.1:4317'].includes(base))fail('failed');
   const response=await untilAbort(fetchImpl(base+'/api/files/'+encodeURIComponent(operation.file.id),{headers:{'X-Dant-Token':token},redirect:'error',credentials:'omit',signal:controller.signal}),controller.signal);
   if(!current())return;if(!response.ok||response.redirected)fail('failed');if(Number(response.headers.get('content-length'))>MAX_BYTES)fail('large');
   const contentType=response.headers.get('content-type')||'',type=mediaType(contentType),charset=/;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
   const knownText=type==='application/octet-stream'&&canPreviewFile({name:operation.file.name,type});
   if(!jsonType(type)&&!textType(type)&&!knownText||charset&&!['utf-8','utf8','us-ascii'].includes(charset))fail('unsupported');
   reader=response.body?.getReader();if(!reader)fail('failed');const chunks=[];let length=0;
   while(true){const item=await untilAbort(reader.read(),controller.signal);if(!current())return;if(item.done)break;length+=item.value.byteLength;if(length>MAX_BYTES)fail('large');chunks.push(item.value);}
   const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
   let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch{fail('unsupported');}
   if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))fail('unsupported');
   const result=formatFileText(text,{json:jsonType(type)||/\.json$/i.test(operation.file.name)});if(!current())return;operation.status='ready';operation.text=result.text;operation.format=result.format;
  }catch(error){if(owns(operation)&&operation.generation===generation){operation.status=['large','unsupported'].includes(error?.previewReason)?error.previewReason:'failed';operation.text='';}}
  finally{cancel(timer);if(reader)void reader.cancel().catch(()=>{});if(owns(operation)&&operation.generation===generation)render();}
 }
 function open(file){
  if(closed||!file||!uuid.test(file.id||'')||!canPreviewFile(file))return Promise.resolve(false);clear();
  const modal={type:'file',fileId:file.id,previewId:++sequence},operation={modal,file:{id:file.id,name:String(file.name||''),type:file.type,size:file.size},scope:scope(),status:'loading',text:'',generation:0};active=operation;openModal(modal);return load(operation).then(()=>true);
 }
 function renderModal(modal){
  const operation=active;if(!operation||operation.modal!==modal||!owns(operation))return '';
  const ready=operation.status==='ready',body=ready?`<p class="file-preview-caption">${tr(operation.format)}</p><pre class="file-preview-text" tabindex="0">${escape(operation.text)}</pre>`:`<p class="file-preview-status" role="status">${tr(operation.status)}</p>${operation.status==='failed'?`<button type="button" class="text-btn" data-file-preview-retry>${tr('retry')}</button>`:''}`;
  return `<div class="modal-backdrop file-preview-backdrop" data-key="modal-backdrop"><section class="dialog file-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${escape(operation.file.name)}</h2><div>${desktop&&typeof openExternal==='function'?`<button type="button" class="text-btn" data-file-preview-editor ${operation.editorBusy?'disabled':''}>${tr('editor')}</button>`:''}<button type="button" class="text-btn" data-download="${escape(operation.file.id)}">${icon('download')}${tr('download')}</button><button type="button" class="icon-btn" data-action="close-modal" aria-label="${tr('close')}">${icon('x')||'×'}</button></div></div><div class="file-preview-body" aria-busy="${operation.status==='loading'}">${operation.editorError?`<p class="error" role="status">${tr('editorFailed')}</p>`:''}${body}</div></section></div>`;
 }
 function bind(getFile){
  syncModal(getModal());document.querySelectorAll('[data-file-preview]').forEach(node=>node.onclick=event=>{event.preventDefault();event.stopPropagation();void open(getFile(node.dataset.filePreview));});
  document.querySelectorAll('[data-file-preview-retry]').forEach(node=>node.onclick=event=>{event.preventDefault();event.stopPropagation();if(active&&owns(active)&&active.status==='failed')void load(active);});
  document.querySelectorAll('[data-file-preview-editor]').forEach(node=>node.onclick=async event=>{event.preventDefault();event.stopPropagation();const operation=active;if(!operation||!owns(operation)||operation.editorBusy)return;operation.editorBusy=true;operation.editorError=false;render();try{await openExternal(operation.file);}catch{if(owns(operation))operation.editorError=true;}finally{if(owns(operation)){operation.editorBusy=false;render();}};});
 }
 function dispose(){if(closed)return;closed=true;clear();window?.removeEventListener?.('beforeunload',dispose);}
 window?.addEventListener?.('beforeunload',dispose);return {open,renderModal,syncModal,bind,dispose};
}
