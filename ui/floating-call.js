const interactive='button,a,input,textarea,select,summary,audio,video,[role="button"],[contenteditable]:not([contenteditable="false"])';
const finite=value=>Number.isFinite(value);

// Only presentation state lives here. The call's media, clock and controls keep
// their existing owners, and moving the bar never sends a command or re-renders.
export function createFloatingCall({window=globalThis.window,ResizeObserverImpl=globalThis.ResizeObserver,now=Date.now}={}){
 let node=null,bounds=null,anchor=null,key=null,position=null,gesture=null,suppressUntil=0,disposed=false;
 const document=window?.document;
 const observer=ResizeObserverImpl?new ResizeObserverImpl(()=>place()):null;
 const area=()=>bounds?.getBoundingClientRect?.();
 function place(){
  if(!node||!position||!node.isConnected)return;
  const box=area(),size=node.getBoundingClientRect();if(!box||!box.width||!box.height||!size.width||!size.height)return;
  const marginX=Math.min(8,Math.max(0,(box.width-size.width)/2)),marginY=Math.min(8,Math.max(0,(box.height-size.height)/2));
  position={x:Math.max(box.left+marginX,Math.min(box.right-marginX-size.width,position.x)),y:Math.max(box.top+marginY,Math.min(box.bottom-marginY-size.height,position.y))};
  node.style.left=position.x+'px';node.style.top=position.y+'px';node.style.right='auto';node.style.bottom='auto';
  node.toggleAttribute('data-call-dragging',Boolean(gesture?.moved));
 }
 function finish(event){
  if(!gesture||event?.pointerId!==undefined&&event.pointerId!==gesture.id)return;
  const previous=gesture;gesture=null;
  if(previous.moved)suppressUntil=now()+500;
  document?.removeEventListener('pointermove',move);document?.removeEventListener('pointerup',finish);document?.removeEventListener('pointercancel',finish);
  try{if(previous.node.hasPointerCapture?.(previous.id))previous.node.releasePointerCapture(previous.id);}catch{}
  node?.removeAttribute('data-call-dragging');
 }
 function move(event){
  if(!gesture||event.pointerId!==gesture.id||!finite(event.clientX)||!finite(event.clientY))return;
  const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
  if(!gesture.moved&&Math.hypot(dx,dy)<4)return;
  gesture.moved=true;position={x:gesture.left+dx,y:gesture.top+dy};event.preventDefault();place();
 }
 function start(event){
  suppressUntil=0;
  if(gesture||event.isPrimary===false||event.button!==0||!finite(event.clientX)||!finite(event.clientY)||event.target?.closest?.(interactive))return;
  place();if(!position)return;
  gesture={id:event.pointerId,node,x:event.clientX,y:event.clientY,left:position.x,top:position.y,moved:false};
  event.preventDefault();
  try{node.setPointerCapture?.(event.pointerId);}catch{}
  document?.addEventListener('pointermove',move,{passive:false});document?.addEventListener('pointerup',finish);document?.addEventListener('pointercancel',finish);
 }
 function click(event){
  if(suppressUntil>=now()&&event.detail!==0){suppressUntil=0;event.preventDefault();event.stopImmediatePropagation();}
 }
 function detach(){
  finish();node?.removeEventListener('pointerdown',start);node?.removeEventListener('lostpointercapture',finish);node?.removeEventListener('click',click,true);observer?.disconnect();node=null;
 }
 function sync(element,{callKey=null,bounds:nextBounds=null,anchor:nextAnchor=null}={}){
  if(disposed)return;
  if(key!==callKey){finish();key=callKey;position=null;suppressUntil=0;}
  if(element!==node||nextBounds!==bounds){detach();node=element;bounds=nextBounds;anchor=nextAnchor;
   if(node){node.addEventListener('pointerdown',start);node.addEventListener('lostpointercapture',finish);node.addEventListener('click',click,true);observer?.observe(node);if(bounds)observer?.observe(bounds);}
  }else anchor=nextAnchor;
  if(!node)return;
  if(!position){const box=(anchor||bounds)?.getBoundingClientRect?.(),size=node.getBoundingClientRect();if(box&&box.width&&box.height&&size.width&&size.height)position={x:box.right-size.width-16,y:box.top+16};}
  place();
 }
 function dispose(){if(disposed)return;disposed=true;detach();window?.removeEventListener('resize',place);window?.removeEventListener('blur',finish);window?.removeEventListener('beforeunload',dispose);position=null;key=null;}
 window?.addEventListener('resize',place);window?.addEventListener('blur',finish);window?.addEventListener('beforeunload',dispose);
 return {sync,dispose};
}
