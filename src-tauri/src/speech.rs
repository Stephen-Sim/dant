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
use tauri::State;

trait SpeechCommands: Send + Sync {
    fn command(
        &self,
        mode: &str,
        language: &str,
        text: Option<&str>,
    ) -> Result<(Command, String), SpeechFailure>;
}
struct NativeSpeechCommands;
impl SpeechCommands for NativeSpeechCommands {
    fn command(
        &self,
        mode: &str,
        language: &str,
        text: Option<&str>,
    ) -> Result<(Command, String), SpeechFailure> {
        let root = speech_system_root(
            std::env::var_os("SystemRoot").map(PathBuf::from),
            windows_directory,
        )?;
        Ok(speech_command(&root, mode, language, text))
    }
}
fn speech_system_root(
    configured: Option<PathBuf>,
    fallback: impl FnOnce() -> Option<PathBuf>,
) -> Result<PathBuf, SpeechFailure> {
    configured
        .or_else(fallback)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| failed("speech-unavailable", "process-start"))
}
fn windows_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        const WINDOWS_DIRECTORY_MAX_UNITS: usize = 32768;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
        }
        let mut buffer = vec![0u16; WINDOWS_DIRECTORY_MAX_UNITS];
        let length =
            unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 || length >= buffer.len() {
            return None;
        }
        String::from_utf16(&buffer[..length])
            .ok()
            .map(PathBuf::from)
    }
    #[cfg(not(windows))]
    None
}
#[derive(Clone)]
pub struct SpeechProcess(
    pub Arc<Mutex<Option<Child>>>,
    pub Arc<AtomicU64>,
    Arc<dyn SpeechCommands>,
);
impl SpeechProcess {
    fn with_commands(commands: Arc<dyn SpeechCommands>) -> Self {
        Self(Arc::default(), Arc::default(), commands)
    }
}
impl Default for SpeechProcess {
    fn default() -> Self {
        Self::with_commands(Arc::new(NativeSpeechCommands))
    }
}

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
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_SPEECH_CHARACTERS: usize = 10_000;
const DIAGNOSTIC_RETENTION_MS: u64 = 3 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_RECORD_LIMIT: usize = 128;
const SPEAK_TIMEOUT: Duration = Duration::from_secs(120);
const RECOGNITION_TIMEOUT: Duration = Duration::from_secs(25);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
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
    if bytes.len() > MAX_RESPONSE_BYTES {
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
    if text.chars().count() > MAX_SPEECH_CHARACTERS {
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
    persist: &mut dyn FnMut(
        tempfile::NamedTempFile,
        &Path,
    ) -> Result<fs::File, tempfile::PersistError>,
    wait: &mut dyn FnMut(Duration),
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
fn diagnostic_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let data = crate::runtime::data_directory(app)?;
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
    append_diagnostic_using(path, mode, language, outcome, now, |selected| {
        fs::File::open(selected)
    })
}
fn append_diagnostic_using(
    path: &Path,
    mode: &str,
    language: &str,
    outcome: &Result<String, SpeechFailure>,
    now: u64,
    open: impl FnOnce(&Path) -> std::io::Result<fs::File>,
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
        let file = open(path)?;
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
                        && now - at < DIAGNOSTIC_RETENTION_MS
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
                            records.push(serde_json::json!({
                                "schema": "dant.native-speech.v1",
                                "event": "speech.operation",
                                "at": at,
                                "mode": string("mode"),
                                "language": string("language"),
                                "phase": string("phase"),
                                "status": string("status"),
                                "reason": string("reason"),
                                "numericCode": value
                                    .get("numericCode")
                                    .and_then(|v| v.as_i64())
                                    .filter(|v| *v >= i32::MIN as i64 && *v <= u32::MAX as i64),
                            }));
                        }
                    }
                }
            }
        }
    }
    let error = outcome.as_ref().err();
    let row = serde_json::json!({
        "schema": "dant.native-speech.v1",
        "event": "speech.operation",
        "at": now,
        "mode": mode,
        "language": language,
        "phase": error.map(|e| e.phase).unwrap_or("finished"),
        "status": if outcome.is_ok() { "completed" } else { "failed" },
        "reason": error.map(|e| e.code).unwrap_or("ok"),
        "numericCode": error.and_then(|e| e.numeric_code),
    });
    records.push(row);
    if records.len() > DIAGNOSTIC_RECORD_LIMIT {
        records.drain(..records.len() - DIAGNOSTIC_RECORD_LIMIT);
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
        &mut |file, target| file.persist(target),
        &mut std::thread::sleep,
    )
}

