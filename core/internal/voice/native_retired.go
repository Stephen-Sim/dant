package voice

const nativeRetiredSessionLimit = 64

type nativeRetiredIDs struct {
	order []string
	set   map[string]bool
}

func (ids *nativeRetiredIDs) has(value string) bool { return ids.set[value] }
func (ids *nativeRetiredIDs) add(value string) {
	if value == "" || ids.has(value) {
		return
	}
	if ids.set == nil {
		ids.set = map[string]bool{}
	}
	ids.set[value] = true
	ids.order = append(ids.order, value)
	for len(ids.order) > nativeRetiredSessionLimit {
		delete(ids.set, ids.order[0])
		ids.order = ids.order[1:]
	}
}
