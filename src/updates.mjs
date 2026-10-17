export const REPOSITORY_URL='https://github.com/Stephen-Sim/dant';
export const RELEASES_URL=REPOSITORY_URL+'/releases';
export const LATEST_RELEASE_API='https://api.github.com/repos/Stephen-Sim/dant/releases/latest';

const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*))*))?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/;
function parsedVersion(value){if(typeof value!=='string'||value.length>64)return null;const match=semver.exec(value);return match?{parts:match.slice(1,4).map(BigInt),prerelease:match[4]?.split('.')||[]}:null;}
export function compareVersions(left,right){
 const a=parsedVersion(left),b=parsedVersion(right);if(!a||!b)throw Error('Invalid application version.');
 for(let index=0;index<3;index++){if(a.parts[index]!==b.parts[index])return a.parts[index]>b.parts[index]?1:-1;}
 if(!a.prerelease.length||!b.prerelease.length)return a.prerelease.length===b.prerelease.length?0:a.prerelease.length?-1:1;
 for(let index=0;index<Math.max(a.prerelease.length,b.prerelease.length);index++){
  const x=a.prerelease[index],y=b.prerelease[index];if(x===undefined||y===undefined)return x===undefined?-1:1;if(x===y)continue;
  const numericX=/^\d+$/.test(x),numericY=/^\d+$/.test(y);if(numericX&&numericY)return BigInt(x)>BigInt(y)?1:-1;if(numericX!==numericY)return numericX?-1:1;return x>y?1:-1;
 }return 0;
}
const messages={UPDATE_TIMEOUT:'The update check timed out. Try again.',UPDATE_RATE_LIMITED:'GitHub is limiting update checks. Try again later.',UPDATE_UNAVAILABLE:'Updates could not be checked. Check your connection and try again.',UPDATE_INVALID_RELEASE:'GitHub returned an invalid release. Try again later.'};
const failure=code=>Object.assign(Error(messages[code]),{code,status:code==='UPDATE_TIMEOUT'?504:code==='UPDATE_RATE_LIMITED'?503:502});
async function boundedJson(response,maxBytes,signal){
 const length=Number(response.headers.get('content-length'));if(Number.isFinite(length)&&length>maxBytes){void response.body?.cancel?.().catch(()=>{});throw failure('UPDATE_INVALID_RELEASE');}
 const reader=response.body?.getReader();if(!reader)throw failure('UPDATE_INVALID_RELEASE');const chunks=[];let total=0;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes)throw failure('UPDATE_INVALID_RELEASE');chunks.push(Buffer.from(value));}return JSON.parse(Buffer.concat(chunks,total).toString('utf8'));}
 catch(error){void reader.cancel().catch(()=>{});throw error instanceof SyntaxError?failure('UPDATE_INVALID_RELEASE'):error;}finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}

/** Public release metadata only. Constructing the service never contacts GitHub. */
export class UpdateService{
 constructor({version,fetchImpl=fetch,now=Date.now,timeoutMs=10000,cacheMs=60000,maxBytes=256*1024}={}){this.version=version;this.fetch=fetchImpl;this.now=now;this.timeoutMs=timeoutMs;this.cacheMs=cacheMs;this.maxBytes=maxBytes;this.cached=null;this.pending=null;this.abort=null;this.closed=false;}
 info(){return {version:this.version,repositoryUrl:REPOSITORY_URL,releasesUrl:RELEASES_URL};}
 check(){
  if(this.closed)return Promise.reject(failure('UPDATE_UNAVAILABLE'));
  if(this.cached&&this.now()-this.cached.at<this.cacheMs)return Promise.resolve({...this.cached.result});
  if(this.pending)return this.pending;
  this.pending=this.load().then(result=>{if(!this.closed)this.cached={at:this.now(),result};return {...result};}).finally(()=>{this.pending=null;});return this.pending;
 }
 async load(){
  if(!parsedVersion(this.version))throw failure('UPDATE_INVALID_RELEASE');
  const controller=new AbortController();this.abort=controller;let timer,abort;
  const cancelled=new Promise((resolve,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(failure('UPDATE_TIMEOUT')),this.timeoutMs);});
  try{
   return await Promise.race([cancelled,(async()=>{
    const response=await this.fetch(LATEST_RELEASE_API,{method:'GET',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'dant-update-check'},credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok){void response.body?.cancel?.().catch(()=>{});throw failure([403,429].includes(response.status)?'UPDATE_RATE_LIMITED':'UPDATE_UNAVAILABLE');}
    const release=await boundedJson(response,this.maxBytes,controller.signal),tag=release?.tag_name,latest=typeof tag==='string'?tag.replace(/^v/,''):null;
    if(!release||release.draft!==false||release.prerelease!==false||!parsedVersion(latest)||!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)||release.html_url!==RELEASES_URL+'/tag/'+tag)throw failure('UPDATE_INVALID_RELEASE');
    return {currentVersion:this.version,latestVersion:latest,updateAvailable:compareVersions(latest,this.version)>0,releaseUrl:release.html_url,checkedAt:new Date(this.now()).toISOString()};
   })()]);
  }catch(error){throw Object.hasOwn(messages,error?.code)?failure(error.code):failure('UPDATE_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);if(this.abort===controller)this.abort=null;}
 }
 close(){this.closed=true;this.cached=null;this.abort?.abort(failure('UPDATE_UNAVAILABLE'));}
}

export function installUpdateRoutes(app,updates){
 for(const route of ['/api/version','/api/updates'])app.all(route,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Update information is read-only.'});}
  try{return res.json(route==='/api/version'?updates.info():await updates.check());}
  catch(error){const code=Object.hasOwn(messages,error?.code)?error.code:'UPDATE_UNAVAILABLE',safe=failure(code);return res.status(safe.status).json({error:safe.message,code});}
 });
}
