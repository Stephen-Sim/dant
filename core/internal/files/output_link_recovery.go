package files

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

const (
	MaxRecoveryMessageUnits = 120000
	MaxRecoveryHrefUnits    = 8192
)

// RecoveryPersistence publishes a detached snapshot and commits a private state
// copy only after its durable write succeeds. It must never expose live pointers.
type RecoveryPersistence interface {
	Snapshot() contracts.State
	Mutate(context.Context, func(*contracts.State) error) error
}

type RecoveryOptions struct {
	Store                   RecoveryPersistence
	Collector               *DeliverableCollector
	OutputDirectory         func() string
	ConversationTransaction func(context.Context, string, func(context.Context) error) error
	OnChange                func()
}

type RecoveryReceipt struct {
	ConversationID   string     `json:"conversationId"`
	MessageID        string     `json:"messageId"`
	Attachment       Attachment `json:"attachment"`
	RestoredSnapshot bool       `json:"restoredSnapshot"`
	Reused           bool       `json:"reused"`
}

type Recovery struct {
	options RecoveryOptions
	gate    chan struct{}
}

func NewRecovery(options RecoveryOptions) (*Recovery, error) {
	if options.Store == nil || options.Collector == nil || options.Collector.attachments == nil || options.OutputDirectory == nil {
		return nil, recoveryInvalid()
	}

	return &Recovery{options: options, gate: make(chan struct{}, 1)}, nil
}

func recoveryInvalid() error {
	return &contracts.APIError{
		Status: 400, Code: "output_link_invalid",
		Message: "Choose a local output link from this assistant message.",
	}
}

func recoveryUnavailable() error {
	return &contracts.APIError{
		Status: 404, Code: "output_link_unavailable",
		Message: "The referenced output file is missing, restricted or unavailable.",
	}
}

func recoveryChanged() error {
	return &contracts.APIError{
		Status: 409, Code: "output_link_conversation_changed",
		Message: "The conversation changed before its output link could be restored.",
	}
}

func recoveryLimit() error {
	return &contracts.APIError{
		Status: 409, Code: "output_link_attachment_limit",
		Message: "This message already has five attachments.",
	}
}

func recoverySaveFailed() error {
	return &contracts.APIError{
		Status: 500, Code: "output_link_save_failed",
		Message: "The output snapshot could not be saved. Try again after checking storage.",
	}
}

// recoveryRenderedURI matches encodeURI(href).replace(/%25/g, '%'). Unlike a URL
// parser it does not normalize an existing percent escape or HTML entity.
func recoveryRenderedURI(value string) string {
	const hexadecimal = "0123456789ABCDEF"
	var result strings.Builder
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune(";/?:@&=+$#-_.!~*'()%", rune(character)) {
			result.WriteByte(character)
			continue
		}
		result.WriteByte('%')
		result.WriteByte(hexadecimal[character>>4])
		result.WriteByte(hexadecimal[character&15])
	}
	return result.String()
}

func recoveryStoredLink(source, href string) bool {
	if !utf8.ValidString(source) || contracts.UTF16Length(source) > MaxRecoveryMessageUnits {
		return false
	}

	input := []byte(source)
	document := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(input))
	found := false
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var destination []byte
		switch link := node.(type) {
		case *ast.Link:
			destination = link.Destination
		case *ast.Image:
			destination = link.Destination
		case *ast.AutoLink:
			destination = link.URL(input)
		default:
			return ast.WalkContinue, nil
		}
		value := string(util.UnescapePunctuations(destination))
		if value == href || recoveryRenderedURI(value) == href {
			found = true
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	return found
}

func recoveryMessage(state contracts.State, conversationID, messageID string) (*contracts.ChatMessage, error) {
	if conversationID == "" || state.ConversationID != conversationID {
		return nil, recoveryChanged()
	}
	var found *contracts.ChatMessage
	for _, message := range state.Messages {
		if message != nil && message.ID == messageID {
			if found != nil || message.Role != contracts.RoleAssistant {
				return nil, recoveryUnavailable()
			}
			found = message
		}
	}
	if found == nil {
		return nil, recoveryUnavailable()
	}
	return found, nil
}

func recoveryExisting(message *contracts.ChatMessage, target string) (*Attachment, error) {
	var found *Attachment
	for index := range message.Attachments {
		attachment := &message.Attachments[index]
		if attachment.SourcePath == "" {
			continue
		}
		absolute, err := filepath.Abs(attachment.SourcePath)
		if err == nil && absolute == target {
			if found != nil {
				return nil, recoveryUnavailable()
			}
			found = attachment
		}
	}
	return found, nil
}

