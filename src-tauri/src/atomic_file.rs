use std::{io::Write, path::Path};

pub(crate) trait StagedOutput: Write {
    fn sync_all(&self) -> std::io::Result<()>;
    fn commit(self, destination: &Path) -> std::io::Result<()>;
}
impl StagedOutput for tempfile::NamedTempFile {
    fn sync_all(&self) -> std::io::Result<()> {
        self.as_file().sync_all()
    }
    fn commit(self, destination: &Path) -> std::io::Result<()> {
        self.persist(destination)
            .map(|_| ())
            .map_err(|failure| failure.error)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CommitFailure<E = ()> {
    Flush,
    Sync,
    Validation(E),
    Publish,
}

#[derive(Clone, Copy)]
pub(crate) enum FlushPolicy {
    BeforeSync,
    SyncOnly,
}

pub(crate) fn finish<O: StagedOutput, E>(
    mut output: O,
    destination: &Path,
    flush: FlushPolicy,
    before_commit: impl FnOnce() -> Result<(), E>,
) -> Result<(), CommitFailure<E>> {
    if matches!(flush, FlushPolicy::BeforeSync) {
        output.flush().map_err(|_| CommitFailure::Flush)?;
    }
    output.sync_all().map_err(|_| CommitFailure::Sync)?;
    before_commit().map_err(CommitFailure::Validation)?;
    output
        .commit(destination)
        .map_err(|_| CommitFailure::Publish)
}

pub(crate) fn publish(
    output: impl StagedOutput,
    destination: &Path,
    flush: FlushPolicy,
) -> Result<(), CommitFailure> {
    finish(output, destination, flush, || Ok::<(), ()>(()))
}

#[cfg(test)]
#[path = "../../tests/native/rust/atomic_file.rs"]
mod tests;
