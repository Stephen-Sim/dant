package telegram

import (
	"context"
	"errors"
)

// IntakeFailureCode contains operational classifications, never upstream errors
// or message/account identifiers.
type IntakeFailureCode string

const (
	IntakeQueueFull         IntakeFailureCode = "TELEGRAM_QUEUE_FULL"
	IntakeAttachmentFailed  IntakeFailureCode = "TELEGRAM_ATTACHMENT_FAILED"
	IntakePersistenceFailed IntakeFailureCode = "TELEGRAM_PERSISTENCE_FAILED"
	IntakeAdmissionRejected IntakeFailureCode = "TELEGRAM_ADMISSION_REJECTED"
	IntakeCancelled         IntakeFailureCode = "TELEGRAM_INTAKE_CANCELLED"
	IntakeTimeout           IntakeFailureCode = "TELEGRAM_INTAKE_TIMEOUT"
)

func (gateway *Gateway) intakeFailure(ctx context.Context, err error, stage IntakeFailureCode) IntakeFailureCode {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(gateway.ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		stage = IntakeTimeout
	} else if ctx.Err() != nil || gateway.ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, ErrClosed) {
		stage = IntakeCancelled
	}
	if gateway.options.ReportIncomingFailure != nil {
		gateway.options.ReportIncomingFailure(stage)
	}
	return stage
}

func (gateway *Gateway) intakeFailureText(code IntakeFailureCode) string {
	keys := map[IntakeFailureCode]string{
		IntakeQueueFull:         "intakeQueueFull",
		IntakeAttachmentFailed:  "intakeAttachmentFailed",
		IntakePersistenceFailed: "intakePersistenceFailed",
		IntakeAdmissionRejected: "intakeAdmissionRejected",
		IntakeCancelled:         "intakeCancelled",
		IntakeTimeout:           "intakeTimeout",
	}
	return gateway.word(keys[code])
}
