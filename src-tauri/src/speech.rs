use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri::State;

#[derive(Clone, Default)]
pub struct SpeechProcess(pub Arc<Mutex<Option<Child>>>, pub Arc<AtomicU64>);

const CODES: &[&str] = &[
    "speech-output-unavailable",
    "speech-input-unavailable",
    "speech-language-unavailable",
    "speech-unavailable",
    "speech-timeout",
    "speech-cancelled",
    "speech-too-long",
    "speech-response-invalid",
    "speech-busy",
    "speech-invalid-request",
];
const PHASES: &[&str] = &[
    "request",
    "load",
    "recognition-input",
    "recognition-run",
    "voice-selection",
    "speak-output",
    "speak-run",
    "process-start",
    "request-write",
    "process-wait",
    "process-response",
    "finished",
];
static DIAGNOSTIC_LOCK: Mutex<()> = Mutex::new(());
const MAX_DIAGNOSTIC_BYTES: u64 = 65_536;
const DIAGNOSTIC_PERSIST_ATTEMPTS: usize = 6;
const DIAGNOSTIC_RETRY_DELAY_MS: u64 = 20;
const WINDOWS_ACCESS_DENIED: i32 = 5;
const WINDOWS_SHARING_VIOLATION: i32 = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp {
    identity: FileIdentity,
    length: u64,
    modified: SystemTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DiagnosticPathIdentity {
    parent: FileIdentity,
    target: Option<FileStamp>,
}
#[derive(Debug, Clone, PartialEq)]
struct SpeechFailure {
    code: &'static str,
    phase: &'static str,
    numeric_code: Option<i64>,
}
fn failed(code: &'static str, phase: &'static str) -> SpeechFailure {
    SpeechFailure {
        code,
        phase,
        numeric_code: None,
    }
}
fn response_result(success: bool, bytes: &[u8]) -> Result<String, SpeechFailure> {
    if bytes.len() > 65536 {
        return Err(failed("speech-response-invalid", "process-response"));
    }
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| failed("speech-response-invalid", "process-response"))?;
    if !success {
        let code = CODES
            .iter()
            .find(|code| Some(**code) == value.get("errorCode").and_then(|v| v.as_str()))
            .copied()
            .unwrap_or("speech-unavailable");
        let phase = PHASES
            .iter()
            .find(|phase| Some(**phase) == value.get("phase").and_then(|v| v.as_str()))
            .copied()
            .unwrap_or("process-response");
        return Err(SpeechFailure {
            code,
            phase,
            numeric_code: value
                .get("numericCode")
                .and_then(|v| v.as_i64())
                .filter(|v| *v >= i32::MIN as i64 && *v <= u32::MAX as i64),
        });
    }
    if !value.is_object() {
        return Err(failed("speech-response-invalid", "process-response"));
    }
    let text = value.get("text").and_then(|v| v.as_str()).unwrap_or("");
    if text.chars().count() > 10000 {
        return Err(failed("speech-response-invalid", "process-response"));
    }
    Ok(text.to_string())
}
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn file_information(file: &fs::File) -> std::io::Result<(FileIdentity, u64)> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Info {
            attributes: u32,
            created: [u32; 2],
            accessed: [u32; 2],
            written: [u32; 2],
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(file: *mut core::ffi::c_void, info: *mut Info) -> i32;
        }
        let mut info = std::mem::MaybeUninit::<Info>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        Ok((
            FileIdentity {
                volume: info.volume as u64,
                index: ((info.index_high as u64) << 32) | info.index_low as u64,
            },
            info.links as u64,
        ))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata()?;
        Ok((
            FileIdentity {
                volume: meta.dev(),
                index: meta.ino(),
            },
            meta.nlink(),
        ))
    }
    #[cfg(not(any(windows, unix)))]
    {
        Err(std::io::ErrorKind::Unsupported.into())
    }
}
fn one_link(file: &fs::File) -> bool {
    file_information(file).is_ok_and(|(_, links)| links == 1)
}

