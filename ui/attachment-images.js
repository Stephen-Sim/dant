// Lazy images keep a visible footprint while their authenticated request loads.
// Rebinding after reconciliation also restores the ready state of cached nodes.
export function bindAttachmentImages(root) {
 for(const image of root.querySelectorAll('.attachment-image')){
  const card=image.closest('.image-attachment');if(!card)continue;
  const update=state=>{
   card.dataset.imageState=state;card.setAttribute('aria-busy',String(state==='loading'));
   if(state==='ready'){
    const width=image.naturalWidth,height=image.naturalHeight;
    card.style.setProperty('--attachment-width',Math.min(width,440,270*width/height)+'px');
    card.style.setProperty('--attachment-ratio',width+' / '+height);
   }
  };
  image.onload=()=>update(image.naturalWidth>0&&image.naturalHeight>0?'ready':'error');
  image.onerror=()=>update('error');
  update(image.complete?(image.naturalWidth>0&&image.naturalHeight>0?'ready':'error'):'loading');
 }
}
