package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	MaxOutputEntries   = 512
	MaxOutputScanBytes = 64 * 1024 * 1024
	MaxOutputDepth     = 8
)

var (
	deniedOutput   = regexp.MustCompile(`(?i)(?:^\.|(?:^|[-_.])(?:credentials?|secrets?|passwords?|tokens?|auth|cookies?)(?:[-_.]|$)|\.(?:log|pem|key|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa))`)
	outputScheme   = regexp.MustCompile(`(?i)^[a-z][a-z\d+.-]*:`)
	outputDrive    = regexp.MustCompile(`(?i)^[a-z]:[/\\]`)
	outputPrefix   = regexp.MustCompile(`^(?:\./)?output[/\\]`)
	outputMarkdown = regexp.MustCompile(`\]\(([^)]+)\)`)
	ErrOutputLimit = errors.New("output_scan_limit")
)

func outputControl(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}

// OutputReference resolves one local reference. URI decoding occurs exactly once;
// network URLs and paths outside this conversation's output root are rejected.
func OutputReference(root, value string, encoded bool) (string, bool) {
	if value == "" || !utf8.ValidString(value) || outputControl(value) {
		return "", false
	}
	candidate := value
	if encoded {
		candidate = strings.TrimPrefix(candidate, "<")
		candidate = strings.TrimSuffix(candidate, ">")
		if strings.HasPrefix(strings.ToLower(candidate), "file:") {
			parsed, err := url.Parse(candidate)
			if err != nil || parsed.Opaque != "" || parsed.User != nil ||
				(parsed.Host != "" && parsed.Host != "localhost") ||
				parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
				return "", false
			}
			candidate = parsed.EscapedPath()
			if filepath.Separator == '\\' && len(candidate) > 3 && candidate[0] == '/' && outputDrive.MatchString(candidate[1:]) {
				candidate = candidate[1:]
			}
		} else if strings.HasPrefix(strings.ToLower(candidate), "sandbox:") {
			candidate = candidate[len("sandbox:"):]
		}
		if outputScheme.MatchString(candidate) && !outputDrive.MatchString(candidate) {
			return "", false
		}
		var err error
		candidate, err = url.PathUnescape(candidate)
		if err != nil || !utf8.ValidString(candidate) || outputControl(candidate) || strings.ContainsAny(candidate, "?#") || strings.HasPrefix(candidate, "//") {
			return "", false
		}
	}
	if !filepath.IsAbs(root) {
		return "", false
	}
	target := candidate
	if !filepath.IsAbs(target) {
		target = filepath.Join(root, outputPrefix.ReplaceAllString(candidate, ""))
	}
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil || relative == "." || filepath.IsAbs(relative) {
		return "", false
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) > MaxOutputDepth+1 {
		return "", false
	}
	for _, part := range parts {
		if part == ".." || deniedOutput.MatchString(part) {
			return "", false
		}
	}
	return relative, true
}

type OutputBaseline struct {
	Valid  bool              `json:"valid"`
	Hashes map[string]string `json:"hashes"`
}

type outputDigest struct{ relative, hash string }

type DeliverableCollector struct {
	attachments *AttachmentStore
	notice      func(string)
}

func NewDeliverableCollector(attachments *AttachmentStore, notice func(string)) *DeliverableCollector {
	return &DeliverableCollector{attachments: attachments, notice: notice}
}

func (collector *DeliverableCollector) notify(code string) {
	if collector.notice != nil {
		collector.notice(code)
	}
}

func scanOutput(ctx context.Context, directory string) ([]outputDigest, error) {
	root, err := OpenManagedRoot(directory, true)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	count := 0
	var total int64
	result := []outputDigest{}
	var walk func(string, int) error
	walk = func(relative string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > MaxOutputDepth {
			return ErrOutputLimit
		}
		entries, err := root.ReadDirectory(relative)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			count++
			if count > MaxOutputEntries {
				return ErrOutputLimit
			}
			if deniedOutput.MatchString(entry.Name()) {
				continue
			}
			child := entry.Name()
			if relative != "." {
				child = filepath.Join(relative, child)
			}
			if entry.Type()&fs.ModeSymlink != 0 {
				continue
			}
			if entry.IsDir() {
				if err := walk(child, depth+1); err != nil {
					return err
				}
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() || info.Size() > MaxAttachmentBytes {
				continue
			}
			ordinary, err := root.OrdinaryFile(child)
			if err != nil {
				return err
			}
			if !ordinary {
				continue
			}
			digest, size, err := root.Digest(ctx, child, MaxAttachmentBytes)
			if err != nil {
				return err
			}
			total += size
			if total > MaxOutputScanBytes {
				return ErrOutputLimit
			}
			result = append(result, outputDigest{relative: child, hash: digest})
		}
		return nil
	}
	if err := walk(".", 0); err != nil {
		return nil, err
	}
	return result, nil
}

