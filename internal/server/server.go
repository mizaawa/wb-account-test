// Package server serves the application and a fixed, non-persistent upstream relay.
package server

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
)

// StaticFiles contains the application.
//
//go:embed static
var StaticFiles embed.FS

const Version = "2.0.1"

// New returns the web application handler.
func New() http.Handler {
	assets, err := fs.Sub(StaticFiles, "static")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(assets))
	relay := newRelay()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-WB-Pulse-Version", Version)
		w.Header().Set("Cache-Control", "no-store, max-age=0")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		if r.URL.Path == "/api/status" {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(map[string]string{"service": "wb-pulse", "version": Version, "relay": "same-origin"})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			relay.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/healthz" {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if strings.Contains(r.URL.Path, "..") {
			http.NotFound(w, r)
			return
		}
		// Versioned assets and no-store prevent stale direct-to-upstream clients.
		// Other paths map directly to embedded files.
		files.ServeHTTP(w, r)
	})
}
