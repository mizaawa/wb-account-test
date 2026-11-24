package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxRequestBytes = 64 << 10
const maxResponseBytes = 2 << 20

type upstreamRoute struct{ method, url string }
type relayHandler struct {
	client *http.Client
	slots  chan struct{}
}

// Only these read-only account/usage endpoints and token refresh are reachable.
// The caller cannot supply a URL, host, path, redirect target or query string.
func routeFor(realm, action string) (upstreamRoute, bool) {
	web, billing, refresh := "", "", ""
	switch realm {
	case "cn":
		web, billing, refresh = "https://www.workbuddy.cn", "https://www.codebuddy.cn", "https://copilot.tencent.com"
	case "intl":
		web, billing, refresh = "https://www.workbuddy.ai", "https://www.workbuddy.ai", "https://www.workbuddy.ai"
	default:
		return upstreamRoute{}, false
	}
	routes := map[string]upstreamRoute{
		"profile":        {http.MethodGet, web + "/console/account"},
		"summary":        {http.MethodPost, billing + "/billing/meter/get-user-resource-summary"},
		"resource":       {http.MethodPost, billing + "/v2/billing/meter/get-user-resource"},
		"enterprise":     {http.MethodPost, billing + "/billing/meter/get-enterprise-user-usage"},
		"enterprise-key": {http.MethodPost, billing + "/v2/billing/meter/get-enterprise-user-usage"},
		"refresh":        {http.MethodPost, refresh + "/v2/plugin/auth/token/refresh"},
	}
	route, ok := routes[action]
	return route, ok
}
func newRelay() *relayHandler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 16
	transport.ResponseHeaderTimeout = 15 * time.Second
	return &relayHandler{client: &http.Client{Transport: transport, Timeout: 18 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, slots: make(chan struct{}, 64)}
}
func relayError(w http.ResponseWriter, status int, kind, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": kind, "message": message})
}
func (h *relayHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/"), "/")
	if len(parts) != 2 || r.URL.RawQuery != "" {
		relayError(w, 404, "route", "不支持的接口")
		return
	}
	route, ok := routeFor(parts[0], parts[1])
	if !ok {
		relayError(w, 404, "route", "不支持的接口")
		return
	}
	if r.Method != route.method {
		w.Header().Set("Allow", route.method)
		relayError(w, 405, "method", "请求方法不正确")
		return
	}
	// No CORS access is granted. A custom header prevents cross-site form calls.
	if r.Header.Get("X-WB-Pulse") != "1" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		relayError(w, 403, "origin", "仅允许当前站点请求")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || !strings.EqualFold(parsed.Host, r.Host) {
			relayError(w, 403, "origin", "请求来源不匹配")
			return
		}
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")) == "" {
		relayError(w, 401, "auth", "缺少登录凭证")
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		relayError(w, 503, "busy", "服务器繁忙，请稍后重试")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		relayError(w, 413, "body", "请求内容过大或无法读取")
		return
	}
	if r.Method == http.MethodGet && len(body) != 0 {
		relayError(w, 400, "body", "GET 请求不能携带内容")
		return
	}
	if r.Method == http.MethodPost && !json.Valid(body) {
		relayError(w, 400, "body", "请求必须为 JSON")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 18*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, route.method, route.url, bytes.NewReader(body))
	if err != nil {
		relayError(w, 500, "request", "请求创建失败")
		return
	}
	for _, key := range []string{"Authorization", "X-User-Id", "X-Domain", "X-Enterprise-Id", "X-Tenant-Id", "X-No-Enterprise-Id", "X-API-Key", "X-Refresh-Token", "X-Auth-Refresh-Source", "X-Product", "Accept-Language"} {
		if value := r.Header.Get(key); value != "" {
			req.Header.Set(key, value)
		}
	}
	req.Header.Set("Accept", "application/json")
	if route.method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("X-Client-Platform", "web")
	req.Header.Set("X-CodeBuddy-Request", "1")
	resp, err := h.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			relayError(w, 504, "timeout", "连接官方接口超时，请稍后重试")
		} else {
			relayError(w, 502, "network", "服务器无法连接官方接口，请检查部署服务器网络")
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		relayError(w, 502, "redirect", "官方接口重定向已阻止，请检查接口配置")
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes {
		relayError(w, 502, "response", "官方接口响应异常")
		return
	}
	// Do not forward cookies, authentication challenges, redirects or upstream headers.
	if !json.Valid(data) {
		status := http.StatusBadGateway
		if resp.StatusCode >= 400 {
			status = resp.StatusCode
		}
		relayError(w, status, "upstream", "官方接口返回了非 JSON 数据")
		return
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}