fn parent_identity(parent: &Path) -> std::io::Result<FileIdentity> {
    if !parent.is_absolute() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    for directory in parent.ancestors() {
        let meta = fs::symlink_metadata(directory)?;
        if !meta.is_dir() || linked(&meta) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the directory itself, never a substituted junction/reparse target.
        const DIRECTORY_AND_REPARSE_POINT: u32 = 0x02000000 | 0x00200000;
        options.custom_flags(DIRECTORY_AND_REPARSE_POINT);
    }
    let directory = options.open(parent)?;
    let meta = directory.metadata()?;
    if !meta.is_dir() || linked(&meta) {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    Ok(file_information(&directory)?.0)
}

fn file_stamp(file: &fs::File) -> std::io::Result<FileStamp> {
    let meta = file.metadata()?;
    let (identity, links) = file_information(file)?;
    if !meta.is_file() || linked(&meta) || meta.len() > MAX_DIAGNOSTIC_BYTES || links != 1 {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    Ok(FileStamp {
        identity,
        length: meta.len(),
        modified: meta.modified()?,
    })
}

fn diagnostic_target(path: &Path) -> std::io::Result<Option<FileStamp>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !meta.is_file() || linked(&meta) || meta.len() > MAX_DIAGNOSTIC_BYTES {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const OPEN_REPARSE_POINT: u32 = 0x00200000;
        options.custom_flags(OPEN_REPARSE_POINT);
    }
    file_stamp(&options.open(path)?).map(Some)
}

fn diagnostic_identity(path: &Path) -> std::io::Result<DiagnosticPathIdentity> {
    let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    Ok(DiagnosticPathIdentity {
        parent: parent_identity(parent)?,
        target: diagnostic_target(path)?,
    })
}

fn persist_diagnostic_with(
    path: &Path,
    mut temporary: tempfile::NamedTempFile,
    expected: DiagnosticPathIdentity,
    windows: bool,
    mut persist: impl FnMut(tempfile::NamedTempFile, &Path) -> Result<fs::File, tempfile::PersistError>,
    mut wait: impl FnMut(Duration),
) -> std::io::Result<()> {
    if temporary.path().parent() != path.parent() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let temporary_stamp = file_stamp(temporary.as_file())?;
    for attempt in 0..DIAGNOSTIC_PERSIST_ATTEMPTS {
        if diagnostic_identity(path)? != expected
            || diagnostic_target(temporary.path())? != Some(temporary_stamp)
        {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        match persist(temporary, path) {
            Ok(_) => return Ok(()),
            Err(failure) => {
                let tempfile::PersistError { error, file } = failure;
                if !windows
                    || !matches!(
                        error.raw_os_error(),
                        Some(WINDOWS_ACCESS_DENIED) | Some(WINDOWS_SHARING_VIOLATION)
                    )
                    || attempt + 1 == DIAGNOSTIC_PERSIST_ATTEMPTS
                {
                    return Err(error);
                }
                temporary = file;
                wait(Duration::from_millis(
                    DIAGNOSTIC_RETRY_DELAY_MS * (attempt as u64 + 1),
                ));
            }
        }
    }
    unreachable!("The last persist attempt always returns");
}
fn ordinary_parent(parent: &Path) -> std::io::Result<()> {
    if !parent.is_absolute() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut chain: Vec<_> = parent.ancestors().collect();
    chain.reverse();
    for directory in chain {
        if !directory.exists() {
            fs::create_dir(directory)?
        }
        let meta = fs::symlink_metadata(directory)?;
        if !meta.is_dir() || linked(&meta) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
    }
    Ok(())
}
fn diagnostic_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let data = if let Some(value) = std::env::var_os("DANT_DATA") {
        PathBuf::from(value)
    } else if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("data")
    } else {
        app.path().app_data_dir().ok()?.join("data")
    };
    let data = crate::runtime_path(data);
    Some(
        if data.is_absolute() {
            data
        } else {
            std::env::current_dir().ok()?.join(data)
        }
        .join("native-speech.jsonl"),
    )
}
fn append_diagnostic(
    path: &Path,
    mode: &str,
    language: &str,
    outcome: &Result<String, SpeechFailure>,
    now: u64,
) -> std::io::Result<()> {
    use std::io::Read;
    let _guard = DIAGNOSTIC_LOCK
        .lock()
        .map_err(|_| std::io::ErrorKind::Other)?;
    if !["recognize", "speak", "capabilities"].contains(&mode) || !crate::l10n::supported(language)
    {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    ordinary_parent(parent)?;
    let identity = diagnostic_identity(path)?;
    let mut records = Vec::new();
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.is_file() || linked(&meta) || meta.len() > MAX_DIAGNOSTIC_BYTES {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        let file = fs::File::open(path)?;
        if !one_link(&file) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_DIAGNOSTIC_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_DIAGNOSTIC_BYTES {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        for line in bytes.split(|byte| *byte == b'\n') {
            if line.len() > 512 {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
                if let Some(at) = value.get("at").and_then(|v| v.as_u64()) {
                    if at <= now
                        && now - at < 3 * 86400000
                        && value.get("schema").and_then(|v| v.as_str())
                            == Some("dant.native-speech.v1")
                    {
                        let string = |key| value.get(key).and_then(|v| v.as_str());
                        if string("event") == Some("speech.operation")
                            && string("mode").is_some_and(|v| {
                                ["recognize", "speak", "capabilities"].contains(&v)
                            })
                            && string("language").is_some_and(crate::l10n::supported)
                            && string("phase").is_some_and(|v| PHASES.contains(&v))
                            && string("status")
                                .is_some_and(|v| ["completed", "failed"].contains(&v))
                            && string("reason").is_some_and(|v| v == "ok" || CODES.contains(&v))
                        {
                            records.push(serde_json::json!({"schema":"dant.native-speech.v1","event":"speech.operation","at":at,"mode":string("mode"),"language":string("language"),"phase":string("phase"),"status":string("status"),"reason":string("reason"),"numericCode":value.get("numericCode").and_then(|v|v.as_i64()).filter(|v|*v>=i32::MIN as i64&&*v<=u32::MAX as i64)}));
                        }
                    }
                }
            }
        }
    }
    let error = outcome.as_ref().err();
    let row = serde_json::json!({"schema":"dant.native-speech.v1","event":"speech.operation","at":now,"mode":mode,"language":language,"phase":error.map(|e|e.phase).unwrap_or("finished"),"status":if outcome.is_ok(){"completed"}else{"failed"},"reason":error.map(|e|e.code).unwrap_or("ok"),"numericCode":error.and_then(|e|e.numeric_code)});
    records.push(row);
    if records.len() > 128 {
        records.drain(..records.len() - 128);
    }
    let mut bytes = Vec::new();
    for value in records {
        serde_json::to_writer(&mut bytes, &value)?;
        bytes.push(b'\n')
    }
    if bytes.len() as u64 > MAX_DIAGNOSTIC_BYTES {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".native-speech-")
        .tempfile_in(parent)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    persist_diagnostic_with(
        path,
        temporary,
        identity,
        cfg!(windows),
        |file, target| file.persist(target),
        std::thread::sleep,
    )
}

#[tauri::command]
pub async fn speech_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    mode: String,
    language: String,
    text: Option<String>,
    process: State<'_, SpeechProcess>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("speech-invalid-request".into());
    }
    if !cfg!(windows) {
        return Err("speech-unavailable".into());
    }
    if !matches!(mode.as_str(), "recognize" | "speak" | "capabilities")
        || !crate::l10n::supported(&language)
    {
        return Err("speech-invalid-request".into());
    }
    if text
        .as_ref()
        .is_some_and(|value| value.chars().count() > 10000)
    {
        return Err("speech-too-long".into());
    }
    let shared = process.inner().clone();
    let diagnostic_path = diagnostic_file(&app);
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

pub fn stop(process: &SpeechProcess) {
    if let Ok(mut slot) = process.0.lock() {
        process.1.fetch_add(1, Ordering::SeqCst);
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[tauri::command]
pub fn speech_stop(
    window: tauri::WebviewWindow,
    process: State<'_, SpeechProcess>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Native speech requires the main window".into());
    }
    stop(&process);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    fn fixture() -> tempfile::TempDir {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".cache/tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    fn rotation_fixture() -> (
        tempfile::TempDir,
        PathBuf,
        tempfile::NamedTempFile,
        DiagnosticPathIdentity,
    ) {
        let directory = fixture();
        let parent = directory.path().join("data");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("native-speech.jsonl");
        fs::write(&path, b"previous metadata").unwrap();
        let identity = diagnostic_identity(&path).unwrap();
        let mut temporary = tempfile::NamedTempFile::new_in(&parent).unwrap();
        temporary.write_all(b"replacement metadata").unwrap();
        temporary.as_file().sync_all().unwrap();
        (directory, path, temporary, identity)
    }
    #[test]
    fn diagnostic_rotation_retries_only_the_same_metadata_after_windows_sharing_failures() {
        let (_directory, path, temporary, identity) = rotation_fixture();
        let mut attempts = 0;
        let mut waits = Vec::new();
        let committed = RefCell::new(Vec::new());
        persist_diagnostic_with(
            &path,
            temporary,
            identity,
            true,
            |file, _target| {
                attempts += 1;
                assert_eq!(fs::read(file.path()).unwrap(), b"replacement metadata");
                if attempts <= 2 {
                    return Err(tempfile::PersistError {
                        error: std::io::Error::from_raw_os_error(WINDOWS_SHARING_VIOLATION),
                        file,
                    });
                }
                // The injected commit records the payload; the existing 140-write
                // retention test separately exercises the real atomic rename.
                committed.replace(fs::read(file.path()).unwrap());
                Ok(file.into_file())
            },
            |delay| waits.push(delay),
        )
        .unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(
            waits,
            [Duration::from_millis(20), Duration::from_millis(40)]
        );
        assert_eq!(*committed.borrow(), b"replacement metadata");
        assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
    }
    #[test]
    fn diagnostic_rotation_never_retries_other_errors_or_platforms_and_has_a_fixed_attempt_limit() {
        for (windows, code, expected_attempts) in [
            (false, WINDOWS_ACCESS_DENIED, 1),
            (false, WINDOWS_SHARING_VIOLATION, 1),
            (true, 13, 1),
            (true, 112, 1),
            (true, WINDOWS_ACCESS_DENIED, DIAGNOSTIC_PERSIST_ATTEMPTS),
            (true, WINDOWS_SHARING_VIOLATION, DIAGNOSTIC_PERSIST_ATTEMPTS),
        ] {
            let (_directory, path, temporary, identity) = rotation_fixture();
            let mut attempts = 0;
            let mut waits = Vec::new();
            let result = persist_diagnostic_with(
                &path,
                temporary,
                identity,
                windows,
                |file, _target| {
                    attempts += 1;
                    Err(tempfile::PersistError {
                        error: std::io::Error::from_raw_os_error(code),
                        file,
                    })
                },
                |delay| waits.push(delay),
            );
            assert_eq!(result.unwrap_err().raw_os_error(), Some(code));
            assert_eq!(attempts, expected_attempts);
            assert_eq!(waits.len(), expected_attempts - 1);
            assert!(waits.iter().sum::<Duration>() <= Duration::from_millis(300));
            assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
            assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        }
    }
    #[test]
    fn diagnostic_rotation_refuses_rebound_targets_parents_links_and_modified_temporary_files_before_retry(
    ) {
        for change in ["target", "replacement", "hardlink", "temporary"] {
            let (directory, path, temporary, identity) = rotation_fixture();
            let temporary_path = temporary.path().to_path_buf();
            let protected = directory.path().join("protected.txt");
            fs::write(&protected, b"protected").unwrap();
            let mut attempts = 0;
            let result = persist_diagnostic_with(
                &path,
                temporary,
                identity,
                true,
                |file, _target| {
                    attempts += 1;
                    Err(tempfile::PersistError {
                        error: std::io::Error::from_raw_os_error(WINDOWS_SHARING_VIOLATION),
                        file,
                    })
                },
                |_delay| match change {
                    "target" => {
                        fs::write(&path, b"changed metadata with a different length").unwrap()
                    }
                    "replacement" => {
                        fs::rename(&path, directory.path().join("previous-kept.jsonl")).unwrap();
                        fs::write(&path, b"previous metadata").unwrap();
                    }
                    "hardlink" => {
                        fs::remove_file(&path).unwrap();
                        fs::hard_link(&protected, &path).unwrap();
                    }
                    "temporary" => fs::write(
                        &temporary_path,
                        b"modified temporary payload with a different length",
                    )
                    .unwrap(),
                    _ => unreachable!(),
                },
            );
            assert_eq!(
                result.unwrap_err().kind(),
                std::io::ErrorKind::InvalidInput,
                "{change}"
            );
            assert_eq!(attempts, 1, "{change}");
            assert_eq!(fs::read(&protected).unwrap(), b"protected");
        }
        // Windows prevents moving a directory while its staging file is open.
        // Model a real parent rebind between the initial identity capture and
        // staging-file creation instead, retaining the exact same target inode.
        let directory = fixture();
        let parent = directory.path().join("data");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("native-speech.jsonl");
        fs::write(&path, b"previous metadata").unwrap();
        let identity = diagnostic_identity(&path).unwrap();
        let previous = directory.path().join("previous-data");
        fs::rename(&parent, &previous).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::rename(previous.join("native-speech.jsonl"), &path).unwrap();
        assert_eq!(diagnostic_target(&path).unwrap(), identity.target);
        let mut temporary = tempfile::NamedTempFile::new_in(&parent).unwrap();
        temporary.write_all(b"replacement metadata").unwrap();
        temporary.as_file().sync_all().unwrap();
        let result = persist_diagnostic_with(
            &path,
            temporary,
            identity,
            true,
            |_file, _target| panic!("A rebound parent must never reach the rename operation"),
            |_delay| panic!("Identity rejection must never be retried"),
        );
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
    }
    #[test]
    fn responses_accept_only_stable_metadata_never_raw_exceptions() {
        let error=response_result(false,br#"{"errorCode":"speech-output-unavailable","phase":"speak-run","numericCode":2,"error":"PRIVATE secret transcript /path"}"#).unwrap_err();
        assert_eq!(
            error,
            SpeechFailure {
                code: "speech-output-unavailable",
                phase: "speak-run",
                numeric_code: Some(2)
            }
        );
        let untrusted=response_result(false,br#"{"errorCode":"PRIVATE transcript","phase":"/private/path","numericCode":"secret","error":"raw secret"}"#).unwrap_err();
        assert_eq!(untrusted, failed("speech-unavailable", "process-response"));
        assert_eq!(
            response_result(true, br#"{"text":"recognized text"}"#).unwrap(),
            "recognized text"
        );
        assert!(response_result(true, b"invalid").is_err());
        assert!(response_result(true, &vec![b'a'; 65537]).is_err());
    }
    #[test]
    fn diagnostics_are_bounded_metadata_with_retention_and_no_text() {
        let directory = fixture();
        let file = directory.path().join("data/native-speech.jsonl");
        let outcome = Err(SpeechFailure {
            code: "speech-output-unavailable",
            phase: "speak-run",
            numeric_code: Some(2),
        });
        append_diagnostic(&file, "speak", "zh", &outcome, 100).unwrap();
        let mut row: serde_json::Value =
            serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
        row["raw"] = serde_json::json!("PRIVATE spoken text /path");
        fs::write(&file, format!("{row}\n")).unwrap();
        append_diagnostic(&file, "speak", "zh", &outcome, 200).unwrap();
        assert!(!fs::read_to_string(&file).unwrap().contains("PRIVATE"));
        for index in 0..140 {
            append_diagnostic(&file, "speak", "en", &outcome, 300 + index).unwrap();
        }
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text.lines().count(), 128);
        assert!(text.len() <= 65536);
        assert!(!text.contains("transcript"));
        append_diagnostic(
            &file,
            "speak",
            "zh",
            &Ok("PRIVATE successful spoken text".into()),
            3 * 86400000 + 1000,
        )
        .unwrap();
        let lines = fs::read_to_string(&file).unwrap();
        assert_eq!(lines.lines().count(), 1);
        assert!(!lines.contains("PRIVATE"));
        assert!(lines.contains("completed"));
    }
    #[test]
    fn diagnostics_reject_hardlinks_symlinks_and_oversize_without_affecting_result() {
        let directory = fixture();
        let original = directory.path().join("original");
        let linked_file = directory.path().join("linked");
        fs::write(&original, b"preserve").unwrap();
        fs::hard_link(&original, &linked_file).unwrap();
        let outcome = Err(failed("speech-output-unavailable", "speak-output"));
        assert!(append_diagnostic(&linked_file, "speak", "zh", &outcome, 100).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"preserve");
        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_file;
            if symlink_file(&original, directory.path().join("symlink")).is_ok() {
                assert!(append_diagnostic(
                    &directory.path().join("symlink"),
                    "speak",
                    "zh",
                    &outcome,
                    100
                )
                .is_err());
            }
        }
        let oversized = directory.path().join("oversized");
        fs::write(&oversized, vec![b'a'; 65537]).unwrap();
        assert!(append_diagnostic(&oversized, "speak", "zh", &outcome, 100).is_err());
        assert_eq!(outcome.unwrap_err().code, "speech-output-unavailable");
    }
}
