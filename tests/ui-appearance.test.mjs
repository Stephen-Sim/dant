import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppearance,normalizeAppearance,fontFamilies,resolveAppearance,appearanceDefaults} from '../ui/appearance.js';

function fixture({cached,save=async()=>{}}={}){
 const values=new Map(cached?[['dant.appearance',JSON.stringify(cached)]]:[]),styles=new Map();
 const root={dataset:{},style:{setProperty:(key,value)=>styles.set(key,value)}},listeners=new Set(),media={matches:false,addEventListener:(_name,listener)=>listeners.add(listener),removeEventListener:(_name,listener)=>listeners.delete(listener)},motionListeners=new Set(),motion={matches:false,addEventListener:(_name,listener)=>motionListeners.add(listener),removeEventListener:(_name,listener)=>motionListeners.delete(listener)};
 const appearance=createAppearance({document:{documentElement:root},storage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},matchMedia:query=>query.includes('reduced-motion')?motion:media,save});
 return {appearance,root,styles,values,changeSystem(dark){media.matches=dark;for(const listener of listeners)listener();},changeMotion(reduce){motion.matches=reduce;for(const listener of motionListeners)listener();},listeners,motionListeners};
}

test('appearance restores saved preferences and system changes only affect system mode',async()=>{
 const f=fixture({cached:{theme:'system',font:'mono',fontSize:16}});assert.equal(f.root.dataset.theme,'light');assert.equal(f.styles.get('--app-font-size'),'16px');assert.equal(f.styles.get('--app-font-family'),fontFamilies.mono);
 f.changeSystem(true);assert.equal(f.root.dataset.theme,'dark');await f.appearance.update({theme:'light'});f.changeSystem(true);assert.equal(f.root.dataset.theme,'light');
 await f.appearance.update({theme:'system'});assert.equal(f.root.dataset.theme,'dark');assert.deepEqual(JSON.parse(f.values.get('dant.appearance')),{...appearanceDefaults,theme:'system',font:'mono',fontSize:16});
 f.appearance.dispose();assert.equal(f.listeners.size,0);assert.equal(f.motionListeners.size,0);
});

test('preference changes apply immediately, save serially, and stale snapshots cannot reset pending choices',async()=>{
 const calls=[];let finish;const f=fixture({save:patch=>{calls.push(patch);return calls.length===1?new Promise(resolve=>finish=resolve):Promise.resolve();}});
 const theme=f.appearance.update({theme:'dark'}),font=f.appearance.update({font:'sans',fontSize:18});assert.equal(f.root.dataset.theme,'dark');assert.equal(f.styles.get('--app-font-size'),'18px');
 f.appearance.sync({theme:'light',font:'system',fontSize:13});assert.equal(f.root.dataset.theme,'dark');await Promise.resolve();assert.equal(calls.length,1);finish();await Promise.all([theme,font]);assert.deepEqual(calls,[{theme:'dark'},{font:'sans',fontSize:18}]);assert.equal(f.appearance.saving,false);
});

test('a failed setting rolls back while preserving a later independent choice',async()=>{
 const f=fixture({save:async patch=>{if(patch.theme)throw Error('Save failed');}});
 const theme=f.appearance.update({theme:'dark'}),font=f.appearance.update({font:'mono'});await assert.rejects(theme,/Save failed/);await font;
 assert.equal(f.root.dataset.theme,'light');assert.deepEqual(f.appearance.preferences,{...appearanceDefaults,font:'mono'});
 await assert.rejects(f.appearance.update({fontSize:99}),/Invalid appearance/);assert.equal(f.styles.get('--app-font-size'),'13px');
 assert.deepEqual(normalizeAppearance({theme:'bad',font:'injected',fontSize:12.5}),appearanceDefaults);
 for(const family of Object.values(fontFamilies))assert.match(family,/Microsoft YaHei|Noto Sans.*CJK/,'all font choices retain a Chinese fallback');
});

test('presets, custom colors and installed fonts paint independently with CJK fallbacks',async()=>{
 const f=fixture();await f.appearance.update({themePreset:'warm',fontFamily:'Microsoft YaHei',contentFontSize:20,codeFontSize:16});
 assert.equal(f.root.dataset.themePreset,'warm');assert.equal(f.styles.get('--appearance-background'),'#FAF8F4');assert.match(f.styles.get('--app-font-family'),/^"Microsoft YaHei", system-ui/);assert.equal(f.styles.get('--content-font-size'),'20px');assert.equal(f.styles.get('--code-font-size'),'16px');
 await f.appearance.update({theme:'dark',themePreset:'custom',backgroundColor:'#123abc',foregroundColor:'#fedcba',accentColor:'#00aaff'});
 assert.equal(f.styles.get('--appearance-background'),'#123ABC');assert.equal(f.styles.get('--appearance-foreground'),'#FEDCBA');assert.equal(f.styles.get('--accent-color'),'#00AAFF');
 await f.appearance.update({themePreset:'dant',backgroundColor:null,foregroundColor:null,accentColor:null});assert.equal(f.styles.get('--appearance-background'),'#1B1D22');
 f.appearance.sync({theme:'light'});assert.equal(f.styles.get('--appearance-background'),'#FFFFFF');assert.equal(f.appearance.preferences.fontFamily,'Microsoft YaHei');
 assert.equal(resolveAppearance({theme:'dark',themePreset:'warm'}).accent,'#DBAC73');f.appearance.dispose();
});

test('reduced motion follows system and explicit preferences override system changes',async()=>{
 const f=fixture();assert.equal(f.root.dataset.reducedMotion,'full');f.changeMotion(true);assert.equal(f.root.dataset.reducedMotion,'reduce');
 await f.appearance.update({reduceMotion:'full'});f.changeMotion(true);assert.equal(f.root.dataset.reducedMotion,'full');
 await f.appearance.update({reduceMotion:'reduce'});f.changeMotion(false);assert.equal(f.root.dataset.reducedMotion,'reduce');
 await f.appearance.update({reduceMotion:'system'});assert.equal(f.root.dataset.reducedMotion,'full');f.appearance.dispose();
});

test('legacy media listeners, unavailable storage and a failed native theme stay usable',async()=>{
 const listeners=new Set(),media={matches:true,addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},root={dataset:{},style:{setProperty(){}}};
 const appearance=createAppearance({document:{documentElement:root},storage:{getItem(){throw Error('denied');},setItem(){throw Error('denied');}},matchMedia:()=>media,setNativeTheme:()=>Promise.reject(Error('native unavailable'))});
 await appearance.update({theme:'light'});assert.equal(root.dataset.theme,'light');assert.equal(listeners.size,1);appearance.dispose();assert.equal(listeners.size,0);
 const headless=createAppearance({document:null,storage:{getItem:()=>'{invalid',setItem(){}},matchMedia:null});await headless.update({});headless.sync();headless.dispose();assert.deepEqual(headless.preferences,appearanceDefaults);
});

test('native titlebar follows the chosen preference and system mode is left to Windows',async()=>{
 const themes=[],root={dataset:{},style:{setProperty(){}}};let listener;const media={matches:false,addEventListener:(_name,value)=>listener=value};
 const appearance=createAppearance({document:{documentElement:root},storage:null,matchMedia:()=>media,setNativeTheme:value=>themes.push(value)});await Promise.resolve();
 media.matches=true;listener();await Promise.resolve();assert.deepEqual(themes,[null]);assert.equal(root.dataset.theme,'dark');
 await appearance.update({theme:'light'});assert.equal(themes.at(-1),'light');await appearance.update({theme:'system'});assert.equal(themes.at(-1),null);
 appearance.dispose();
});
