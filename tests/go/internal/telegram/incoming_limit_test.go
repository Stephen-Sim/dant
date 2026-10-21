package telegram

import (
	"strings"
	"testing"
)

func TestIncomingUnicodeLimitPreservesExactTextAndNeverReplaysRejectedIntake(t *testing.T) {
	for _, accepted := range []bool{true, false} {
		t.Run(map[bool]string{true: "at-limit", false: "over-limit"}[accepted], func(t *testing.T) {
			fixture := fixture(t)
			count := 50000
			if !accepted {
				count++
			}
			text := strings.Repeat("😀", count)
			update := behaviorUpdate(t, 100, text)

			if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
				t.Fatal(err)
			}
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
				t.Fatal(err)
			}
			state := fixture.Store.Snapshot()
			receipts := fixture.Gateway.config.Receipts
			if len(receipts) != 1 || fixture.Gateway.config.Offset != 101 {
				t.Fatal("intake lost its durable deduplication receipt")
			}
			if accepted {
				if fixture.Admitted.Load() != 1 || len(state.Messages) != 1 || state.Messages[0].Text != text || receipts[0].Status != ReceiptDone {
					t.Fatal("exact-limit Unicode input was changed, rejected, or replayed")
				}
			} else if fixture.Admitted.Load() != 0 || len(state.Messages) != 0 || receipts[0].Status != ReceiptFailed {
				t.Fatal("over-limit input crossed admission or lost its failure receipt")
			}
		})
	}
}
