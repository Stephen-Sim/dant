package memory

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"regexp"
	"strings"
)

var attachmentID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func rawObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, ErrInvalidMemory
	}
	return object, nil
}

func rawInt(raw json.RawMessage) (int64, bool) {
	var value int64
	return value, json.Unmarshal(raw, &value) == nil
}

func rawString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func truncateText(value string, maximum int) string {
	return stringFromUnits(unitSlice(units(value), 0, maximum))
}

func safeProjectEntry(raw json.RawMessage) *ProjectEntry {
	object, err := rawObject(raw)
	if err != nil {
		return nil
	}
	id := rawString(object["messageId"])
	at, ok := rawInt(object["at"])
	if !validID(id) || !ok || !validTime(at) {
		return nil
	}
	entry := &ProjectEntry{MessageID: id, At: at, Text: truncateText(SanitizeText(rawString(object["text"])), 4000), Attachments: []ProjectAttachment{}}
	var original Text
	if json.Unmarshal(object["text"], &original) == nil && SanitizeText(rawString(object["text"])) == rawString(object["text"]) {
		original.units = append([]uint16{}, unitSlice(original.units, 0, 4000)...)
		entry.originalText = &original
		entry.decodedText = entry.Text
	}
	if turn := rawString(object["turnId"]); validID(turn) {
		entry.TurnID = &turn
	}
	var attachments []json.RawMessage
	_ = json.Unmarshal(object["attachments"], &attachments)
	if len(attachments) > 5 {
		attachments = attachments[:5]
	}
	for _, raw := range attachments {
		file, err := rawObject(raw)
		if err != nil {
			continue
		}
		id := rawString(file["id"])
		if !attachmentID.MatchString(id) {
			continue
		}
		attachment := ProjectAttachment{ID: id, Name: truncateText(SanitizeText(rawString(file["name"])), 200), Type: truncateText(SanitizeText(rawString(file["type"])), 100)}
		if size, ok := rawInt(file["size"]); ok && size >= 0 && size <= 10*1024*1024 {
			attachment.Size = &size
		}
		entry.Attachments = append(entry.Attachments, attachment)
	}
	return entry
}

func SafeProjectContext(raw json.RawMessage) (*ProjectContext, error) {
	object, err := rawObject(raw)
	if err != nil {
		return nil, err
	}
	version, ok := rawInt(object["version"])
	updated, timeOK := rawInt(object["updatedAt"])
	if !ok || version != 1 || !timeOK || !validTime(updated) {
		return nil, ErrInvalidMemory
	}
	project := &ProjectContext{Version: 1, ReferenceDataOnly: true, UpdatedAt: updated, OriginalRequest: safeProjectEntry(object["originalRequest"]), HumanUpdates: []ProjectEntry{}, Results: []ProjectEntry{}}
	for key, target := range map[string]*[]ProjectEntry{"humanUpdates": &project.HumanUpdates, "results": &project.Results} {
		var entries []json.RawMessage
		_ = json.Unmarshal(object[key], &entries)
		if len(entries) > 8 {
			entries = entries[len(entries)-8:]
		}
		for _, raw := range entries {
			if entry := safeProjectEntry(raw); entry != nil {
				*target = append(*target, *entry)
			}
		}
	}
	for {
		data, _ := json.Marshal(project)
		if len(data) <= MaxNoteBytes {
			break
		}
		if len(project.HumanUpdates) == 0 && len(project.Results) == 0 {
			return nil, ErrInvalidMemory
		}
		if len(project.HumanUpdates) > 0 && (len(project.Results) == 0 || project.HumanUpdates[0].At <= project.Results[0].At) {
			project.HumanUpdates = project.HumanUpdates[1:]
		} else {
			project.Results = project.Results[1:]
		}
	}
	return project, nil
}

func projectText(project *ProjectContext) string {
	parts := []string{}
	if project.OriginalRequest != nil {
		parts = append(parts, project.OriginalRequest.Text)
	}
	for _, entry := range project.HumanUpdates {
		parts = append(parts, entry.Text)
	}
	for _, entry := range project.Results {
		parts = append(parts, entry.Text)
	}
	return strings.Join(parts, "\n")
}

func projectTextUnits(project *ProjectContext) []uint16 {
	result := []uint16{}
	count := 0
	add := func(entry ProjectEntry) {
		if count > 0 {
			result = append(result, '\n')
		}
		count++
		if entry.originalText != nil && entry.Text == entry.decodedText {
			result = append(result, entry.originalText.units...)
		} else {
			result = append(result, units(entry.Text)...)
		}
	}
	if project.OriginalRequest != nil {
		add(*project.OriginalRequest)
	}
	for _, entry := range project.HumanUpdates {
		add(entry)
	}
	for _, entry := range project.Results {
		add(entry)
	}
	return result
}

func (s *Store) ReadProject(ctx context.Context, conversation, work string) (*ProjectContext, error) {
	if !validID(conversation) || !validID(work) {
		return nil, ErrInvalidScope
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var result *ProjectContext
	err := s.transaction(ctx, false, func(tx *sql.Tx) error {
		var raw string
		err := tx.QueryRowContext(ctx, "SELECT context_json FROM projects WHERE conversation_id=? AND work_id=?", conversation, work).Scan(&raw)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		result, err = SafeProjectContext(json.RawMessage(raw))
		return err
	})
	return result, err
}

func (s *Store) WriteProject(ctx context.Context, conversation, work string, raw json.RawMessage) (*ProjectContext, error) {
	if !validID(conversation) || !validID(work) {
		return nil, ErrInvalidScope
	}
	project, err := SafeProjectContext(raw)
	if err != nil {
		return nil, err
	}
	data, err := marshalJS(project)
	if err != nil || len(data) > MaxNoteBytes {
		return nil, ErrInvalidMemory
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	err = s.transaction(ctx, true, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO projects(conversation_id,work_id,context_json) VALUES(?,?,?) ON CONFLICT(conversation_id,work_id) DO UPDATE SET context_json=excluded.context_json", conversation, work, string(data))
		return err
	})
	return project, err
}

func marshalJS(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	data := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	data = bytes.ReplaceAll(data, []byte(`\u2028`), []byte("\u2028"))
	data = bytes.ReplaceAll(data, []byte(`\u2029`), []byte("\u2029"))
	return data, nil
}

func (entry ProjectEntry) MarshalJSON() ([]byte, error) {
	type wire ProjectEntry
	data, err := marshalJS(wire(entry))
	if err != nil {
		return nil, err
	}
	if entry.originalText == nil || entry.Text != entry.decodedText {
		return data, nil
	}
	var object map[string]json.RawMessage
	if err = json.Unmarshal(data, &object); err != nil {
		return nil, err
	}
	object["text"], err = entry.originalText.MarshalJSON()
	if err != nil {
		return nil, err
	}
	return marshalJS(object)
}
