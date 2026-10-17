use std::{io::Write, process::{Child, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use base64::{Engine, engine::general_purpose::STANDARD};
use tauri::State;
#[cfg(windows)] use std::os::windows::process::CommandExt;

#[derive(Clone, Default)]
pub struct SpeechProcess(pub Arc<Mutex<Option<Child>>>,pub Arc<AtomicU64>);

#[tauri::command]
pub async fn speech_start(window: tauri::WebviewWindow, mode: String, language: String, text: Option<String>, process: State<'_, SpeechProcess>) -> Result<String, String> {
    if window.label() != "main" { return Err("Native speech requires the main window".into()); }
    if !cfg!(windows) { return Err("Native speech is available on Windows only".into()); }
    if !matches!(mode.as_str(), "recognize" | "speak" | "capabilities") || !matches!(language.as_str(), "zh" | "en") { return Err("Invalid speech request".into()); }
    if text.as_ref().is_some_and(|value| value.chars().count() > 10000) { return Err("Read-aloud text exceeds 10000 characters".into()); }
    let shared = process.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let input = serde_json::json!({"mode": mode, "language": language, "text": text}).to_string();
        let script = include_str!("../../native/speech.ps1");
        let encoded = STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
        let executable = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(executable);
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] command.creation_flags(0x08000000);
        let generation;
        {
            let mut slot = shared.0.lock().map_err(|_| "Speech process is unavailable")?;
            if slot.is_some() { return Err("Stop the current speech operation first".into()); }
            generation=shared.1.fetch_add(1,Ordering::SeqCst)+1;
            let mut child = command.spawn().map_err(|_| "Windows Speech is unavailable")?;
            if let Some(mut input_pipe) = child.stdin.take() { if input_pipe.write_all(input.as_bytes()).is_err() { let _ = child.kill(); let _ = child.wait(); return Err("Windows Speech could not receive the request".into()); } }
            *slot = Some(child);
        }
        let deadline = Instant::now() + Duration::from_secs(if mode == "speak" {120} else {25});
        loop {
            let mut slot = shared.0.lock().map_err(|_| "Speech process is unavailable")?;
            if shared.1.load(Ordering::SeqCst)!=generation { return Err("Speech cancelled".into()); }
            let Some(child) = slot.as_mut() else { return Err("Speech cancelled".into()); };
            if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); *slot = None; return Err("Speech operation timed out".into()); }
            if child.try_wait().map_err(|_| "Windows Speech stopped unexpectedly")?.is_some() {
                let completed = slot.take().unwrap().wait_with_output().map_err(|_| "Windows Speech response was interrupted")?;
                let value: serde_json::Value = serde_json::from_slice(&completed.stdout).map_err(|_| "Windows Speech returned an invalid response")?;
                if !completed.status.success() { return Err(value.get("error").and_then(|v| v.as_str()).unwrap_or("Windows Speech is unavailable").to_string()); }
                return Ok(value.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string());
            }
            drop(slot);std::thread::sleep(Duration::from_millis(100));
        }
    }).await.map_err(|_| "Windows Speech worker stopped".to_string())?
}

pub fn stop(process: &SpeechProcess) { if let Ok(mut slot) = process.0.lock() { process.1.fetch_add(1,Ordering::SeqCst);if let Some(mut child) = slot.take() { let _ = child.kill(); let _ = child.wait(); } } }
#[tauri::command]
pub fn speech_stop(window: tauri::WebviewWindow, process: State<'_, SpeechProcess>) -> Result<(), String> { if window.label() != "main" { return Err("Native speech requires the main window".into()); } stop(&process); Ok(()) }
