export const appearanceDefaults=Object.freeze({theme:'system',font:'system',fontSize:13});
export const fontFamilies=Object.freeze({
 system:'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
 sans:'Inter, Arial, "Noto Sans", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
 mono:'"Cascadia Code", Consolas, "SFMono-Regular", "Noto Sans Mono CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", monospace',
});
export function normalizeAppearance(values={}){
 return {theme:['system','light','dark'].includes(values.theme)?values.theme:'system',font:Object.hasOwn(fontFamilies,values.font)?values.font:'system',fontSize:Number.isInteger(values.fontSize)&&values.fontSize>=12&&values.fontSize<=18?values.fontSize:13};
}
export function createAppearance({document=globalThis.document,storage=globalThis.localStorage,matchMedia=globalThis.matchMedia?.bind(globalThis),save=async()=>{},setNativeTheme}={}){
 let saved;try{saved=JSON.parse(storage?.getItem('dant.appearance')||'null');}catch{}
 let confirmed=normalizeAppearance(saved||{}),current={...confirmed},chain=Promise.resolve(),nativeTheme;const pending=[];
 const media=matchMedia?.('(prefers-color-scheme: dark)');
 function paint(){
  const root=document?.documentElement;if(!root)return;
  const theme=current.theme==='system'?(media?.matches?'dark':'light'):current.theme;
  root.dataset.theme=theme;root.dataset.themePreference=current.theme;root.dataset.font=current.font;
  root.style.colorScheme=theme;root.style.setProperty('--app-font-family',fontFamilies[current.font]);root.style.setProperty('--app-font-size',current.fontSize+'px');
  if(setNativeTheme&&nativeTheme!==current.theme){const selected=current.theme;nativeTheme=selected;Promise.resolve().then(()=>setNativeTheme(selected==='system'?null:selected)).catch(()=>{});}
 }
 function project(){current=normalizeAppearance(Object.assign({},confirmed,...pending.map(item=>item.patch)));try{storage?.setItem('dant.appearance',JSON.stringify(current));}catch{}paint();}
 const onSystemChange=()=>{if(current.theme==='system')paint();};
 if(media?.addEventListener)media.addEventListener('change',onSystemChange);else media?.addListener?.(onSystemChange);
 paint();
 return {
  get preferences(){return {...current};},
  get saving(){return pending.length>0;},
  sync(values={}){if(!pending.length){const selected=Object.fromEntries(Object.keys(appearanceDefaults).filter(key=>values[key]!==undefined).map(key=>[key,values[key]]));confirmed=normalizeAppearance({...confirmed,...selected});project();}return {...current};},
  update(values){
   const patch=Object.fromEntries(Object.keys(appearanceDefaults).filter(key=>values[key]!==undefined).map(key=>[key,values[key]]));
   if(!Object.keys(patch).length)return Promise.resolve({...current});
   const normalized=normalizeAppearance({...current,...patch});if(Object.keys(patch).some(key=>normalized[key]!==patch[key]))return Promise.reject(new Error('Invalid appearance preference'));
   const job={patch};pending.push(job);project();
   const operation=chain.then(async()=>{try{await save(patch);confirmed=normalizeAppearance({...confirmed,...patch});}finally{pending.splice(pending.indexOf(job),1);project();}return {...current};});
   chain=operation.catch(()=>{});return operation;
  },
  dispose(){if(media?.removeEventListener)media.removeEventListener('change',onSystemChange);else media?.removeListener?.(onSystemChange);},
 };
}