fn speech_command(
    system_root: &Path,
    mode: &str,
    language: &str,
    text: Option<&str>,
) -> (Command, String) {
    let input = serde_json::json!({
        "mode": mode,
        "language": language,
        "locale": crate::l10n::speech_locale(&language),
        "text": text,
    })
    .to_string();
    let script = include_str!("../../native/speech.ps1");
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let executable = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(executable);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(crate::runtime::CREATE_NO_WINDOW);
    (command, input)
}

fn execute_speech(
    shared: &SpeechProcess,
    mut command: Command,
    input: &str,
    timeout: Duration,
    mut now: impl FnMut() -> Instant,
    mut wait: impl FnMut(Duration),
) -> Result<String, SpeechFailure> {
    let generation;
    {
        let mut slot = shared
            .0
            .lock()
            .map_err(|_| failed("speech-unavailable", "process-start"))?;
        if slot.is_some() {
            return Err(failed("speech-busy", "process-start"));
        }
        generation = shared.1.fetch_add(1, Ordering::SeqCst) + 1;
        let mut child = command
            .spawn()
            .map_err(|_| failed("speech-unavailable", "process-start"))?;
        if let Some(mut input_pipe) = child.stdin.take() {
            if input_pipe.write_all(input.as_bytes()).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed("speech-unavailable", "request-write"));
            }
        }
        *slot = Some(child);
    }

    let deadline = now() + timeout;
    loop {
        let mut slot = shared
            .0
            .lock()
            .map_err(|_| failed("speech-unavailable", "process-wait"))?;
        if shared.1.load(Ordering::SeqCst) != generation {
            return Err(failed("speech-cancelled", "process-wait"));
        }
        let Some(child) = slot.as_mut() else {
            return Err(failed("speech-cancelled", "process-wait"));
        };
        if now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            *slot = None;
            return Err(failed("speech-timeout", "process-wait"));
        }
        if child
            .try_wait()
            .map_err(|_| failed("speech-unavailable", "process-wait"))?
            .is_some()
        {
            let completed = slot
                .take()
                .unwrap()
                .wait_with_output()
                .map_err(|_| failed("speech-response-invalid", "process-response"))?;
            return response_result(completed.status.success(), &completed.stdout);
        }
        drop(slot);
        wait(PROCESS_POLL_INTERVAL);
    }
}

#[tauri::command]
pub async fn speech_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
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
        .is_some_and(|value| value.chars().count() > MAX_SPEECH_CHARACTERS)
    {
        return Err("speech-too-long".into());
    }
    let shared = process.inner().clone();
    let diagnostic_path = diagnostic_file(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let request = shared.2.command(&mode, &language, text.as_deref());
        let timeout = if mode == "speak" {
            SPEAK_TIMEOUT
        } else {
            RECOGNITION_TIMEOUT
        };
        let outcome = request.and_then(|(command, input)| {
            execute_speech(
                &shared,
                command,
                &input,
                timeout,
                Instant::now,
                std::thread::sleep,
            )
        });
        if let Some(path) = diagnostic_path {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let _ = append_diagnostic(&path, &mode, &language, &outcome, now);
        }
        outcome.map_err(|error| error.code.to_string())
    })
    .await
    .map_err(|_| "speech-unavailable".to_string())?
}

pub fn stop(process: &SpeechProcess) {
    let mut slot = process
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    process.1.fetch_add(1, Ordering::SeqCst);
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
#[tauri::command]
pub fn speech_stop<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    process: State<'_, SpeechProcess>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Native speech requires the main window".into());
    }
    stop(&process);
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/native/rust/speech.rs"]
mod tests;
