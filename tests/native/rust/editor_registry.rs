use super::*;
use std::cell::RefCell;
use std::fs;

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        parent: Hkey,
        name: *const u16,
        reserved: u32,
        class: *mut u16,
        options: u32,
        access: u32,
        attributes: *const core::ffi::c_void,
        result: *mut Hkey,
        disposition: *mut u32,
    ) -> i32;
    fn RegSetValueExW(
        key: Hkey,
        name: *const u16,
        reserved: u32,
        kind: u32,
        data: *const u8,
        bytes: u32,
    ) -> i32;
    fn RegDeleteTreeW(parent: Hkey, name: *const u16) -> i32;
}
const CURRENT_USER: Hkey = 0x80000001u32 as i32 as isize;

struct OwnedRegistryFixture {
    path: String,
    key: Key,
}
impl OwnedRegistryFixture {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = format!(
            "Software\\dant-native-test-{}-{nonce}-{sequence}",
            std::process::id()
        );
        let key = Self::create(CURRENT_USER, &path);
        Self { path, key }
    }
    fn create(parent: Hkey, path: &str) -> Key {
        let mut handle = 0;
        let mut disposition = 0;
        let status = unsafe {
            RegCreateKeyExW(
                parent,
                wide(path).as_ptr(),
                0,
                std::ptr::null_mut(),
                1,
                0xf003f,
                std::ptr::null(),
                &mut handle,
                &mut disposition,
            )
        };
        assert_eq!(status, 0, "Isolated volatile registry key creation failed");
        let key = Key(handle);
        assert_eq!(
            disposition, 1,
            "The fixture must own a newly created key; an existing key must never be deleted"
        );
        key
    }
    fn set(&self, name: &str, kind: u32, bytes: &[u8]) {
        assert_eq!(
            unsafe {
                RegSetValueExW(
                    self.key.0,
                    wide(name).as_ptr(),
                    0,
                    kind,
                    bytes.as_ptr(),
                    bytes.len() as u32,
                )
            },
            0
        );
    }
    fn string(&self, name: &str, kind: u32, units: &[u16]) {
        self.set(
            name,
            kind,
            &units
                .iter()
                .flat_map(|unit| unit.to_le_bytes())
                .collect::<Vec<_>>(),
        );
    }
}
impl Drop for OwnedRegistryFixture {
    fn drop(&mut self) {
        assert!(
            self.path.starts_with("Software\\dant-native-test-") && !self.path[9..].contains('\\')
        );
        let status = unsafe { RegDeleteTreeW(CURRENT_USER, wide(&self.path).as_ptr()) };
        if status != 0 && !std::thread::panicking() {
            panic!("Isolated volatile registry key cleanup failed");
        }
    }
}

#[test]
fn native_registry_reads_only_its_owned_volatile_fixture_and_rejects_non_string_and_unbounded_data()
{
    let fixture = OwnedRegistryFixture::new();
    let path = fixture.path.clone();
    fixture.string("unicode", 1, &wide("C:\\synthetic\\中文\\Code.exe"));
    fixture.string("expand", 2, &wide("%LOCALAPPDATA%\\Code.exe"));
    fixture.string("surrogate", 1, &[0xd800, 0]);
    fixture.string("unterminated", 1, &[b'O' as u16, b'K' as u16]);
    fixture.string("oversize", 1, &vec![b'x' as u16; 4097]);
    fixture.set("odd", 1, &[b'x', 0, b'y']);
    fixture.set("integer", 4, &[1, 0, 0, 0]);
    let native = NativeRegistry;
    let key = native.root(CURRENT_USER, &path, 0).unwrap();
    assert_eq!(
        native.string(&key, "unicode"),
        Some("C:\\synthetic\\中文\\Code.exe".into())
    );
    assert_eq!(native.string(&key, "unterminated"), Some("OK".into()));
    for name in [
        "missing",
        "expand",
        "surrogate",
        "oversize",
        "odd",
        "integer",
    ] {
        assert!(native.string(&key, name).is_none(), "{name}");
    }
    assert!(native.child(&key, "missing").is_none());
    let child = OwnedRegistryFixture::create(fixture.key.0, "synthetic-product");
    drop(child);
    let child = native.child(&key, "synthetic-product").unwrap();
    assert_eq!(native.name(&key, 0), Ok(Some("synthetic-product".into())));
    assert_eq!(native.name(&key, 1), Ok(None));
    assert_eq!(native.name(&child, 0), Ok(None));
    assert!(native.name(&Key(0), 0).is_err());
    drop(child);
    drop(key);
    drop(fixture);
    assert!(
        native.root(CURRENT_USER, &path, 0).is_none(),
        "The exact owned key must have been removed"
    );
}

