use super::*;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
type Hkey = isize;
#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        key: Hkey,
        name: *const u16,
        options: u32,
        access: u32,
        result: *mut Hkey,
    ) -> i32;
    fn RegQueryValueExW(
        key: Hkey,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        length: *mut u32,
    ) -> i32;
    fn RegEnumKeyExW(
        key: Hkey,
        index: u32,
        name: *mut u16,
        length: *mut u32,
        reserved: *mut u32,
        class: *mut u16,
        class_length: *mut u32,
        modified: *mut core::ffi::c_void,
    ) -> i32;
    fn RegCloseKey(key: Hkey) -> i32;
}
struct Key(Hkey);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}
fn open(parent: Hkey, name: &str, view: u32) -> Option<Key> {
    let mut key = 0;
    if unsafe { RegOpenKeyExW(parent, wide(name).as_ptr(), 0, 0x20019 | view, &mut key) } == 0 {
        Some(Key(key))
    } else {
        None
    }
}
fn value(key: &Key, name: &str) -> Option<String> {
    let mut kind = 0;
    let mut data = [0u16; 4096];
    let mut length = (data.len() * 2) as u32;
    if unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            data.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0
        || !matches!(kind, 1 | 2)
        || length % 2 != 0
        || length as usize > data.len() * 2
    {
        return None;
    }
    let units = &data[..length as usize / 2];
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    let result = std::ffi::OsString::from_wide(&units[..end])
        .into_string()
        .ok()?;
    if result.contains('%') || result.contains('\0') {
        None
    } else {
        Some(result)
    }
}
trait RegistryReader {
    type Key;
    fn root(&self, hive: Hkey, name: &str, view: u32) -> Option<Self::Key>;
    fn child(&self, parent: &Self::Key, name: &str) -> Option<Self::Key>;
    fn string(&self, key: &Self::Key, name: &str) -> Option<String>;
    fn name(&self, key: &Self::Key, index: u32) -> Result<Option<String>, ()>;
}
struct NativeRegistry;
impl RegistryReader for NativeRegistry {
    type Key = Key;
    fn root(&self, hive: Hkey, name: &str, view: u32) -> Option<Key> {
        open(hive, name, view)
    }
    fn child(&self, parent: &Key, name: &str) -> Option<Key> {
        open(parent.0, name, 0)
    }
    fn string(&self, key: &Key, name: &str) -> Option<String> {
        value(key, name)
    }
    fn name(&self, parent: &Key, index: u32) -> Result<Option<String>, ()> {
        let mut name = [0u16; 512];
        let mut length = name.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(
                parent.0,
                index,
                name.as_mut_ptr(),
                &mut length,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status == 259 {
            return Ok(None);
        }
        if status != 0 || length as usize > name.len() {
            return Err(());
        }
        String::from_utf16(&name[..length as usize])
            .map(Some)
            .map_err(|_| ())
    }
}
fn candidates_with(reader: &impl RegistryReader) -> Vec<(String, PathBuf)> {
    let mut result = Vec::new();
    for hive in [0x80000001u32 as i32 as isize, 0x80000002u32 as i32 as isize] {
        for view in [0x100, 0x200] {
            // Shared JetBrains executable names do not identify the installed edition.
            for spec in EDITORS.iter().filter(|spec| {
                ![
                    "notepad",
                    "intellij",
                    "intellij-community",
                    "pycharm",
                    "pycharm-community",
                ]
                .contains(&spec.id)
            }) {
                for executable in spec.executables {
                    let path = format!(
                        "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{executable}"
                    );
                    if let Some(path) = reader
                        .root(hive, &path, view)
                        .and_then(|key| reader.string(&key, ""))
                    {
                        result.push((spec.id.into(), PathBuf::from(path.trim_matches('"'))));
                    }
                }
            }
            if let Some(parent) = reader.root(
                hive,
                "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                view,
            ) {
                for index in 0..512 {
                    let name = match reader.name(&parent, index) {
                        Ok(Some(name)) => name,
                        Ok(None) => break,
                        Err(()) => continue,
                    };
                    let Some(key) = reader.child(&parent, &name) else {
                        continue;
                    };
                    let (Some(display), Some(location)) = (
                        reader.string(&key, "DisplayName"),
                        reader.string(&key, "InstallLocation"),
                    ) else {
                        continue;
                    };
                    let Some(id) = jetbrains_id(&display) else {
                        continue;
                    };
                    add_install(&mut result, id, Path::new(&location));
                }
            }
        }
    }
    result
}
pub(super) fn candidates() -> Vec<(String, PathBuf)> {
    candidates_with(&NativeRegistry)
}
#[cfg(test)]
#[path = "../../../tests/native/rust/editor_registry.rs"]
mod tests;
