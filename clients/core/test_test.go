package core

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTestUnreadableInput(t *testing.T) {
	if got := Test("not json"); got != "{}" {
		t.Fatalf("got %q", got)
	}
}

// A node whose transports do not answer is -1; a transport mihomo cannot parse does not fail the others.
func TestTestUnreachableNode(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close() // nothing listens there now
	input, _ := json.Marshal(map[string]any{"url": "http://www.gstatic.com/generate_204", "timeoutMs": 1500, "nodes": map[string]any{
		"n1": []map[string]any{
			{"name": "reality", "type": "vless", "server": "127.0.0.1", "port": port, "uuid": "11111111-2222-3333-4444-555555555555", "network": "tcp", "tls": true,
				"servername": "www.example.com", "client-fingerprint": "chrome", "reality-opts": map[string]any{"public-key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short-id": "0123456789abcdef"}},
			{"name": "broken", "type": "nope"},
		},
	}})
	var reply map[string]testResult
	if err := json.Unmarshal([]byte(Test(string(input))), &reply); err != nil {
		t.Fatal(err)
	}
	if reply["n1"].Ms != -1 || reply["n1"].Lines["reality"] != -1 || reply["n1"].Lines["broken"] != -1 {
		t.Fatalf("got %v", reply)
	}
}

// Through a working transport the node gets a delay: a local CONNECT proxy in front of a local page.
func TestTestReachableNode(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer page.Close()
	proxy := connectProxy()
	defer proxy.Close()
	address := proxy.Listener.Addr().(*net.TCPAddr)
	input, _ := json.Marshal(map[string]any{"url": page.URL + "/generate_204", "timeoutMs": 3000, "nodes": map[string]any{
		"n1": []map[string]any{
			{"name": "down", "type": "http", "server": "127.0.0.1", "port": 1},
			{"name": "up", "type": "http", "server": "127.0.0.1", "port": address.Port},
		},
		"n2": []map[string]any{},
	}})
	var reply map[string]testResult
	if err := json.Unmarshal([]byte(Test(string(input))), &reply); err != nil {
		t.Fatal(err)
	}
	if reply["n1"].Ms < 0 || reply["n1"].Lines["up"] != reply["n1"].Ms || reply["n1"].Lines["down"] != -1 || reply["n2"].Ms != -1 {
		t.Fatalf("got %v", reply)
	}
}

// connectProxy is a local HTTP CONNECT proxy: a transport mihomo can dial in tests.
func connectProxy() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "connect only", http.StatusMethodNotAllowed)
			return
		}
		upstream, err := net.Dial("tcp", r.Host)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		client, _, _ := w.(http.Hijacker).Hijack()
		_, _ = client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
		go func() { _, _ = io.Copy(upstream, client); _ = upstream.Close() }()
		_, _ = io.Copy(client, upstream)
		_ = client.Close()
	}))
}

// The speed test downloads through the group's current transport and reports latency, bytes and Mbps.
func TestSpeedThroughGroup(t *testing.T) {
	if got := SpeedStart(`{"group":"Nope","pingUrl":"http://x/","url":"http://x/"}`); got != "error not connected" {
		t.Fatalf("got %q", got)
	}
	chunk := make([]byte, 64<<10)
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/204" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		for i := 0; i < 64; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	defer page.Close()
	proxy := connectProxy()
	defer proxy.Close()
	port := proxy.Listener.Addr().(*net.TCPAddr).Port
	configuration := fmt.Sprintf("mode: rule\nlog-level: silent\nproxies:\n  - {name: up, type: http, server: 127.0.0.1, port: %d}\nproxy-groups:\n  - {name: Line, type: fallback, proxies: [up], url: '%s/204', interval: 300}\nrules:\n  - MATCH,Line\n", port, page.URL)
	if err := start(t.TempDir(), configuration); err != nil {
		t.Fatal(err)
	}
	defer Stop()
	input, _ := json.Marshal(map[string]any{"group": "Line", "pingUrl": page.URL + "/204", "url": page.URL + "/big", "seconds": 1})
	if got := SpeedStart(string(input)); got != "ok" {
		t.Fatalf("got %q", got)
	}
	var status SpeedStatus
	for i := 0; i < 100; i++ {
		_ = json.Unmarshal([]byte(SpeedProgress()), &status)
		if status.State == "done" || status.State == "failed" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if status.State != "done" || status.Bytes <= 0 || status.Mbps <= 0 || status.Latency < 0 || status.Line != "up" {
		t.Fatalf("got %+v", status)
	}
}
