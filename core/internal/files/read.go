package files

import (
	"context"
	"io"
	"io/fs"
	"math"
	"os"
)

type guardedRead struct {
	context context.Context
	reader  io.Reader
}

func (reader guardedRead) Read(buffer []byte) (int, error) {
	if err := reader.context.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}

// fileRead shares bounded consumption and opened-file identity checks. Its
// caller still owns the platform-specific open flags and directory capabilities.
type fileRead struct {
	file      *os.File
	before    fs.FileInfo
	maximum   int64
	current   func() (fs.FileInfo, error)
	unchanged func() bool
}

func (read fileRead) consume(ctx context.Context, consume func(io.Reader) error) (fs.FileInfo, error) {
	opened, err := read.file.Stat()
	if err != nil || !sameFile(read.before, opened) || !openedSingleLink(read.file, opened) {
		return nil, ErrFileChanged
	}

	limit := read.maximum
	if limit < math.MaxInt64 {
		limit++
	}
	limited := &io.LimitedReader{R: guardedRead{context: ctx, reader: read.file}, N: limit}
	if err := consume(limited); err != nil {
		return nil, err
	}
	if limit-limited.N > read.maximum {
		return nil, ErrFileLimit
	}

	after, afterErr := read.file.Stat()
	current, pathErr := read.current()
	if afterErr != nil || pathErr != nil || !sameFile(opened, after) ||
		!sameFile(opened, current) || !openedSingleLink(read.file, after) ||
		read.unchanged != nil && !read.unchanged() {
		return nil, ErrFileChanged
	}
	if limit-limited.N != opened.Size() {
		return nil, ErrFileChanged
	}
	return opened, nil
}
