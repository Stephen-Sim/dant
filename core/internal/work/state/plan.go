package state

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	MaxTimestamp        = 8_640_000_000_000_000
	IDLength            = 128
	ReferenceIDLength   = 256
	RuntimeIDLength     = 512
	PlanSteps           = 128
	PlanTitleLength     = 240
	PlanInputStepLength = 5_000
	PublicStepLength    = 240
	ObservedItems       = 128
)

var ErrInvalidPlan = errors.New("invalid_task_plan")

type PlanInput struct {
	WorkID      string
	Title       string
	LegacyTitle contracts.LegacyJSON
	Plan        contracts.TaskPlan
	Status      contracts.Optional[contracts.WorkStatus]
}

// SliceText follows JavaScript UTF-16 slice boundaries. Legacy strings whose
// boundary is a lone surrogate retain their raw JSON through the owning DTO.
func SliceText(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

func visible(
	value string,
	limit int,
	redact func(string) string) string {
	if redact != nil {
		value = redact(value)
	}
	value = strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return ' '
		}
		return character
	}, value)
	return SliceText(contracts.TrimText(value), limit)
}

func publicText(
	value string,
	legacy contracts.LegacyJSON,
	key string,
	limit int,
	redact func(string) string) (string, json.RawMessage) {
	units := utf16.Encode([]rune(value))
	if raw, exists := legacy.Original[key]; exists && legacy.Decoded[key] == value {
		if original, ok := jsonStringUnits(raw); ok {
			units = original
		}
	}
	if redact != nil {
		if changed := redact(value); changed != value {
			units = utf16.Encode([]rune(changed))
		}
	}
	for index, unit := range units {
		if unit < 0x20 || unit == 0x7f {
			units[index] = ' '
		}
	}
	space := func(unit uint16) bool {
		return contracts.TrimText(string(rune(unit))) == ""
	}
	for len(units) > 0 && space(units[0]) {
		units = units[1:]
	}
	for len(units) > 0 && space(units[len(units)-1]) {
		units = units[:len(units)-1]
	}
	if len(units) > limit {
		units = units[:limit]
	}
	return string(utf16.Decode(units)), json.RawMessage(canonicalUnits(units))
}

func preservedText(key, value string, raw json.RawMessage) contracts.LegacyJSON {
	return contracts.LegacyJSON{Original: contracts.RawObject{key: raw}, Decoded: map[string]string{key: value}}
}

func PublicPlan(
	steps []contracts.PlanStep,
	redact func(string) string) (contracts.TaskPlan, error) {
	result := contracts.TaskPlan{Steps: make([]contracts.PlanStep, 0, len(steps))}
	if len(steps) < 1 || len(steps) > PlanSteps {
		return result, ErrInvalidPlan
	}
	for _, step := range steps {
		if !step.Status.Valid() || contracts.UTF16Length(step.Step) > PlanInputStepLength || contracts.TrimText(step.Step) == "" {
			return contracts.TaskPlan{}, ErrInvalidPlan
		}
		text, raw := publicText(step.Step, step.LegacyText, "step", PublicStepLength, redact)
		if text == "" {
			return contracts.TaskPlan{}, ErrInvalidPlan
		}
		result.Steps = append(result.Steps, contracts.PlanStep{Step: text, Status: step.Status, LegacyText: preservedText("step", text, raw)})
		if step.Status == contracts.PlanStepStatusCompleted {
			result.Completed++
		}
	}
	result.Total = len(result.Steps)
	for _, status := range []contracts.PlanStepStatus{contracts.PlanStepStatusInProgress, contracts.PlanStepStatusPending} {
		for _, step := range result.Steps {
			if step.Status == status {
				result.CurrentStep = step.Step
				result.LegacyText = preservedText("currentStep", step.Step, step.LegacyText.Original["step"])
				return result, nil
			}
		}
	}
	return result, nil
}

func ReadPlanInput(
	raw contracts.RawObject,
	redact func(string) string) (PlanInput, error) {
	result := PlanInput{}
	for key := range raw {
		switch key {
		case "workId", "title", "steps", "status":
		default:
			return result, ErrInvalidPlan
		}
	}
	if json.Unmarshal(raw["title"], &result.Title) != nil || contracts.TrimText(result.Title) == "" || contracts.UTF16Length(result.Title) > PlanTitleLength {
		return result, ErrInvalidPlan
	}
	originalTitle := result.Title
	var rawTitle json.RawMessage
	result.Title, rawTitle = publicText(result.Title, preservedText("title", originalTitle, raw["title"]), "title", PlanTitleLength, redact)
	result.LegacyTitle = preservedText("title", result.Title, rawTitle)
	if result.Title == "" {
		return result, ErrInvalidPlan
	}
	if value, exists := raw["workId"]; exists {
		if !contracts.ValidUnicodeJSON(value) || json.Unmarshal(value, &result.WorkID) != nil || !ValidID(result.WorkID, IDLength) {
			return result, ErrInvalidPlan
		}
	}
	if value, exists := raw["status"]; exists {
		var status contracts.WorkStatus
		if json.Unmarshal(value, &status) != nil || (status != contracts.WorkStatusRunning && status != contracts.WorkStatusWaitingUser) {
			return result, ErrInvalidPlan
		}
		result.Status = contracts.Some(status)
	}
	var steps []contracts.PlanStep
	if json.Unmarshal(raw["steps"], &steps) != nil {
		return result, ErrInvalidPlan
	}
	plan, err := PublicPlan(steps, redact)
	if err != nil {
		return result, err
	}
	if result.Status.Value == contracts.WorkStatusWaitingUser {
		pending := false
		for _, step := range plan.Steps {
			if step.Status == contracts.PlanStepStatusInProgress {
				return result, ErrInvalidPlan
			}
			pending = pending || step.Status == contracts.PlanStepStatusPending
		}
		if !pending {
			return result, ErrInvalidPlan
		}
	}
	result.Plan = plan
	return result, nil
}
