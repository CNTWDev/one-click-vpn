package core

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
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
	var reply map[string]int
	if err := json.Unmarshal([]byte(Test(string(input))), &reply); err != nil {
		t.Fatal(err)
	}
	if reply["n1"] != -1 {
		t.Fatalf("got %v", reply)
	}
}

// Through a working transport the node gets a delay: a local CONNECT proxy in front of a local page.
func TestTestReachableNode(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer page.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	defer proxy.Close()
	address := proxy.Listener.Addr().(*net.TCPAddr)
	input, _ := json.Marshal(map[string]any{"url": page.URL + "/generate_204", "timeoutMs": 3000, "nodes": map[string]any{
		"n1": []map[string]any{
			{"name": "down", "type": "http", "server": "127.0.0.1", "port": 1},
			{"name": "up", "type": "http", "server": "127.0.0.1", "port": address.Port},
		},
		"n2": []map[string]any{},
	}})
	var reply map[string]int
	if err := json.Unmarshal([]byte(Test(string(input))), &reply); err != nil {
		t.Fatal(err)
	}
	if reply["n1"] < 0 || reply["n2"] != -1 {
		t.Fatalf("got %v", reply)
	}
}
