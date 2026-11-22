package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStaticApplication(t *testing.T) {
	srv := httptest.NewServer(New())
	defer srv.Close()
	for _, path := range []string{"/", "/app.js", "/api.js", "/style.css", "/icons/logo.svg"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d", path, resp.StatusCode)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: missing security headers", path)
		}
		resp.Body.Close()
	}
}

func TestHealthAndMethods(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	New().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("health status = %d", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["status"] != "ok" {
		t.Fatalf("bad health: %s", w.Body)
	}

	w = httptest.NewRecorder()
	New().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", w.Code)
	}
	w = httptest.NewRecorder()
	New().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/missing", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d", w.Code)
	}
}