// CaptureBaseline records hashes through bounded streaming reads. A failed broad
// scan disables automatic delivery, while explicit delivery stays available.
func (collector *DeliverableCollector) CaptureBaseline(ctx context.Context, outputDir string) (json.RawMessage, error) {
	baseline := OutputBaseline{Hashes: map[string]string{}}
	scanned, err := scanOutput(ctx, outputDir)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		collector.notify("output_baseline_unavailable")
	} else {
		baseline.Valid = true
		for _, item := range scanned {
			baseline.Hashes[filepath.ToSlash(item.relative)] = item.hash
		}
	}
	return json.Marshal(baseline)
}

type ArchiveInput struct {
	OutputDirectory string
	Text            string
	Baseline        json.RawMessage
	ExplicitPaths   []string
	ExcludePaths    []string
	OnlyExplicit    bool
	IsCurrent       func() bool
}

func (collector *DeliverableCollector) Archive(ctx context.Context, directory, text string, baseline json.RawMessage) ([]contracts.Attachment, error) {
	return collector.ArchiveExplicit(ctx, ArchiveInput{OutputDirectory: directory, Text: text, Baseline: baseline})
}

func (collector *DeliverableCollector) ArchiveExplicit(ctx context.Context, input ArchiveInput) ([]contracts.Attachment, error) {
	result := []contracts.Attachment{}
	current := func() bool { return ctx.Err() == nil && (input.IsCurrent == nil || input.IsCurrent()) }
	if !current() {
		return result, context.Canceled
	}
	directory := filepath.Clean(input.OutputDirectory)
	excluded := map[string]bool{}
	for _, item := range input.ExcludePaths {
		if relative, ok := OutputReference(directory, item, false); ok {
			excluded[relative] = true
		}
	}
	explicit := map[string]bool{}
	names := []string{}
	add := func(value string, encoded bool) {
		if relative, ok := OutputReference(directory, value, encoded); ok && !excluded[relative] && !explicit[relative] {
			explicit[relative] = true
			names = append(names, relative)
		}
	}
	for _, item := range input.ExplicitPaths {
		add(item, false)
	}
	for _, match := range outputMarkdown.FindAllStringSubmatch(input.Text, -1) {
		add(match[1], true)
	}
	archive := func(relative, expectedHash string) error {
		if !current() {
			return context.Canceled
		}
		root, err := OpenManagedRoot(directory, true)
		if err != nil {
			return err
		}
		data, err := root.ReadFile(ctx, relative, MaxAttachmentBytes)
		closeErr := root.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		hash := sha256.Sum256(data)
		if expectedHash != "" && hex.EncodeToString(hash[:]) != expectedHash {
			return ErrFileChanged
		}
		if !current() {
			return context.Canceled
		}
		item, err := collector.attachments.Put(ctx, filepath.Base(relative), "", data)
		if err != nil {
			return err
		}
		item.SourcePath = filepath.Join(directory, relative)
		result = append(result, item)
		return nil
	}
	for _, relative := range names {
		if len(result) >= MaxMessageAttachments {
			break
		}
		if err := archive(relative, ""); err != nil && !current() {
			return result, context.Canceled
		}
	}
	var baseline OutputBaseline
	if !input.OnlyExplicit && len(result) < MaxMessageAttachments && json.Unmarshal(input.Baseline, &baseline) == nil && baseline.Valid {
		scanned, err := scanOutput(ctx, directory)
		if err != nil {
			collector.notify("output_delivery_unavailable")
			return result, nil
		}
		for _, item := range scanned {
			if len(result) >= MaxMessageAttachments {
				break
			}
			if explicit[item.relative] || excluded[item.relative] || baseline.Hashes[filepath.ToSlash(item.relative)] == item.hash {
				continue
			}
			if err := archive(item.relative, item.hash); err != nil {
				collector.notify("output_delivery_unavailable")
				if !current() {
					return result, context.Canceled
				}
			}
		}
	}
	return result, nil
}

func (collector *DeliverableCollector) ReadExplicit(ctx context.Context, outputDir, filePath string) ([]byte, string, error) {
	relative, valid := OutputReference(outputDir, filePath, false)
	if !valid {
		return nil, "", ErrManagedPath
	}
	root, err := OpenManagedRoot(outputDir, true)
	if err != nil {
		return nil, "", err
	}
	defer root.Close()
	data, err := root.ReadFile(ctx, relative, MaxAttachmentBytes)
	return data, filepath.Base(relative), err
}
