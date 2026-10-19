package diagnostics

// Route templates contain no user identifiers or query strings.
var routes = func() map[string]bool {
	result := map[string]bool{}
	for _, route := range []string{
		"/api/:unknown", "/api/session", "/api/events", "/api/state", "/api/version", "/api/diagnostics",
		"/api/provision", "/api/connect", "/api/prepare", "/api/vm/profiles", "/api/vm/providers", "/api/vm/import",
		"/api/fonts", "/api/notifications/pending", "/api/notifications/:id/ack", "/api/internal/credentials",
		"/api/messages", "/api/messages/:id", "/api/messages/:id/reaction", "/api/messages/:id/metadata",
		"/api/messages/:id/output-link/resolve", "/api/history", "/api/credentials", "/api/credentials/:id",
		"/api/credentials/requests/:id", "/api/skills", "/api/skills/:name", "/api/skills/:name/export",
		"/api/skills/import/preview", "/api/skills/import", "/api/skills/import/previews/:id",
		"/api/telegram", "/api/telegram/config", "/api/telegram/pair", "/api/telegram/disconnect",
		"/api/login", "/api/logout", "/api/voice-key", "/api/settings", "/api/controller/settings",
		"/api/memory", "/api/memory/:name", "/api/memory/manage", "/api/memory/view",
		"/api/memory/manage/:kind/:id", "/api/memory/manage/:kind/:id/confirm",
		"/api/read", "/api/retry/:id", "/api/stop", "/api/tasks/pause", "/api/tasks/resume",
		"/api/tasks/:id/accept", "/api/tasks/:id/pause", "/api/tasks/:id/resume", "/api/tasks/:id/cancel",
		"/api/tasks/clear-completed", "/api/tasks/:id/priority", "/api/tasks/:id/dismiss", "/api/tasks/:id/context",
		"/api/steer", "/api/takeover", "/api/screen", "/api/input", "/api/upload", "/api/files/:id",
		"/api/call", "/api/call/connected", "/api/realtime/message", "/api/call/stop", "/api/voices",
		"/api/schedules", "/api/schedules/:id", "/api/updates", "/api/backups", "/api/backups/settings",
		"/api/backups/run", "/api/backups/import", "/api/backups/export", "/api/backups/info",
		"/api/backups/:id/preview", "/api/backups/:id/restore", "/api/backups/:id/export",
		"/health", "/screen", "/input", "/control",
	} {
		result[route] = true
	}
	return result
}()
