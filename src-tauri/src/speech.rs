use std::{io::Write, process::{Child, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use base64::{Engine, engine::general_purpose::STANDARD};
use tauri::State;
use tauri::Manager;
use std::{fs, path::{Path,PathBuf}, time::{SystemTime,UNIX_EPOCH}};
#[cfg(windows)] use std::os::windows::process::CommandExt;

#[derive(Clone, Default)]
pub struct SpeechProcess(pub Arc<Mutex<Option<Child>>>,pub Arc<AtomicU64>);

const CODES: &[&str] = &["speech-output-unavailable","speech-input-unavailable","speech-language-unavailable","speech-unavailable","speech-timeout","speech-cancelled","speech-too-long","speech-response-invalid","speech-busy","speech-invalid-request"];
const PHASES: &[&str] = &["request","load","recognition-input","recognition-run","voice-selection","speak-output","speak-run","process-start","request-write","process-wait","process-response","finished"];
static DIAGNOSTIC_LOCK:Mutex<()>=Mutex::new(());
#[derive(Debug,Clone,PartialEq)]
struct SpeechFailure { code: &'static str, phase: &'static str, numeric_code: Option<i64> }
fn failed(code: &'static str, phase: &'static str) -> SpeechFailure { SpeechFailure { code,phase,numeric_code:None } }
fn response_result(success: bool, bytes: &[u8]) -> Result<String,SpeechFailure> {
    if bytes.len()>65536 { return Err(failed("speech-response-invalid","process-response")) }
    let value:serde_json::Value=serde_json::from_slice(bytes).map_err(|_|failed("speech-response-invalid","process-response"))?;
    if !success {
        let code=CODES.iter().find(|code|Some(**code)==value.get("errorCode").and_then(|v|v.as_str())).copied().unwrap_or("speech-unavailable");
        let phase=PHASES.iter().find(|phase|Some(**phase)==value.get("phase").and_then(|v|v.as_str())).copied().unwrap_or("process-response");
        return Err(SpeechFailure {code,phase,numeric_code:value.get("numericCode").and_then(|v|v.as_i64()).filter(|v|*v>=i32::MIN as i64&&*v<=u32::MAX as i64)});
    }
    if !value.is_object() { return Err(failed("speech-response-invalid","process-response")) }
    let text=value.get("text").and_then(|v|v.as_str()).unwrap_or("");
    if text.chars().count()>10000 { return Err(failed("speech-response-invalid","process-response")) } Ok(text.to_string())
}
fn linked(meta:&fs::Metadata)->bool {
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;meta.file_type().is_symlink()||meta.file_attributes()&0x400!=0}
    #[cfg(not(windows))] {meta.file_type().is_symlink()}
}
fn one_link(file:&fs::File)->bool {
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)] struct Info {attributes:u32,created:[u32;2],accessed:[u32;2],written:[u32;2],volume:u32,size_high:u32,size_low:u32,links:u32,index_high:u32,index_low:u32}
        #[link(name="kernel32")] extern "system" {fn GetFileInformationByHandle(file:*mut core::ffi::c_void,info:*mut Info)->i32;}
        let mut info=std::mem::MaybeUninit::<Info>::uninit();unsafe {GetFileInformationByHandle(file.as_raw_handle(),info.as_mut_ptr())!=0&&info.assume_init().links==1}
    }
    #[cfg(unix)] {use std::os::unix::fs::MetadataExt;file.metadata().is_ok_and(|m|m.nlink()==1)}
    #[cfg(not(any(windows,unix)))] {false}
}
fn ordinary_parent(parent:&Path)->std::io::Result<()> {
    if !parent.is_absolute(){return Err(std::io::ErrorKind::InvalidInput.into())}
    let mut chain:Vec<_>=parent.ancestors().collect();chain.reverse();for directory in chain {if !directory.exists(){fs::create_dir(directory)?}let meta=fs::symlink_metadata(directory)?;if !meta.is_dir()||linked(&meta){return Err(std::io::ErrorKind::InvalidInput.into())}}Ok(())
}
fn diagnostic_file(app:&tauri::AppHandle)->Option<PathBuf> {
    let data=if let Some(value)=std::env::var_os("DANT_DATA"){PathBuf::from(value)}else if cfg!(debug_assertions){PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent()?.join("data")}else{app.path().app_data_dir().ok()?.join("data")};
    let data=crate::runtime_path(data);Some(if data.is_absolute(){data}else{std::env::current_dir().ok()?.join(data)}.join("native-speech.jsonl"))
}
fn append_diagnostic(path:&Path,mode:&str,language:&str,outcome:&Result<String,SpeechFailure>,now:u64)->std::io::Result<()> {
    use std::io::Read;
    let _guard=DIAGNOSTIC_LOCK.lock().map_err(|_|std::io::ErrorKind::Other)?;
    if !["recognize","speak","capabilities"].contains(&mode)||!crate::l10n::supported(language){return Err(std::io::ErrorKind::InvalidInput.into())}
    let parent=path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;ordinary_parent(parent)?;
    let mut records=Vec::new();
    if let Ok(meta)=fs::symlink_metadata(path){
        if !meta.is_file()||linked(&meta)||meta.len()>65536{return Err(std::io::ErrorKind::InvalidInput.into())}
        let file=fs::File::open(path)?;if !one_link(&file){return Err(std::io::ErrorKind::InvalidInput.into())}let mut bytes=Vec::new();file.take(65537).read_to_end(&mut bytes)?;if bytes.len()>65536{return Err(std::io::ErrorKind::InvalidInput.into())}
        for line in bytes.split(|byte|*byte==b'\n'){if line.len()>512{continue}if let Ok(value)=serde_json::from_slice::<serde_json::Value>(line){
            if let Some(at)=value.get("at").and_then(|v|v.as_u64()){if at<=now&&now-at<3*86400000&&value.get("schema").and_then(|v|v.as_str())==Some("dant.native-speech.v1") {
                let string=|key|value.get(key).and_then(|v|v.as_str());
                if string("event")==Some("speech.operation")&&string("mode").is_some_and(|v|["recognize","speak","capabilities"].contains(&v))&&string("language").is_some_and(crate::l10n::supported)&&string("phase").is_some_and(|v|PHASES.contains(&v))&&string("status").is_some_and(|v|["completed","failed"].contains(&v))&&string("reason").is_some_and(|v|v=="ok"||CODES.contains(&v)){
                    records.push(serde_json::json!({"schema":"dant.native-speech.v1","event":"speech.operation","at":at,"mode":string("mode"),"language":string("language"),"phase":string("phase"),"status":string("status"),"reason":string("reason"),"numericCode":value.get("numericCode").and_then(|v|v.as_i64()).filter(|v|*v>=i32::MIN as i64&&*v<=u32::MAX as i64)}));
                }
            }}
        }}
    }
    let error=outcome.as_ref().err();let row=serde_json::json!({"schema":"dant.native-speech.v1","event":"speech.operation","at":now,"mode":mode,"language":language,"phase":error.map(|e|e.phase).unwrap_or("finished"),"status":if outcome.is_ok(){"completed"}else{"failed"},"reason":error.map(|e|e.code).unwrap_or("ok"),"numericCode":error.and_then(|e|e.numeric_code)});
    records.push(row);if records.len()>128{records.drain(..records.len()-128);}
    let mut bytes=Vec::new();for value in records{serde_json::to_writer(&mut bytes,&value)?;bytes.push(b'\n')}if bytes.len()>65536{return Err(std::io::ErrorKind::InvalidData.into())}
    if let Ok(meta)=fs::symlink_metadata(path){if !meta.is_file()||linked(&meta)||!one_link(&fs::File::open(path)?){return Err(std::io::ErrorKind::InvalidInput.into())}}
    let mut temporary=tempfile::Builder::new().prefix(".native-speech-").tempfile_in(parent)?;temporary.write_all(&bytes)?;temporary.as_file().sync_all()?;temporary.persist(path).map_err(|error|error.error)?;Ok(())
}

