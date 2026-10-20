use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) struct RuntimeConfig {
    pub(crate) data_directory: PathBuf,
}

impl RuntimeConfig {
    pub(crate) fn capture(app: &tauri::AppHandle) -> tauri::Result<Self> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let development_root = cfg!(debug_assertions).then(|| manifest.parent().unwrap());
        let data_directory = select_data_directory(
            std::env::var_os("DANT_DATA").map(PathBuf::from),
            development_root,
            || app.path().app_data_dir(),
        )?;
        Ok(Self { data_directory })
    }
}

pub(crate) fn data_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.try_state::<RuntimeConfig>()
        .map(|config| config.data_directory.clone())
}

fn select_data_directory<E>(
    configured: Option<PathBuf>,
    development_root: Option<&Path>,
    application_directory: impl FnOnce() -> Result<PathBuf, E>,
) -> Result<PathBuf, E> {
    let path = if let Some(path) = configured {
        path
    } else if let Some(project) = development_root {
        project.join("data")
    } else {
        application_directory()?.join("data")
    };
    Ok(runtime_path(path))
}

pub(crate) fn runtime_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

#[cfg(test)]
#[path = "../../tests/native/rust/runtime.rs"]
mod tests;
