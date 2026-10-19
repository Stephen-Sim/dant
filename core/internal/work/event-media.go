package work

import (
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func (value *Engine) scopeMediaEvent(event runtime.Event) runtime.Event {
	if !event.IsRequest() || event.Method != "item/tool/call" || eventString(event.Params, "tool") != "end_call" || event.MediaCallID.Present {
		return event
	}
	event.MediaCallID = contracts.Null[string]()
	if call := value.CallSnapshot(); call != nil {
		event.MediaCallID = contracts.Some(call.ID)
	}
	return event
}
