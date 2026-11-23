// Test-only TLS upstream fixture. Never compiled into the application image.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

func main() {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		log.Fatal(err)
	}
	template := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "WB Pulse synthetic test fixture"}, DNSNames: []string{"www.workbuddy.cn", "www.codebuddy.cn", "www.workbuddy.ai"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	if err = os.WriteFile(os.Getenv("FIXTURE_CERT"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		log.Fatal(err)
	}
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
	var mu sync.Mutex
	counts := map[string]int{}
	allowed := map[string]bool{"www.workbuddy.cn:443": true, "www.codebuddy.cn:443": true, "www.workbuddy.ai:443": true}
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/counts" && r.Method == "GET" {
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode(counts)
			return
		}
		if r.Method != http.MethodConnect || !allowed[r.Host] {
			http.Error(w, "synthetic fixture only", 403)
			return
		}
		raw, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		if _, err = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			raw.Close()
			return
		}
		if err = rw.Flush(); err != nil {
			raw.Close()
			return
		}
		conn := &trackedConnection{Conn: tls.Server(raw, tlsConfig), done: make(chan struct{})}
		go func() {
			defer conn.Close()
			upstream := http.Server{ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 2 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer synthetic-e2e-") {
					http.Error(w, "only synthetic test credentials accepted", 401)
					return
				}
				if r.Header.Get("X-WB-Pulse") != "" || r.Header.Get("Cookie") != "" {
					http.Error(w, "private browser headers leaked", 400)
					return
				}
				mu.Lock()
				counts[r.Host+r.URL.Path]++
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				// Deliberately no Access-Control-Allow-Origin: browser CORS must be irrelevant.
				if r.URL.Path == "/console/account" {
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"email": "synthetic-e2e@example.test"}})
					return
				}
				if r.URL.Path == "/billing/meter/get-user-resource-summary" {
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"Packages": []map[string]int{{"CycleUsedCapacity": 7, "CycleTotalCapacity": 100}}}})
					return
				}
				http.NotFound(w, r)
			})}
			_ = upstream.Serve(&oneConnection{conn: conn})
		}()
	})
	addr := os.Getenv("FIXTURE_ADDR")
	if addr == "" {
		addr = "127.0.0.1:18092"
	}
	log.Printf("Synthetic TLS fixture listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, proxy))
}

type oneConnection struct {
	conn *trackedConnection
	used bool
}

func (l *oneConnection) Accept() (net.Conn, error) {
	if l.used {
		<-l.conn.done
		return nil, fmt.Errorf("complete")
	}
	l.used = true
	return l.conn, nil
}
func (l *oneConnection) Close() error   { return nil }
func (l *oneConnection) Addr() net.Addr { return l.conn.LocalAddr() }

type trackedConnection struct {
	net.Conn
	done chan struct{}
	once sync.Once
}

func (c *trackedConnection) Close() error { c.once.Do(func() { close(c.done) }); return c.Conn.Close() }