struct RegistryFixture {
    requested: RefCell<Vec<String>>,
    names: RefCell<Vec<u32>>,
    exhausted: bool,
}
impl RegistryReader for RegistryFixture {
    type Key = String;
    fn root(&self, hive: Hkey, name: &str, view: u32) -> Option<String> {
        self.requested.borrow_mut().push(name.into());
        if hive != 0x80000001u32 as i32 as isize || view != 0x100 {
            return None;
        }
        if name.ends_with("\\code.exe") {
            Some("code".into())
        } else if name.ends_with("\\Uninstall") {
            Some("uninstall".into())
        } else {
            None
        }
    }
    fn child(&self, _: &String, name: &str) -> Option<String> {
        (name != "removed").then(|| name.to_owned())
    }
    fn string(&self, key: &String, name: &str) -> Option<String> {
        match (key.as_str(), name) {
            ("code", "") => Some("\"C:\\synthetic\\Code.exe\"".into()),
            ("incomplete", "DisplayName") => Some("IntelliJ IDEA".into()),
            ("unrelated", "DisplayName") => Some("Unrelated software".into()),
            ("community", "DisplayName") => Some("IntelliJ IDEA Community".into()),
            ("pycharm", "DisplayName") => Some("PyCharm Professional".into()),
            ("community" | "pycharm" | "unrelated", "InstallLocation") => {
                Some("C:\\synthetic\\JetBrains".into())
            }
            _ => None,
        }
    }
    fn name(&self, _: &String, index: u32) -> Result<Option<String>, ()> {
        self.names.borrow_mut().push(index);
        if self.exhausted {
            return Ok(Some("removed".into()));
        }
        match index {
            0 => Err(()),
            1 => Ok(Some("removed".into())),
            2 => Ok(Some("incomplete".into())),
            3 => Ok(Some("unrelated".into())),
            4 => Ok(Some("community".into())),
            5 => Ok(Some("pycharm".into())),
            _ => Ok(None),
        }
    }
}

#[test]
fn registry_discovery_respects_views_skips_bad_entries_and_never_infers_an_edition_from_an_executable(
) {
    let fixture = RegistryFixture {
        requested: RefCell::new(Vec::new()),
        names: RefCell::new(Vec::new()),
        exhausted: false,
    };
    let result = candidates_with(&fixture);
    assert!(result.contains(&("vscode".into(), PathBuf::from(r"C:\synthetic\Code.exe"))));
    assert!(result
        .iter()
        .any(|(id, path)| id == "intellij-community" && path.ends_with("idea64.exe")));
    assert!(result
        .iter()
        .any(|(id, path)| id == "pycharm" && path.ends_with("pycharm64.exe")));
    assert!(!result.iter().any(|(id, _)| id == "intellij"));
    let requested = fixture.requested.borrow();
    assert!(!requested.iter().any(|name| name.ends_with("\\notepad.exe")
        || name.ends_with("\\idea64.exe")
        || name.ends_with("\\pycharm64.exe")));
    assert_eq!(*fixture.names.borrow(), [0, 1, 2, 3, 4, 5, 6]);
}

#[test]
fn registry_enumeration_has_a_fixed_budget_even_when_the_provider_never_signals_an_end() {
    let fixture = RegistryFixture {
        requested: RefCell::new(Vec::new()),
        names: RefCell::new(Vec::new()),
        exhausted: true,
    };
    candidates_with(&fixture);
    let names = fixture.names.borrow();
    assert_eq!(names.len(), 512);
    assert_eq!(names[0], 0);
    assert_eq!(names[511], 511);
}

#[test]
fn native_registry_boundary_rejects_an_invalid_root_without_creating_or_running_anything() {
    assert!(NativeRegistry.root(0, "synthetic", 0).is_none());
    assert_eq!(wide("中文"), vec![0x4e2d, 0x6587, 0]);
}

