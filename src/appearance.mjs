import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export {appearanceDefaults,appearanceKeys,readAppearance,validateAppearancePatch} from './appearance-settings.mjs';

const execute=promisify(execFile);
const fontScript=String.raw`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName PresentationCore
$dantFontNames = @([System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source } | Sort-Object -Unique)
ConvertTo-Json -InputObject $dantFontNames -Compress`;
export async function listSystemFonts({platform=process.platform,run=execute}={}){
 if(platform!=='win32')return {fonts:[],source:'fallback'};
 try{
  const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',fontScript],{windowsHide:true,shell:false,timeout:15000,maxBuffer:256*1024,encoding:'utf8'});
  const values=JSON.parse(stdout.replace(/^\uFEFF/,''));if(!Array.isArray(values)||values.length>2048)throw Error('Invalid font inventory');
  const fonts=[...new Set(values.filter(value=>typeof value==='string'&&value.trim()&&value.length<=128&&!/[\x00-\x1f\x7f;{}"'\\]/.test(value)).map(value=>value.trim()))].sort((a,b)=>a.localeCompare(b));
  return {fonts,source:'windows'};
 }catch{throw Object.assign(Error('Windows font list is unavailable. System fonts can still be used.'),{status:503});}
}
