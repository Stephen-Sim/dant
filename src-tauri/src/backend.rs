use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_ATTEMPTS: usize = 30;
const MAX_OUTPUT_LINE_BYTES: usize = 64 * 1024;
const OUTPUT_BUFFER_BYTES: usize = 8192;
const OUTPUT_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub(crate) struct Backend(pub(crate) Mutex<Option<Child>>, Mutex<Option<OutputReader>>);

struct OutputReader {
    cancelled: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl OutputReader {
    fn start(mut output: ChildStdout, sender: mpsc::Sender<()>) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&cancelled);
        let thread = thread::spawn(move || {
            let mut sender = Some(sender);
            let mut line = Vec::new();
            let mut buffer = [0; OUTPUT_BUFFER_BYTES];
            while !stop.load(Ordering::Acquire) {
                let available = match available_bytes(&output) {
                    Ok(0) => {
                        thread::sleep(OUTPUT_POLL_INTERVAL);
                        continue;
                    }
                    Err(_) => break,
                    Ok(count) => count.min(buffer.len()),
                };
                let count = match output.read(&mut buffer[..available]) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                for &byte in &buffer[..count] {
                    line.push(byte);
                    if line.len() > MAX_OUTPUT_LINE_BYTES {
                        return;
                    }
                    if byte == b'\n' {
                        signal_ready(&mut line, &mut sender);
                    }
                }
            }
            // BufRead::lines also accepted a final line without a newline.
            signal_ready(&mut line, &mut sender);
        });
        Self { cancelled, thread }
    }

    fn stop(self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.thread.join();
    }
}

fn signal_ready(line: &mut Vec<u8>, sender: &mut Option<mpsc::Sender<()>>) {
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.as_slice() == crate::protocol::readiness_line().as_bytes() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(());
        }
    }
    line.clear();
}

#[cfg(windows)]
fn available_bytes(output: &ChildStdout) -> std::io::Result<usize> {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(
            handle: *mut std::ffi::c_void,
            buffer: *mut std::ffi::c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            left: *mut u32,
        ) -> i32;
    }
    let mut available = 0;
    // The reader exclusively owns this pipe handle. PeekNamedPipe consumes no
    // bytes; each following read is bounded to data already present in the pipe.
    let ok = unsafe {
        PeekNamedPipe(
            output.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(available as usize)
}

#[cfg(unix)]
fn available_bytes(output: &ChildStdout) -> std::io::Result<usize> {
    use std::os::fd::AsRawFd;
    #[repr(C)]
    struct PollFd {
        fd: i32,
        events: i16,
        revents: i16,
    }
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    type Count = u32;
    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    )))]
    type Count = usize;
    extern "C" {
        fn poll(fds: *mut PollFd, count: Count, timeout: i32) -> i32;
    }
    let mut descriptor = PollFd {
        fd: output.as_raw_fd(),
        events: 1,
        revents: 0,
    };
    // A zero-time poll never blocks shutdown. Only this thread reads the pipe.
    let result = unsafe { poll(&mut descriptor, 1, 0) };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(if result > 0 { OUTPUT_BUFFER_BYTES } else { 0 })
}

impl Backend {
    pub(crate) fn external() -> Self {
        Self(Mutex::new(None), Mutex::new(None))
    }

    pub(crate) fn start(
        root: &Path,
        data: &Path,
        config_root: Option<&Path>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(data)?;
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data.join("startup.log"))?;
        writeln!(log, "Starting dant backend in {}", root.display())?;

        let command = controller_command(root, data, config_root, log);
        start_owned(command, STARTUP_TIMEOUT).map_err(|_| {
            format!(
                "dant backend could not start. Close other dant instances and check {}",
                data.join("startup.log").display()
            )
            .into()
        })
    }

    pub(crate) fn stop(&self) {
        let child = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(child) = child {
            stop_child(child, SHUTDOWN_ATTEMPTS, SHUTDOWN_INTERVAL);
        }
        if let Some(reader) = self
            .1
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            reader.stop();
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}

fn controller_command(
    root: &Path,
    data: &Path,
    config_root: Option<&Path>,
    log: fs::File,
) -> Command {
    let mut command = Command::new(root.join("dant-core.exe"));
    command
        .arg("--role=controller")
        .arg("--root")
        .arg(root)
        .current_dir(root)
        .env("DANT_DATA", data)
        .env("DANT_MANAGED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log));
    if let Some(config_root) = config_root {
        command.arg("--config-root").arg(config_root);
    }
    #[cfg(windows)]
    command.creation_flags(crate::runtime::CREATE_NO_WINDOW);
    command
}

fn start_owned(mut command: Command, timeout: Duration) -> Result<Backend, &'static str> {
    let mut child = command
        .spawn()
        .map_err(|_| "Backend process could not start")?;
    let Some(output) = child.stdout.take() else {
        stop_child(child, 0, Duration::ZERO);
        return Err("Missing backend output");
    };
    let (sender, receiver) = mpsc::channel();
    let reader = OutputReader::start(output, sender);

    if receiver.recv_timeout(timeout).is_err() {
        stop_child(child, 0, Duration::ZERO);
        reader.stop();
        return Err("Backend readiness was not confirmed");
    }
    Ok(Backend(Mutex::new(Some(child)), Mutex::new(Some(reader))))
}

fn stop_child(mut child: Child, attempts: usize, interval: Duration) {
    drop(child.stdin.take());
    for _ in 0..attempts {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(interval);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
#[path = "../../tests/native/rust/backend.rs"]
mod tests;
