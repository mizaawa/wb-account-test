package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func relayRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-WB-Pulse", "1")
	r.Header.Set("Authorization", "Bearer fixture-token")
	return r
}
func fixtureRelay(fn roundTripFunc) *relayHandler {
	h := newRelay()
	h.client.Transport = fn
	return h
}
func TestRelayRoutesAndHeaderIsolation(t *testing.T) {
	for _, realm := range []string{"cn", "intl"} {
		for _, action := range []string{"profile", "summary", "resource", "enterprise", "enterprise-key", "refresh"} {
			t.Run(realm+"/"+action, func(t *testing.T) {
				route, _ := routeFor(realm, action)
				h := fixtureRelay(func(r *http.Request) (*http.Response, error) {
					if r.URL.String() != route.url || r.Method != route.method {
						t.Fatalf("wrong route: %s %s", r.Method, r.URL)
					}
					for _, header := range []string{"Cookie", "Origin", "X-WB-Pulse", "X-Evil", "Forwarded", "X-Forwarded-For"} {
						if r.Header.Get(header) != "" {
							t.Errorf("forwarded %s", header)
						}
					}
					if r.Header.Get("Authorization") != "Bearer fixture-token" {
						t.Fatal("missing auth")
					}
					if r.Header.Get("X-User-Id") != "fixture-user" {
						t.Fatal("missing uid")
					}
					return &http.Response{StatusCode: 200, Header: http.Header{"Set-Cookie": []string{"secret=1"}}, Body: io.NopCloser(strings.NewReader(`{"code":0,"data":{}}`))}, nil
				})
				body := ""
				if route.method == http.MethodPost {
					body = "{}"
				}
				r := relayRequest(route.method, "/api/"+realm+"/"+action, body)
				for _, header := range []string{"Cookie", "X-Evil", "Forwarded", "X-Forwarded-For"} {
					r.Header.Set(header, "private")
				}
				r.Header.Set("X-User-Id", "fixture-user")
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Set-Cookie") != "" {
					t.Fatalf("response: %d %v", w.Code, w.Header())
				}
			})
		}
	}
}
func TestRelayRejectsUntrustedRequests(t *testing.T) {
	cases := []struct {
		name, path, method, body string
		status                   int
		header, value            string
	}{
		{"unknown", "/api/cn/anything", "POST", "{}", 404, "", ""},
		{"realm", "/api/evil/profile", "GET", "", 404, "", ""},
		{"query", "/api/cn/profile?url=https://evil.example", "GET", "", 404, "", ""},
		{"traversal", "/api/cn/../profile", "GET", "", 404, "", ""},
		{"method", "/api/cn/profile", "POST", "{}", 405, "", ""},
		{"preflight", "/api/cn/profile", "OPTIONS", "", 405, "", ""},
		{"cross-origin", "/api/cn/profile", "GET", "", 403, "Origin", "https://evil.example"},
		{"null-origin", "/api/cn/profile", "GET", "", 403, "Origin", "null"},
		{"cross-site", "/api/cn/profile", "GET", "", 403, "Sec-Fetch-Site", "cross-site"},
		{"missing-marker", "/api/cn/profile", "GET", "", 403, "X-WB-Pulse", ""},
		{"no-auth", "/api/cn/profile", "GET", "", 401, "Authorization", ""},
		{"bad-json", "/api/cn/summary", "POST", "bad", 400, "", ""},
		{"get-body", "/api/cn/profile", "GET", "{}", 400, "", ""},
		{"oversize", "/api/cn/summary", "POST", strings.Repeat("x", maxRequestBytes+1), 413, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := fixtureRelay(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream request"); return nil, nil })
			r := relayRequest(tc.method, tc.path, tc.body)
			if tc.header != "" {
				r.Header.Set(tc.header, tc.value)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d want %d", w.Code, tc.status)
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("CORS enabled")
			}
		})
	}
}
func TestRelayBlocksRedirectsAndSanitizesErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{"redirect", 302, "{}", 502}, {"html", 200, "<html>private</html>", 502}, {"unauthorized", 401, "denied", 401},
		{"large", 200, strings.Repeat("x", maxResponseBytes+1), 502}, {"json", 429, `{"code":429}`, 429},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := 0
			h := fixtureRelay(func(*http.Request) (*http.Response, error) {
				called++
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Location": []string{"https://evil.example"}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, relayRequest("GET", "/api/cn/profile", ""))
			if w.Code != tc.want || called != 1 || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("unsafe response %d %s", w.Code, w.Body)
			}
		})
	}
	h := fixtureRelay(func(*http.Request) (*http.Response, error) { return nil, errors.New("fixture-token private detail") })
	w := httptest.NewRecorder()
	h.ServeHTTP(w, relayRequest("GET", "/api/cn/profile", ""))
	if w.Code != 502 || bytes.Contains(w.Body.Bytes(), []byte("fixture-token")) {
		t.Fatal("network error leaked")
	}
}
func TestRelayCancellationAndCapacity(t *testing.T) {
	h := fixtureRelay(func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := relayRequest("GET", "/api/cn/profile", "").WithContext(ctx)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 504 {
		t.Fatalf("cancel status %d", w.Code)
	}
	h.slots = make(chan struct{}, 1)
	h.slots <- struct{}{}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, relayRequest("GET", "/api/cn/profile", ""))
	if w.Code != 503 {
		t.Fatal("capacity not enforced")
	}
}
func TestRelaySameHostTLSOrigin(t *testing.T) {
	h := fixtureRelay(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})
	r := relayRequest("GET", "/api/cn/profile", "")
	r.Header.Set("Origin", "https://example.com")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("TLS terminator origin: %d", w.Code)
	}
	if h.client.Timeout > 20*time.Second {
		t.Fatal("relay must time out before browser")
	}
}

func TestRefreshTargetsAndTenantHeader(t *testing.T) {
	for realm, target := range map[string]string{"cn": "https://copilot.tencent.com/v2/plugin/auth/token/refresh", "intl": "https://www.workbuddy.ai/v2/plugin/auth/token/refresh"} {
		route, ok := routeFor(realm, "refresh")
		if !ok || route.url != target {
			t.Fatalf("unexpected refresh target for %s: %s", realm, route.url)
		}
	}
	h := fixtureRelay(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("X-Tenant-Id") != "fixture-tenant" {
			t.Fatal("missing enterprise tenant")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"code":0,"data":{"credit":0,"limitNum":10}}`))}, nil
	})
	r := relayRequest("POST", "/api/cn/enterprise", "{}")
	r.Header.Set("X-Tenant-Id", "fixture-tenant")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("tenant request: %d", w.Code)
	}
}
