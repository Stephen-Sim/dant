use std::{collections::{HashMap,HashSet},fs,io::{Read,Write},path::{Path,PathBuf},process::{Command,Stdio},sync::Mutex,time::{Duration,Instant}};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use tauri::{Emitter,Manager};
#[cfg(windows)] use std::os::windows::process::CommandExt;

const FAILED:&str="The update could not be verified. Check for updates and try again.";
const BLOCKED:&str="Installation could not confirm paused work and VM suspension. dant remains open; check Work computer and try again.";
const MAX_INSTALLER:u64=512*1024*1024;
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Asset{pub version:String,pub channel:String,pub url:String,pub sha256:String,pub size:u64,pub name:String}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Ready{ready:bool,package_id:String,version:String,channel:String,sha256:String,size:u64,name:String}
#[derive(Default)]
pub struct Updates{busy:Mutex<HashSet<String>>,packages:Mutex<HashMap<String,Asset>>,installing:Mutex<bool>}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
struct Progress<'a>{version:&'a str,channel:&'a str,sha256:&'a str,received:u64,total:u64,status:&'a str}
fn progress(app:&tauri::AppHandle,asset:&Asset,received:u64,status:&str){let _=app.emit_to("main","dant-update-progress",Progress{version:&asset.version,channel:&asset.channel,sha256:&asset.sha256,received,total:asset.size,status});}
pub(crate) fn version(value:&str)->Option<((u64,u64,u64),Option<Vec<&str>>)> {
 if value.is_empty()||value.len()>80||!value.is_ascii(){return None}
 let(core,pre)=value.split_once('-').map_or((value,None),|(core,pre)|(core,Some(pre)));
 let parts:Vec<_>=core.split('.').collect();if parts.len()!=3||parts.iter().any(|v|v.is_empty()||v.len()>1&&v.starts_with('0')||!v.bytes().all(|b|b.is_ascii_digit())){return None}
 let numbers=(parts[0].parse().ok()?,parts[1].parse().ok()?,parts[2].parse().ok()?);
 let pre=if let Some(pre)=pre{let parts:Vec<_>=pre.split('.').collect();if parts.iter().any(|v|v.is_empty()||!v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')||v.bytes().all(|b|b.is_ascii_digit())&&v.len()>1&&v.starts_with('0')){return None}Some(parts)}else{None};Some((numbers,pre))
}
fn newer(candidate:&str,current:&str)->bool{
 let(Some((a,ap)),Some((b,bp)))=(version(candidate),version(current))else{return false};
 if a!=b{return a>b}match(ap,bp){(None,Some(_))=>true,(Some(_),None)|(None,None)=>false,(Some(a),Some(b))=>{for(x,y)in a.iter().zip(&b){if x==y{continue}let(xn,yn)=(x.bytes().all(|v|v.is_ascii_digit()),y.bytes().all(|v|v.is_ascii_digit()));return match(xn,yn){(true,true)=>x.len()>y.len()||x.len()==y.len()&&x>y,(true,false)=>false,(false,true)=>true,(false,false)=>x>y}}a.len()>b.len()}}
}
pub(crate) fn valid_asset(asset:&Asset)->bool{
 let Some((_,pre))=version(&asset.version)else{return false};
 if !matches!(asset.channel.as_str(),"stable"|"beta")||asset.channel=="stable"&&pre.is_some()||asset.size==0||asset.size>MAX_INSTALLER||asset.sha256.len()!=64||!asset.sha256.bytes().all(|v|v.is_ascii_digit()||matches!(v,b'a'..=b'f'))||asset.name!=format!("dant_{}_windows_x64_setup.exe",asset.version){return false}
 [format!("https://github.com/Stephen-Sim/dant/releases/download/v{}/{}",asset.version,asset.name),format!("https://github.com/Stephen-Sim/dant/releases/download/{}/{}",asset.version,asset.name)].contains(&asset.url)
}
pub(crate) fn linked(meta:&fs::Metadata)->bool{
 #[cfg(windows)]{use std::os::windows::fs::MetadataExt;meta.file_type().is_symlink()||meta.file_attributes()&0x400!=0}
 #[cfg(not(windows))]{meta.file_type().is_symlink()}
}
pub(crate) fn directory(path:&Path,create:bool)->Result<(),String>{
 if !path.is_absolute(){return Err(FAILED.into())}let mut parents:Vec<_>=path.ancestors().collect();parents.reverse();
 for parent in parents{if !parent.exists()&&create{fs::create_dir(parent).map_err(|_|FAILED)?}let meta=fs::symlink_metadata(parent).map_err(|_|FAILED)?;if !meta.is_dir()||linked(&meta){return Err(FAILED.into())}}Ok(())
}
pub(crate) fn json_file(path:&Path,max:usize)->Result<serde_json::Value,String>{
 directory(path.parent().ok_or(FAILED)?,false)?;let meta=fs::symlink_metadata(path).map_err(|_|FAILED)?;if !meta.is_file()||linked(&meta)||meta.len()>max as u64{return Err(FAILED.into())}let mut bytes=Vec::new();fs::File::open(path).map_err(|_|FAILED)?.take(max as u64+1).read_to_end(&mut bytes).map_err(|_|FAILED)?;if bytes.len()>max{return Err(FAILED.into())}serde_json::from_slice(&bytes).map_err(|_|FAILED.into())
}
pub(crate) fn write_json(path:&Path,value:&impl Serialize)->Result<(),String>{
 let parent=path.parent().ok_or(FAILED)?;directory(parent,true)?;if let Ok(meta)=fs::symlink_metadata(path){if !meta.is_file()||linked(&meta){return Err(FAILED.into())}}
 let mut temp=tempfile::Builder::new().prefix(".update-").tempfile_in(parent).map_err(|_|FAILED)?;temp.write_all(&serde_json::to_vec(value).map_err(|_|FAILED)?).map_err(|_|FAILED)?;temp.as_file().sync_all().map_err(|_|FAILED)?;temp.persist(path).map_err(|_|FAILED)?;Ok(())
}
pub(crate) fn verify_file(path:&Path,asset:&Asset)->Result<(),String>{
 if !valid_asset(asset){return Err(FAILED.into())}directory(path.parent().ok_or(FAILED)?,false)?;let meta=fs::symlink_metadata(path).map_err(|_|FAILED)?;if !meta.is_file()||linked(&meta)||meta.len()!=asset.size{return Err(FAILED.into())}
 let mut file=fs::File::open(path).map_err(|_|FAILED)?;let mut hash=Sha256::new();let mut buffer=[0;65536];let mut total=0;loop{let count=file.read(&mut buffer).map_err(|_|FAILED)?;if count==0{break}total+=count as u64;if total>asset.size{return Err(FAILED.into())}hash.update(&buffer[..count]);}if total!=asset.size||format!("{:x}",hash.finalize())!=asset.sha256{return Err(FAILED.into())}Ok(())
}
fn cache(app:&tauri::AppHandle)->Result<PathBuf,String>{let root=crate::runtime_path(app.path().app_cache_dir().map_err(|_|FAILED)?).join("updates");directory(&root,true)?;Ok(root)}
fn package(root:&Path,asset:&Asset)->Result<PathBuf,String>{let folder=root.join(&asset.sha256);directory(&folder,true)?;Ok(folder.join(&asset.name))}
fn ready(asset:&Asset)->Ready{Ready{ready:true,package_id:asset.sha256.clone(),version:asset.version.clone(),channel:asset.channel.clone(),sha256:asset.sha256.clone(),size:asset.size,name:asset.name.clone()}}
fn token(value:&str)->bool{value.len()==64&&value.bytes().all(|v|v.is_ascii_hexdigit())}
async fn controller_request(route:&str,token:&str,max:usize,method:reqwest::Method,body:Option<&str>)->Result<serde_json::Value,String>{
 if !self::token(token){return Err(FAILED.into())}
 let timeout=if route.starts_with("desktop/"){150}else{60};let client=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(timeout)).build().map_err(|_|FAILED)?;let mut request=client.request(method,format!("http://127.0.0.1:4317/api/{route}")).header("X-Dant-Token",token);if let Some(body)=body{request=request.header("Content-Type","application/json").body(body.to_string());}let mut response=request.send().await.map_err(|_|FAILED)?;if !response.status().is_success(){return Err(FAILED.into())}let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|FAILED)?{if bytes.len()+chunk.len()>max{return Err(FAILED.into())}bytes.extend_from_slice(&chunk)}serde_json::from_slice(&bytes).map_err(|_|FAILED.into())
}
async fn controller(route:&str,token:&str,max:usize)->Result<serde_json::Value,String>{controller_request(route,token,max,reqwest::Method::GET,None).await}
fn stream_payload(input:&mut impl Read,output:&mut impl Write,asset:&Asset,mut report:impl FnMut(u64))->Result<(),String>{
 let mut hash=Sha256::new();let mut total=0;let mut buffer=[0;65536];let mut last=Instant::now();
 loop{let count=input.read(&mut buffer).map_err(|_|FAILED)?;if count==0{break}total+=count as u64;if total>asset.size||total>MAX_INSTALLER{return Err(FAILED.into())}output.write_all(&buffer[..count]).map_err(|_|FAILED)?;hash.update(&buffer[..count]);if last.elapsed()>Duration::from_millis(250){report(total);last=Instant::now();}}
 if total!=asset.size||format!("{:x}",hash.finalize())!=asset.sha256{return Err(FAILED.into())}Ok(())
}
fn download(app:&tauri::AppHandle,root:&Path,asset:&Asset)->Result<(),String>{
 let target=package(root,asset)?;if verify_file(&target,asset).is_ok(){return Ok(())}
 if target.exists(){let meta=fs::symlink_metadata(&target).map_err(|_|FAILED)?;if !meta.is_file()||linked(&meta){return Err(FAILED.into())}}
 let executable=PathBuf::from(std::env::var_os("SystemRoot").ok_or(FAILED)?).join("System32/curl.exe");let meta=fs::symlink_metadata(&executable).map_err(|_|"The Windows HTTPS downloader is unavailable.")?;if !meta.is_file()||linked(&meta){return Err(FAILED.into())}
 let mut command=Command::new(executable);command.args(["-q","--noproxy","*","--proto","=https","--proto-redir","=https","--location","--max-redirs","3","--fail","--silent","--show-error","--connect-timeout","20","--max-time","900","--max-filesize"]).arg(asset.size.to_string()).arg(&asset.url).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());#[cfg(windows)]command.creation_flags(0x08000000);
 let mut child=command.spawn().map_err(|_|FAILED)?;let result=(||{let mut input=child.stdout.take().ok_or(FAILED)?;let mut output=tempfile::Builder::new().prefix(".installer-").tempfile_in(target.parent().ok_or(FAILED)?).map_err(|_|FAILED)?;progress(app,asset,0,"downloading");stream_payload(&mut input,&mut output,asset,|total|progress(app,asset,total,"downloading"))?;
 if !child.wait().map_err(|_|FAILED)?.success(){return Err(FAILED.into())}output.as_file().sync_all().map_err(|_|FAILED)?;output.persist(&target).map_err(|_|FAILED)?;write_json(&target.parent().ok_or(FAILED)?.join("asset.json"),asset)?;Ok(())})();if result.is_err(){let _=child.kill();let _=child.wait();}result
}
#[tauri::command]
pub async fn download_update(app:tauri::AppHandle,window:tauri::WebviewWindow,channel:String,token:String,expected_version:String)->Result<Ready,String>{
 if window.label()!="main"||!matches!(channel.as_str(),"stable"|"beta")||version(&expected_version).is_none(){return Err(FAILED.into())}
 let metadata=controller(&format!("updates?channel={channel}"),&token,65536).await?;let asset:Asset=serde_json::from_value(metadata.get("asset").cloned().ok_or(FAILED)?).map_err(|_|FAILED)?;
 if !valid_asset(&asset)||asset.version!=expected_version||asset.channel!=channel||metadata.get("channel").and_then(|v|v.as_str())!=Some(channel.as_str())||metadata.get("updateAvailable").and_then(|v|v.as_bool())!=Some(true)||!newer(&asset.version,env!("CARGO_PKG_VERSION")){return Err(FAILED.into())}
 let root=cache(&app)?;let state=app.state::<Updates>();if !state.busy.lock().map_err(|_|FAILED)?.insert(channel.clone()){return Err("This update is already downloading.".into())}let handle=app.clone();let selected=asset.clone();
 let outcome=tauri::async_runtime::spawn_blocking(move||download(&handle,&root,&selected)).await.map_err(|_|FAILED.to_string()).and_then(|value|value);state.busy.lock().map_err(|_|FAILED)?.remove(&channel);
 if let Err(error)=outcome{progress(&app,&asset,0,"failed");return Err(error)}state.packages.lock().map_err(|_|FAILED)?.insert(asset.sha256.clone(),asset.clone());progress(&app,&asset,asset.size,"ready");Ok(ready(&asset))
}
pub(crate) fn install_allowed(state:&serde_json::Value)->bool{
 // This is admission to the Controller's pause-and-confirm transaction, not
 // proof that execution has stopped. The authenticated backend lease performs
 // that final check, including fresh VM reads and offline executor witnesses.
 let status=state.pointer("/controller/status").and_then(|value|value.as_str());
 let cached=state.pointer("/controller/cached").and_then(|value|value.as_bool());
 let transport=match(status,cached){(Some("online"),Some(false))|(Some("offline"|"connecting"),Some(true))=>true,_=>false};
 state.get("mode").and_then(|v|v.as_str())==Some("vm-controller")
  && state.pointer("/controller/authority").and_then(|v|v.as_str())==Some("vm")
  && state.pointer("/controller/vmConfigured").and_then(|v|v.as_bool()).is_some()
  && transport
  && state.pointer("/controller/desktopTransition").and_then(|v|v.as_str()).is_some_and(|v|matches!(v,"idle"|"paused"))
  && state.pointer("/controller/serviceUpdateBusy").and_then(|v|v.as_bool())==Some(false)
  && state.pointer("/provisioning/running").and_then(|v|v.as_bool())==Some(false)
  && state.pointer("/provisioning/status").and_then(|v|v.as_str()).is_some_and(|v|matches!(v,"idle"|"ready"|"failed"))
}
#[derive(Serialize)]pub struct InstallResult{launched:bool}
#[derive(Serialize)]pub struct Capabilities{download:bool,install:bool,reason:Option<&'static str>}
fn owns_controller(app:&tauri::AppHandle)->bool{let Some(state)=app.try_state::<crate::Backend>()else{return false};let Ok(mut locked)=state.0.lock()else{return false};locked.as_mut().is_some_and(|child|child.try_wait().is_ok_and(|status|status.is_none()))}
#[tauri::command]
pub fn update_capabilities(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<Capabilities,String>{
 if window.label()!="main"{return Err(FAILED.into())}let installed=!cfg!(debug_assertions)&&crate::update_helper::supported_layout();let own=owns_controller(&app);Ok(Capabilities{download:cfg!(windows),install:installed&&own,reason:if !installed{Some("installed-app-required")}else if !own{Some("owned-controller-required")}else{None}})
}
#[tauri::command]
pub async fn install_update(app:tauri::AppHandle,window:tauri::WebviewWindow,package_id:String,token:String)->Result<InstallResult,String>{
 if window.label()!="main"||cfg!(debug_assertions)||package_id.len()!=64{return Err(BLOCKED.into())}let state=app.state::<Updates>();let asset=state.packages.lock().map_err(|_|FAILED)?.get(&package_id).cloned().ok_or(FAILED)?;
 if !install_allowed(&controller("state",&token,16*1024*1024).await?){return Err(BLOCKED.into())}
 let controller_id={let state=app.state::<crate::Backend>();let mut locked=state.0.lock().map_err(|_|BLOCKED)?;let child=locked.as_mut().ok_or(BLOCKED)?;if child.try_wait().map_err(|_|BLOCKED)?.is_some(){return Err(BLOCKED.into())}child.id()};
 let root=cache(&app)?;let installer=package(&root,&asset)?;verify_file(&installer,&asset)?;
 {let mut installing=state.installing.lock().map_err(|_|FAILED)?;if *installing{return Err("An update installation is already pending.".into())}*installing=true;}
 let lease=controller_request("updates/install-lease",&token,4096,reqwest::Method::POST,Some("{}")).await;
 let lease_id=lease.as_ref().ok().and_then(|value|value.get("leaseId")).and_then(|value|value.as_str()).filter(|value|value.len()==36&&value.bytes().all(|byte|byte.is_ascii_hexdigit()||byte==b'-')).map(str::to_string);
 let Some(lease_id)=lease_id else{*state.installing.lock().map_err(|_|FAILED)?=false;return Err(BLOCKED.into())};
 let body=serde_json::json!({"reason":"install","leaseId":lease_id}).to_string();
 let suspension=controller_request("desktop/exit",&token,4096,reqwest::Method::POST,Some(&body)).await;
 let suspended=suspension.as_ref().is_ok_and(crate::lifecycle::confirmed)&&suspension.as_ref().ok().and_then(|value|value.get("leaseId")).and_then(|value|value.as_str())==Some(lease_id.as_str());
 if !suspended{let _=controller_request("desktop/cancel-exit",&token,4096,reqwest::Method::POST,Some(&body)).await;let _=controller_request(&format!("updates/install-lease/{lease_id}"),&token,4096,reqwest::Method::DELETE,None).await;*state.installing.lock().map_err(|_|FAILED)?=false;return Err(BLOCKED.into())}
 let handle=app.clone();let selected=asset.clone();let job=tauri::async_runtime::spawn_blocking(move||crate::update_helper::prepare(&root,&installer,&selected,controller_id)).await.map_err(|_|FAILED.to_string()).and_then(|v|v);
 let folder=match job{Ok(folder)=>folder,Err(error)=>{let _=controller_request("desktop/cancel-exit",&token,4096,reqwest::Method::POST,Some(&body)).await;let _=controller_request(&format!("updates/install-lease/{lease_id}"),&token,4096,reqwest::Method::DELETE,None).await;*state.installing.lock().map_err(|_|FAILED)?=false;return Err(error)}};
 let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|v|v.as_millis() as u64).unwrap_or(u64::MAX);let lease_fresh=suspension.as_ref().ok().and_then(|value|value.get("expiresAt")).and_then(|value|value.as_u64()).is_some_and(|value|value>now.saturating_add(5000)&&value<=now.saturating_add(35000));
 let authorized=lease_fresh&&owns_controller(&app)&&write_json(&folder.join("go.json"),&serde_json::json!({"authorized":true,"sha256":asset.sha256,"leaseId":lease_id,"expiresAt":suspension.as_ref().ok().and_then(|value|value.get("expiresAt"))})).is_ok();
 if !authorized{let _=write_json(&folder.join("cancel.json"),&true);let _=controller_request("desktop/cancel-exit",&token,4096,reqwest::Method::POST,Some(&body)).await;let _=controller_request(&format!("updates/install-lease/{lease_id}"),&token,4096,reqwest::Method::DELETE,None).await;*state.installing.lock().map_err(|_|FAILED)?=false;return Err(BLOCKED.into())}
 // The install lease already paused work and suspended the VM. The helper owns
 // the exact process handles; do not issue a second suspend during handoff.
 std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(150));crate::lifecycle::prepared_update_exit(&handle);});Ok(InstallResult{launched:true})
}

