package core

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/metacubex/mihomo/tunnel/statistic"
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

// tunnelConn opens a connection to port through the core's HTTP inbound, as an app in the tun would.
func tunnelConn(t *testing.T, inbound int, port int) net.Conn {
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", inbound))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_, _ = fmt.Fprintf(conn, "CONNECT 127.0.0.1:%d HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n", port, port)
	reply := make([]byte, 39)
	if _, err := io.ReadFull(conn, reply); err != nil || !strings.Contains(string(reply), " 200 ") {
		t.Fatalf("connect through the core: %q %v", reply, err)
	}
	return conn
}

func openConnections() int {
	n := 0
	statistic.DefaultManager.Range(func(statistic.Tracker) bool { n++; return true })
	return n
}

// An upload through the tunnel (bytes going out, none back yet) is not a stall, and when the watchdog closes what
// hangs, direct connections (a WeChat photo upload in smart routing) keep going.
func TestUploadIsNotStalledAndDirectSurvivesReset(t *testing.T) {
	age, quiet := stallAge, stallQuiet
	stallAge, stallQuiet = 300*time.Millisecond, 300*time.Millisecond
	defer func() { stallAge, stallQuiet = age, quiet }()
	proxy := connectProxy()
	defer proxy.Close()
	sink, mainland := hangingListener(t), hangingListener(t)
	free, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	inbound := free.Addr().(*net.TCPAddr).Port
	_ = free.Close()
	configuration := fmt.Sprintf("mode: rule\nlog-level: silent\nbind-address: 127.0.0.1\nmixed-port: %d\nproxies:\n  - {name: up, type: http, server: 127.0.0.1, port: %d}\nproxy-groups:\n  - {name: Line, type: fallback, proxies: [up], url: 'http://127.0.0.1:%d/', interval: 300, lazy: true}\nrules:\n  - DST-PORT,%d,DIRECT\n  - MATCH,Line\n",
		inbound, proxy.Listener.Addr().(*net.TCPAddr).Port, sink, mainland)
	if err := start(t.TempDir(), configuration); err != nil {
		t.Fatal(err)
	}
	defer Stop()
	resetWatch()
	uploads := []net.Conn{tunnelConn(t, inbound, sink), tunnelConn(t, inbound, sink)}
	direct := tunnelConn(t, inbound, mainland)
	chunk := make([]byte, 16<<10)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, conn := range append(uploads, direct) {
			_, _ = conn.Write(chunk)
		}
		if got := Health("Line"); got != "ok" {
			t.Fatalf("uploads counted as a stall: %q", got)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// The uploads stop: now they hang with nothing back.
	time.Sleep(400 * time.Millisecond)
	_ = Health("Line")
	if got := Health("Line"); !strings.HasPrefix(got, "stalled 2") {
		t.Fatalf("hanging connections not noticed: %q", got)
	}
	if n := openConnections(); n != 3 {
		t.Fatalf("%d connections before the reset", n)
	}
	ResetTunnel()
	time.Sleep(100 * time.Millisecond)
	if n := openConnections(); n != 1 {
		t.Fatalf("%d connections after closing the tunnel's, want only the direct one", n)
	}
	if _, err := direct.Write(chunk); err != nil {
		t.Fatalf("direct connection closed: %v", err)
	}
	Reset()
	time.Sleep(100 * time.Millisecond)
	if n := openConnections(); n != 0 {
		t.Fatalf("%d connections after a network change reset", n)
	}
}
