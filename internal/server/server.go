// Package server serves the static application. Credentials never pass through it.
package server

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// StaticFiles contains the browser-only application.
//
//go:embed static
var StaticFiles embed.FS

// New returns the static web application handler.
func New() http.Handler {
	assets, err := fs.Sub(StaticFiles, "static")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https://www.workbuddy.ai https://www.workbuddy.cn https://copilot.tencent.com https://www.codebuddy.cn; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
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
		w.Header().Set("Cache-Control", "no-cache")
		// A small wrapper is unnecessary: the application intentionally has no
		// backend API, and all non-root paths map directly to embedded files.
		files.ServeHTTP(w, r)
	})
}