#[tauri::command]
pub async fn speech_start(app:tauri::AppHandle, window: tauri::WebviewWindow, mode: String, language: String, text: Option<String>, process: State<'_, SpeechProcess>) -> Result<String, String> {
    if window.label() != "main" { return Err("speech-invalid-request".into()); }
    if !cfg!(windows) { return Err("speech-unavailable".into()); }
    if !matches!(mode.as_str(), "recognize" | "speak" | "capabilities") || !crate::l10n::supported(&language) { return Err("speech-invalid-request".into()); }
    if text.as_ref().is_some_and(|value| value.chars().count() > 10000) { return Err("speech-too-long".into()); }
    let shared = process.inner().clone();let diagnostic_path=diagnostic_file(&app);
    tauri::async_runtime::spawn_blocking(move || {
      let outcome=(|| -> Result<String,SpeechFailure> {
        let input = serde_json::json!({"mode": mode, "language": language, "locale": crate::l10n::speech_locale(&language), "text": text}).to_string();
        let script = include_str!("../../native/speech.ps1");
        let encoded = STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
        let executable = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(executable);
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] command.creation_flags(0x08000000);
        let generation;
        {
            let mut slot = shared.0.lock().map_err(|_|failed("speech-unavailable","process-start"))?;
            if slot.is_some() { return Err(failed("speech-busy","process-start")); }
            generation=shared.1.fetch_add(1,Ordering::SeqCst)+1;
            let mut child = command.spawn().map_err(|_|failed("speech-unavailable","process-start"))?;
            if let Some(mut input_pipe) = child.stdin.take() { if input_pipe.write_all(input.as_bytes()).is_err() { let _ = child.kill(); let _ = child.wait(); return Err(failed("speech-unavailable","request-write")); } }
            *slot = Some(child);
        }
        let deadline = Instant::now() + Duration::from_secs(if mode == "speak" {120} else {25});
        loop {
            let mut slot = shared.0.lock().map_err(|_|failed("speech-unavailable","process-wait"))?;
            if shared.1.load(Ordering::SeqCst)!=generation { return Err(failed("speech-cancelled","process-wait")); }
            let Some(child) = slot.as_mut() else { return Err(failed("speech-cancelled","process-wait")); };
            if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); *slot = None; return Err(failed("speech-timeout","process-wait")); }
            if child.try_wait().map_err(|_|failed("speech-unavailable","process-wait"))?.is_some() {
                let completed = slot.take().unwrap().wait_with_output().map_err(|_|failed("speech-response-invalid","process-response"))?;
                return response_result(completed.status.success(),&completed.stdout);
            }
            drop(slot);std::thread::sleep(Duration::from_millis(100));
        }
      })();
      if let Some(path)=diagnostic_path{let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;let _=append_diagnostic(&path,&mode,&language,&outcome,now);}
      outcome.map_err(|error|error.code.to_string())
    }).await.map_err(|_| "speech-unavailable".to_string())?
}

