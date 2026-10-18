import {canPreviewFile} from './file-preview.js';

const controls=/[\x00-\x1f\x7f]/;
function localPath(value){
 if(typeof value!=='string')return null;
 let path=value.trim();if(!path||path.startsWith('#')||path.startsWith('//'))return null;
 if(controls.test(path))return {path:null};
 const localScheme=/^(?:file|sandbox|attachment):/i.test(path);
 if(/^[a-z][a-z\d+.-]*:/i.test(path)&&!localScheme&&!/^[a-z]:[/\\]/i.test(path))return null;
 if(localScheme){
  if(/^file:/i.test(path)){
   try{const url=new URL(path);if(url.hostname&&url.hostname!=='localhost'||url.search||url.hash)return {path:null};path=url.pathname;if(/^\/[a-z]:\//i.test(path))path=path.slice(1);}catch{return {path:null};}
  }else path=path.replace(/^(?:sandbox|attachment):/i,'');
 }
 if(/[?#]/.test(path))return {path:null};
 try{path=decodeURIComponent(path);}catch{return {path:null};}
 if(controls.test(path))return {path:null};
 path=path.replaceAll('\\','/');
 if(path.startsWith('/')||/^[a-z]:\//i.test(path))return {path};
 if(/^(?:\.\/)?output\//.test(path)){
  path=path.replace(/^\.\//,'');if(path.split('/').some(part=>!part||part==='.'||part==='..'))return {path:null};return {path,relative:true};
 }
 // Other relative file references must not navigate the webview as app routes.
 return localScheme||path.includes('/')||/\.[a-z\d]{1,16}$/i.test(path)?{path:null}:null;
}

export function resolveMessageAttachmentLink(href,attachments=[]){
 const reference=localPath(href);if(!reference)return {local:false,file:null};
 if(!reference.path)return {local:true,file:null};
 const matches=attachments.filter(file=>{
  if(typeof file?.id!=='string'||typeof file.sourcePath!=='string')return false;
  const source=file.sourcePath.replaceAll('\\','/');if(controls.test(source)||!source.startsWith('/')&&!/^[a-z]:\//i.test(source))return false;
  if(!reference.relative)return source===reference.path;
  const marker=source.lastIndexOf('/output/');return marker>=0&&'output/'+source.slice(marker+8)===reference.path;
 });
 return {local:true,file:matches.length===1?matches[0]:null};
}

// Only immutable files already attached to this message can satisfy a local link.
// Unmatched paths are never handed to the browser or operating system.
export function bindMessageAttachmentLink(link,{getMessage,onImage,onFile,onDownload,onUnavailable=()=>{},onError=()=>{}}={}){
 const article=link.closest('.message[data-id]');if(!article)return false;
 const href=link.getAttribute('href'),messageId=article.dataset.id;
 if(!resolveMessageAttachmentLink(href,getMessage(messageId)?.attachments).local)return false;
 const button=link.ownerDocument.createElement('button');button.type='button';button.className='attachment-link';if(link.title)button.title=link.title;button.append(...link.childNodes);link.replaceWith(button);
 button.onclick=event=>{
  event.preventDefault();event.stopPropagation();
  const file=resolveMessageAttachmentLink(href,getMessage(messageId)?.attachments).file;if(!file){onUnavailable();return;}
  try{const operation=String(file.type||'').startsWith('image/')?onImage(file):canPreviewFile(file)?onFile(file):onDownload(file);Promise.resolve(operation).catch(onError);}catch(error){onError(error);}
 };
 return true;
}