#[link(name = "advapi32")]
extern "system" {
    fn RegOverridePredefKey(predefined: Hkey, replacement: Hkey) -> i32;
}
const LOCAL_MACHINE: Hkey = 0x80000002u32 as i32 as isize;
struct IsolatedRegistry {
    fixture: Option<OwnedRegistryFixture>,
    user_redirected: bool,
    machine_redirected: bool,
}
impl IsolatedRegistry {
    fn redirect(fixture: OwnedRegistryFixture) -> Result<Self, i32> {
        let mut scope = Self {
            fixture: Some(fixture),
            user_redirected: false,
            machine_redirected: false,
        };
        let handle = scope.fixture.as_ref().unwrap().key.0;
        let user = unsafe { RegOverridePredefKey(CURRENT_USER, handle) };
        if user != 0 {
            return Err(user);
        }
        scope.user_redirected = true;
        let machine = unsafe { RegOverridePredefKey(LOCAL_MACHINE, handle) };
        if machine != 0 {
            return Err(machine);
        }
        scope.machine_redirected = true;
        Ok(scope)
    }
}
impl Drop for IsolatedRegistry {
    fn drop(&mut self) {
        let machine = if self.machine_redirected {
            unsafe { RegOverridePredefKey(LOCAL_MACHINE, 0) }
        } else {
            0
        };
        let user = if self.user_redirected {
            unsafe { RegOverridePredefKey(CURRENT_USER, 0) }
        } else {
            0
        };
        if machine == 0 && user == 0 {
            drop(self.fixture.take());
        } else {
            // An unconfirmed restore must never guess which hive deletion targets.
            if let Some(fixture) = self.fixture.take() {
                std::mem::forget(fixture);
            }
            if !std::thread::panicking() {
                panic!("The synthetic registry view could not be restored");
            }
        }
    }
}
fn fixture_string(key: &Key, name: &str, value: &str) {
    let bytes: Vec<u8> = value
        .encode_utf16()
        .chain(Some(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(
        unsafe {
            RegSetValueExW(
                key.0,
                wide(name).as_ptr(),
                0,
                1,
                bytes.as_ptr(),
                bytes.len() as u32,
            )
        },
        0
    );
}
#[test]
fn native_editor_discovery_reads_only_both_redirected_fixture_hives_in_an_isolated_process() {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let root = tempfile::Builder::new()
        .prefix("dant-native-registry-")
        .tempdir()
        .unwrap();
    fs::write(
        root.path().join("fixture-owner"),
        b"only isolated native registry discovery",
    )
    .unwrap();
    let output = tempfile::tempfile().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "text_editor::registry::tests::synthetic_registry_discovery_child",
            "--nocapture",
        ])
        .env("DANT_NATIVE_REGISTRY_FIXTURE_ROOT", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(output.try_clone().unwrap()))
        .creation_flags(crate::runtime::CREATE_NO_WINDOW);
    for (name, directory) in [
        ("SystemRoot", "system"),
        ("LOCALAPPDATA", "local"),
        ("APPDATA", "roaming"),
        ("ProgramFiles", "programs"),
        ("ProgramFiles(x86)", "programs-x86"),
        ("USERPROFILE", "profile"),
        ("TEMP", "temporary"),
        ("TMP", "temporary"),
    ] {
        let path = root.path().join(directory);
        fs::create_dir_all(&path).unwrap();
        command.env(name, path);
    }
    let mut child = OwnedChild(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            if !status.success() {
                use std::io::{Read, Seek};
                let mut output = output;
                output.rewind().unwrap();
                let mut bytes = Vec::new();
                output.take(65536).read_to_end(&mut bytes).unwrap();
                panic!(
                    "Synthetic registry discovery failed: {}",
                    String::from_utf8_lossy(&bytes)
                );
            }
            break;
        }
        assert!(
            Instant::now() < deadline,
            "The isolated registry discovery must terminate"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let result = fs::read(root.path().join("discovery-result")).unwrap();
    if result == b"unavailable" {
        eprintln!("Registry redirection was unavailable: no editor discovery ran and no real hive fallback was used.");
    } else {
        assert_eq!(result, b"verified");
    }
}
#[test]
fn synthetic_registry_discovery_child() {
    let Some(root) = std::env::var_os("DANT_NATIVE_REGISTRY_FIXTURE_ROOT").map(PathBuf::from)
    else {
        return;
    };
    assert!(root.is_absolute());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("dant-native-registry-"));
    assert_eq!(
        fs::read(root.join("fixture-owner")).unwrap(),
        b"only isolated native registry discovery"
    );
    // Windows may reconstruct ProgramFiles while loading a child executable.
    // Set the private environment again before the first native discovery call.
    for (name, directory) in [
        ("SystemRoot", "system"),
        ("LOCALAPPDATA", "local"),
        ("APPDATA", "roaming"),
        ("ProgramFiles", "programs"),
        ("ProgramFiles(x86)", "programs-x86"),
        ("USERPROFILE", "profile"),
        ("TEMP", "temporary"),
        ("TMP", "temporary"),
    ] {
        std::env::set_var(name, root.join(directory));
        let path = PathBuf::from(std::env::var_os(name).unwrap());
        assert!(
            path.starts_with(&root),
            "{name} must remain in the owned fixture: {path:?}, root {root:?}"
        );
        assert!(path.is_dir());
    }
    let code = root.join("registered/Code.exe");
    fs::create_dir_all(code.parent().unwrap()).unwrap();
    fs::write(&code, b"MZ owned registry fixture, never launched").unwrap();
    let fixture = OwnedRegistryFixture::new();
    let key = OwnedRegistryFixture::create(
        fixture.key.0,
        r"Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe",
    );
    fixture_string(&key, "", &format!("\"{}\"", code.display()));
    drop(key);
    let scope = match IsolatedRegistry::redirect(fixture) {
        Ok(scope) => scope,
        Err(_) => {
            fs::write(root.join("discovery-result"), b"unavailable").unwrap();
            return;
        }
    };
    assert!(
        scope.user_redirected && scope.machine_redirected,
        "Both roots must be private before any discovery"
    );
    let native = super::super::NativeEditors;
    let installed = <super::super::NativeEditors as super::super::EditorPlatform<
        tauri::test::MockRuntime,
    >>::installed(&native);
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].spec.id, "vscode");
    assert_eq!(
        installed[0].executable.canonicalize().unwrap(),
        code.canonicalize().unwrap()
    );
    drop(scope);
    fs::write(root.join("discovery-result"), b"verified").unwrap();
}