// Resolve only snapshots a named Markdown reference in this exact assistant
// message. It neither enumerates output directories nor starts model work.
func (value *Recovery) Resolve(ctx context.Context, messageID string, body contracts.RawObject) (RecoveryReceipt, error) {
	var conversationID, href string
	for key := range body {
		if key != "conversationId" && key != "href" {
			return RecoveryReceipt{}, recoveryInvalid()
		}
	}
	if !contracts.ValidUnicodeJSON(body["href"]) ||
		json.Unmarshal(body["href"], &href) != nil || href == "" ||
		contracts.UTF16Length(href) > MaxRecoveryHrefUnits || outputControl(href) {
		return RecoveryReceipt{}, recoveryInvalid()
	}
	if !contracts.ValidUnicodeJSON(body["conversationId"]) ||
		json.Unmarshal(body["conversationId"], &conversationID) != nil || conversationID == "" {
		return RecoveryReceipt{}, recoveryChanged()
	}

	select {
	case value.gate <- struct{}{}:
	case <-ctx.Done():
		return RecoveryReceipt{}, ctx.Err()
	}
	defer func() { <-value.gate }()

	directory := value.options.OutputDirectory()
	root, err := filepath.Abs(directory)
	if err != nil || directory == "" {
		return RecoveryReceipt{}, recoveryUnavailable()
	}
	var receipt RecoveryReceipt
	changed := false
	operation := func(ctx context.Context) error {
		var err error
		receipt, changed, err = value.resolveCurrent(ctx, conversationID, messageID, href, root)
		return err
	}
	if value.options.ConversationTransaction != nil {
		err = value.options.ConversationTransaction(ctx, conversationID, operation)
	} else {
		err = operation(ctx)
	}
	if err != nil {
		if ctx.Err() != nil {
			return RecoveryReceipt{}, ctx.Err()
		}
		var public *contracts.APIError
		if errors.As(err, &public) {
			return RecoveryReceipt{}, err
		}
		return RecoveryReceipt{}, recoveryChanged()
	}
	if changed && value.options.OnChange != nil {
		value.options.OnChange()
	}
	return receipt, nil
}

func (value *Recovery) resolveCurrent(ctx context.Context, conversationID, messageID, href, root string) (RecoveryReceipt, bool, error) {
	message, err := recoveryMessage(value.options.Store.Snapshot(), conversationID, messageID)
	if err != nil {
		return RecoveryReceipt{}, false, err
	}
	if !recoveryStoredLink(message.Text, href) {
		return RecoveryReceipt{}, false, recoveryInvalid()
	}
	relative, valid := OutputReference(root, href, true)
	if !valid {
		return RecoveryReceipt{}, false, recoveryUnavailable()
	}
	target := filepath.Join(root, relative)
	existing, err := recoveryExisting(message, target)
	if err != nil {
		return RecoveryReceipt{}, false, err
	}
	receipt := RecoveryReceipt{ConversationID: conversationID, MessageID: messageID, RestoredSnapshot: true}
	if existing != nil {
		if _, _, err := value.options.Collector.attachments.Read(ctx, existing.ID); err != nil {
			return RecoveryReceipt{}, false, recoveryUnavailable()
		}
		current, err := recoveryMessage(value.options.Store.Snapshot(), conversationID, messageID)
		if err != nil || current.Text != message.Text {
			return RecoveryReceipt{}, false, recoveryChanged()
		}
		attached, err := recoveryExisting(current, target)
		if err != nil || attached == nil || attached.ID != existing.ID {
			return RecoveryReceipt{}, false, recoveryChanged()
		}
		receipt.Attachment, receipt.Reused = *attached, true
		return receipt, false, nil
	}
	if len(message.Attachments) >= MaxMessageAttachments {
		return RecoveryReceipt{}, false, recoveryLimit()
	}

	data, name, err := value.options.Collector.ReadExplicit(ctx, root, target)
	if err != nil {
		return RecoveryReceipt{}, false, recoveryUnavailable()
	}
	attachment, err := value.options.Collector.attachments.Put(ctx, name, "", data)
	if err != nil {
		return RecoveryReceipt{}, false, recoveryUnavailable()
	}
	attachment.SourcePath = target

	err = value.options.Store.Mutate(ctx, func(state *contracts.State) error {
		current, err := recoveryMessage(*state, conversationID, messageID)
		if err != nil {
			return err
		}
		if current.Text != message.Text {
			return recoveryChanged()
		}
		prior, err := recoveryExisting(current, target)
		if err != nil {
			return err
		}
		if prior != nil {
			return recoveryChanged()
		}
		if len(current.Attachments) >= MaxMessageAttachments {
			return recoveryLimit()
		}
		current.Attachments = append(current.Attachments, attachment)
		current.Read = false
		return nil
	})
	if err != nil {
		var public *contracts.APIError
		if errors.As(err, &public) || ctx.Err() != nil {
			return RecoveryReceipt{}, false, err
		}
		return RecoveryReceipt{}, false, recoverySaveFailed()
	}
	receipt.Attachment = attachment
	return receipt, true, nil
}
