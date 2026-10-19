package voice

// changeKey uses the same short owner fence as call startup, so a protected-key
// write cannot race a provider reading credentials for a new call.
func (service *Service) changeKey(operation func() error) error {
	service.mu.Lock()
	if service.starting {
		service.mu.Unlock()
		return ErrVoiceBusy
	}
	service.starting = true
	service.mu.Unlock()
	defer func() {
		service.mu.Lock()
		service.starting = false
		service.mu.Unlock()
	}()

	if service.Snapshot() != nil {
		return ErrVoiceBusy
	}
	return operation()
}
