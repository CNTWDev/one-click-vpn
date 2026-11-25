package core

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Check downloads through a line, CheckEach tells the working line from a hanging one, and a suspended line
// leaves the group and stops answering probes.
func TestCheckAndSuspend(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(make([]byte, 65536)) }))
	defer page.Close()
	proxy := connectProxy()
	defer proxy.Close()
	up, slow := proxy.Listener.Addr().(*net.TCPAddr).Port, hangingListener(t)
	configuration := fmt.Sprintf("mode: rule\nlog-level: silent\nproxies:\n  - {name: up, type: http, server: 127.0.0.1, port: %d}\n  - {name: up2, type: http, server: 127.0.0.1, port: %d}\n  - {name: slow, type: http, server: 127.0.0.1, port: %d}\nproxy-groups:\n  - {name: Line, type: fallback, proxies: [up, up2, slow], url: '%s/204', interval: 300, lazy: true}\nrules:\n  - MATCH,Line\n", up, up, slow, page.URL)
	if err := start(t.TempDir(), configuration); err != nil {
		t.Fatal(err)
	}
	defer Stop()
	if got := Check("Line", page.URL, 3000, false); !strings.HasPrefix(got, "dns=0,web=") || strings.HasSuffix(got, "=-1") {
		t.Fatalf("check through the group: %q", got)
	}
	got := CheckEach("up,slow", page.URL, 1500)
	if !strings.HasPrefix(got, "up=") || strings.HasPrefix(got, "up=-1") || !strings.HasSuffix(got, "slow=-1") {
		t.Fatalf("check each: %q", got)
	}
	if now := Now("Line"); now != "up" {
		t.Fatalf("group uses %q before the suspension", now)
	}
	Suspend("Line", "up", 60)
	if now := Now("Line"); now != "up2" {
		t.Fatalf("group uses %q after suspending up", now)
	}
	if got := Probe("up", page.URL, 1000); got != "up=-1" {
		t.Fatalf("a suspended line answers probes: %q", got)
	}
	if got := Health("Line"); got != "ok" {
		t.Fatalf("health with no traffic: %q", got)
	}
}
