package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
)

func TestEmbeddedVueApplication(t *testing.T) {
	handler := New()
	index := httptest.NewRecorder()
	handler.ServeHTTP(index, httptest.NewRequest(http.MethodGet, "/", nil))
	if index.Code != http.StatusOK {
		t.Fatalf("index status = %d", index.Code)
	}
	for _, needle := range []string{"WB Pulse", "./assets/", "type=\"module\""} {
		if !regexp.MustCompile(regexp.QuoteMeta(needle)).Match(index.Body.Bytes()) {
			t.Errorf("index is missing %q", needle)
		}
	}
	assets := regexp.MustCompile(`\./assets/([^"']+\.(?:js|css))`).FindAllSubmatch(index.Body.Bytes(), -1)
	if len(assets) < 2 {
		t.Fatalf("Vue JS/CSS assets not embedded in index: %s", index.Body.String())
	}
	for _, asset := range assets {
		path := "/assets/" + string(asset[1])
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Errorf("%s: HTTP %d", path, w.Code)
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s missing security headers", path)
		}
		if w.Header().Get("Cache-Control") != "no-store, max-age=0" {
			t.Errorf("%s can keep stale versioned assets", path)
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/pulse.svg", nil))
	if w.Code != http.StatusOK {
		t.Errorf("favicon status = %d", w.Code)
	}
}

func TestHealthStatusAndMethods(t *testing.T) {
	for _, tc := range []struct {
		path string
		want map[string]string
	}{
		{"/healthz", map[string]string{"status": "ok"}},
		{"/api/status", map[string]string{"service": "wb-pulse", "version": "2.0.1", "relay": "same-origin"}},
	} {
		w := httptest.NewRecorder()
		New().ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: HTTP %d", tc.path, w.Code)
		}
		got := map[string]string{}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		for key, want := range tc.want {
			if got[key] != want {
				t.Errorf("%s %s = %q; want %q", tc.path, key, got[key], want)
			}
		}
	}
	w := httptest.NewRecorder()
	New().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /: %d", w.Code)
	}
}

func TestEmbeddedStaticFilesHaveNoBuildInternals(t *testing.T) {
	if _, err := fs.Stat(StaticFiles, "static/index.html"); err != nil {
		t.Fatal(err)
	}
}
