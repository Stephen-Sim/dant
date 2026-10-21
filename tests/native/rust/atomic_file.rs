use super::*;
use std::{cell::RefCell, fs, rc::Rc};

struct Output {
    temporary: tempfile::NamedTempFile,
    failure: &'static str,
    events: Rc<RefCell<Vec<&'static str>>>,
}
fn refused() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::PermissionDenied, "owned output failure")
}
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.temporary.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.events.borrow_mut().push("flush");
        if self.failure == "flush" {
            Err(refused())
        } else {
            self.temporary.flush()
        }
    }
}
impl StagedOutput for Output {
    fn sync_all(&self) -> std::io::Result<()> {
        self.events.borrow_mut().push("sync");
        if self.failure == "sync" {
            Err(refused())
        } else {
            self.temporary.as_file().sync_all()
        }
    }
    fn commit(self, destination: &Path) -> std::io::Result<()> {
        self.events.borrow_mut().push("publish");
        if self.failure == "publish" {
            Err(refused())
        } else {
            self.temporary
                .persist(destination)
                .map(|_| ())
                .map_err(|failure| failure.error)
        }
    }
}

#[test]
fn publication_orders_flush_sync_last_validation_and_commit_and_cleans_every_failed_stage() {
    for (failure, expected_error, expected_events) in [
        ("flush", Some(CommitFailure::Flush), vec!["flush"]),
        ("sync", Some(CommitFailure::Sync), vec!["flush", "sync"]),
        (
            "validation",
            Some(CommitFailure::Validation(())),
            vec!["flush", "sync", "validation"],
        ),
        (
            "publish",
            Some(CommitFailure::Publish),
            vec!["flush", "sync", "validation", "publish"],
        ),
        ("", None, vec!["flush", "sync", "validation", "publish"]),
    ] {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("owned.bin");
        fs::write(&destination, b"previous complete file").unwrap();
        let events = Rc::new(RefCell::new(Vec::new()));
        let mut output = Output {
            temporary: tempfile::NamedTempFile::new_in(root.path()).unwrap(),
            failure,
            events: Rc::clone(&events),
        };
        output.write_all(b"new complete file").unwrap();
        let result = finish(output, &destination, FlushPolicy::BeforeSync, || {
            events.borrow_mut().push("validation");
            if failure == "validation" {
                Err(())
            } else {
                Ok(())
            }
        });
        assert_eq!(result.err(), expected_error);
        assert_eq!(*events.borrow(), expected_events);
        assert_eq!(
            fs::read(&destination).unwrap(),
            if failure.is_empty() {
                b"new complete file".as_slice()
            } else {
                b"previous complete file".as_slice()
            }
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[test]
fn native_staging_publishes_exact_bytes_and_a_real_failed_rename_leaves_owned_directories_unchanged(
) {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("owned.bin");
    let mut output = tempfile::NamedTempFile::new_in(root.path()).unwrap();
    output.write_all(b"\0\xffexact bytes").unwrap();
    publish(output, &target, FlushPolicy::SyncOnly).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"\0\xffexact bytes");
    let directory = root.path().join("existing-directory");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("marker"), b"preserved").unwrap();
    let output = tempfile::NamedTempFile::new_in(root.path()).unwrap();
    let temporary_path = output.path().to_owned();
    assert_eq!(
        publish(output, &directory, FlushPolicy::BeforeSync),
        Err(CommitFailure::Publish)
    );
    assert_eq!(fs::read(directory.join("marker")).unwrap(), b"preserved");
    assert!(!temporary_path.exists());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn direct_write_consumers_do_not_add_flush_and_validation_errors_keep_the_original_value() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("owned.bin");
    let events = Rc::new(RefCell::new(Vec::new()));
    let output = Output {
        temporary: tempfile::NamedTempFile::new_in(root.path()).unwrap(),
        failure: "flush",
        events: Rc::clone(&events),
    };
    publish(output, &target, FlushPolicy::SyncOnly).unwrap();
    assert_eq!(*events.borrow(), ["sync", "publish"]);
    let output = tempfile::NamedTempFile::new_in(root.path()).unwrap();
    let validation = "fixed consumer validation code";
    assert_eq!(
        finish(output, &target, FlushPolicy::SyncOnly, || Err(validation)),
        Err(CommitFailure::Validation(validation))
    );
}
