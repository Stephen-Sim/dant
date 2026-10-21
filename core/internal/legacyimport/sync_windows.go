package legacyimport

import "os"

// Windows does not offer directory fsync through os.File. Every newly created
// data, metadata, journal and receipt file is flushed before publication.
func syncDirectory(_ *os.Root) error { return nil }