pub fn stop(process: &SpeechProcess) { if let Ok(mut slot) = process.0.lock() { process.1.fetch_add(1,Ordering::SeqCst);if let Some(mut child) = slot.take() { let _ = child.kill(); let _ = child.wait(); } } }
#[tauri::command]
pub fn speech_stop(window: tauri::WebviewWindow, process: State<'_, SpeechProcess>) -> Result<(), String> { if window.label() != "main" { return Err("Native speech requires the main window".into()); } stop(&process); Ok(()) }

#[cfg(test)]
mod tests {
 use super::*;
 fn fixture()->tempfile::TempDir {let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".cache/tests");fs::create_dir_all(&root).unwrap();tempfile::tempdir_in(root).unwrap()}
 #[test] fn responses_accept_only_stable_metadata_never_raw_exceptions(){
  let error=response_result(false,br#"{"errorCode":"speech-output-unavailable","phase":"speak-run","numericCode":2,"error":"PRIVATE secret transcript /path"}"#).unwrap_err();assert_eq!(error,SpeechFailure{code:"speech-output-unavailable",phase:"speak-run",numeric_code:Some(2)});
  let untrusted=response_result(false,br#"{"errorCode":"PRIVATE transcript","phase":"/private/path","numericCode":"secret","error":"raw secret"}"#).unwrap_err();assert_eq!(untrusted,failed("speech-unavailable","process-response"));
  assert_eq!(response_result(true,br#"{"text":"recognized text"}"#).unwrap(),"recognized text");assert!(response_result(true,b"invalid").is_err());assert!(response_result(true,&vec![b'a';65537]).is_err());
 }
 #[test] fn diagnostics_are_bounded_metadata_with_retention_and_no_text(){
  let directory=fixture();let file=directory.path().join("data/native-speech.jsonl");let outcome=Err(SpeechFailure{code:"speech-output-unavailable",phase:"speak-run",numeric_code:Some(2)});
  append_diagnostic(&file,"speak","zh",&outcome,100).unwrap();let mut row:serde_json::Value=serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();row["raw"]=serde_json::json!("PRIVATE spoken text /path");fs::write(&file,format!("{row}\n")).unwrap();append_diagnostic(&file,"speak","zh",&outcome,200).unwrap();assert!(!fs::read_to_string(&file).unwrap().contains("PRIVATE"));
  for index in 0..140{append_diagnostic(&file,"speak","en",&outcome,300+index).unwrap();}let text=fs::read_to_string(&file).unwrap();assert_eq!(text.lines().count(),128);assert!(text.len()<=65536);assert!(!text.contains("transcript"));
  append_diagnostic(&file,"speak","zh",&Ok("PRIVATE successful spoken text".into()),3*86400000+1000).unwrap();let lines=fs::read_to_string(&file).unwrap();assert_eq!(lines.lines().count(),1);assert!(!lines.contains("PRIVATE"));assert!(lines.contains("completed"));
 }
 #[test] fn diagnostics_reject_hardlinks_symlinks_and_oversize_without_affecting_result(){
  let directory=fixture();let original=directory.path().join("original");let linked_file=directory.path().join("linked");fs::write(&original,b"preserve").unwrap();fs::hard_link(&original,&linked_file).unwrap();let outcome=Err(failed("speech-output-unavailable","speak-output"));assert!(append_diagnostic(&linked_file,"speak","zh",&outcome,100).is_err());assert_eq!(fs::read(&original).unwrap(),b"preserve");
  #[cfg(windows)] {use std::os::windows::fs::symlink_file;if symlink_file(&original,directory.path().join("symlink")).is_ok(){assert!(append_diagnostic(&directory.path().join("symlink"),"speak","zh",&outcome,100).is_err());}}
  let oversized=directory.path().join("oversized");fs::write(&oversized,vec![b'a';65537]).unwrap();assert!(append_diagnostic(&oversized,"speak","zh",&outcome,100).is_err());assert_eq!(outcome.unwrap_err().code,"speech-output-unavailable");
 }
}