#[cfg(test)]mod tests{
 use super::*;
 fn asset()->Asset{let data=b"verified installer";Asset{version:"0.5.0-beta.2".into(),channel:"beta".into(),url:"https://github.com/Stephen-Sim/dant/releases/download/v0.5.0-beta.2/dant_0.5.0-beta.2_windows_x64_setup.exe".into(),sha256:format!("{:x}",Sha256::digest(data)),size:data.len() as u64,name:"dant_0.5.0-beta.2_windows_x64_setup.exe".into()}}
 #[test]fn official_asset_and_version_validation_rejects_redirect_injection_and_downgrades(){let a=asset();assert!(valid_asset(&a));for url in [a.url.clone()+"?token=x",a.url.replace("Stephen-Sim","other"),a.url.replace("https:","http:"),a.url.replace("github.com","github.com.evil")]{let mut bad=a.clone();bad.url=url;assert!(!valid_asset(&bad));}let mut bad=a.clone();bad.channel="stable".into();assert!(!valid_asset(&bad));bad=a.clone();bad.size=MAX_INSTALLER+1;assert!(!valid_asset(&bad));assert!(newer("0.5.0","0.5.0-beta.9"));assert!(newer("0.5.0-beta.10","0.5.0-beta.2"));assert!(!newer("0.4.6","0.4.7-beta.1"));for v in ["../0.5.0","01.0.0","0.5.0+build","0.5.0-beta.01","0.5"]{assert!(version(v).is_none());}}
 #[test]fn cached_payload_is_rehashed_and_truncation_tampering_and_links_are_rejected(){let dir=tempfile::tempdir().unwrap();let a=asset();let file=dir.path().join(&a.name);fs::write(&file,b"verified installer").unwrap();assert!(verify_file(&file,&a).is_ok());fs::write(&file,b"tampered installer").unwrap();assert!(verify_file(&file,&a).is_err());fs::write(&file,b"short").unwrap();assert!(verify_file(&file,&a).is_err());assert!(verify_file(dir.path(),&a).is_err());}
 #[test]fn streamed_installer_requires_exact_size_and_digest_before_a_payload_can_be_committed(){let a=asset();for bytes in [&b"verified installer"[..],&b"short"[..],&b"verified installerEXTRA"[..],&b"untrusted contents"[..]]{let mut input=std::io::Cursor::new(bytes);let mut output=Vec::new();let result=stream_payload(&mut input,&mut output,&a,|_|{});assert_eq!(result.is_ok(),bytes==b"verified installer");assert!(output.len()<=a.size as usize);}}
 fn controller_state()->serde_json::Value{serde_json::json!({"mode":"vm-controller","controller":{"status":"online","cached":false,"authority":"vm","vmConfigured":true,"desktopTransition":"idle","serviceUpdateBusy":false},"call":{"id":"call"},"takeover":true,"computer":{"status":"human","sessionId":"lease"},"provisioning":{"status":"ready","running":false},"active":{"status":"running"},"queue":["keep"]})}
 #[test]fn installation_preflight_allows_confirmable_work_but_never_bypasses_controller_or_setup_boundaries(){let state=controller_state();assert!(install_allowed(&state));for(path,value)in [("/controller/cached",serde_json::json!(true)),("/controller/status",serde_json::json!("unknown")),("/controller/authority",serde_json::json!("cache")),("/controller/vmConfigured",serde_json::Value::Null),("/controller/desktopTransition",serde_json::json!("suspending")),("/controller/serviceUpdateBusy",serde_json::json!(true)),("/provisioning/status",serde_json::json!("creating")),("/provisioning/running",serde_json::json!(true)),("/mode",serde_json::json!("vm-worker"))]{let mut changed=state.clone();*changed.pointer_mut(path).unwrap()=value;assert!(!install_allowed(&changed),"{path}");}}
 #[test]fn installation_without_a_vm_reaches_the_backend_lease_instead_of_requiring_a_vm_connection(){let mut state=controller_state();state["controller"]["vmConfigured"]=serde_json::json!(false);state["controller"]["status"]=serde_json::json!("offline");state["controller"]["cached"]=serde_json::json!(true);state["worker"]=serde_json::json!({"status":"offline"});state["active"]=serde_json::Value::Null;state["call"]=serde_json::Value::Null;state["queue"]=serde_json::json!([]);assert!(install_allowed(&state));}
 #[test]fn stopped_executor_and_disconnected_vm_can_request_a_fresh_backend_pause_witness(){for worker in ["offline","connecting"]{let mut state=controller_state();state["worker"]=serde_json::json!({"status":worker});assert!(install_allowed(&state),"the backend, not stale executor metadata, must decide {worker}");}for status in ["offline","connecting"]{let mut state=controller_state();state["controller"]["status"]=serde_json::json!(status);state["controller"]["cached"]=serde_json::json!(true);assert!(install_allowed(&state));state["controller"]["authority"]=serde_json::json!("cache");assert!(!install_allowed(&state));}}
}
