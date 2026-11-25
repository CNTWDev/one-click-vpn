package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/metacubex/http"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/component/ca"
	"github.com/metacubex/mihomo/component/resolver"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/metacubex/mihomo/tunnel/statistic"
	"github.com/miekg/dns"
)

// The watchdog notices a tunnel that says it is connected while nothing comes back through it: the lines the apps
// probe answer a small test page on a fresh connection, yet the user's traffic (the DNS lookups the core sends
// through the tunnel, long-lived connections, real downloads) hangs. The apps ask Health on every tick (it only
// reads the open connections, so an idle device costs nothing), then Check the path the user's traffic takes,
// and Suspend the lines that fail it so the fallback group moves on.

const (
	// stallAge: a TCP connection through the tunnel that got not a single byte back for this long is stuck
	// (a TLS server answers in one round trip).
	stallAge = 6 * time.Second
	// stallQuiet: and nothing at all came back through the tunnel for this long.
	stallQuiet = 10 * time.Second
	// stallCount: at least this many stuck connections, so one slow site does not count.
	stallCount = 2
)

type watchState struct {
	sync.Mutex
	down      map[string]int64
	lastRx    time.Time
	suspended map[string]time.Time
}

var watch = &watchState{down: map[string]int64{}, suspended: map[string]time.Time{}}

// resetWatch starts a new connection's watch: called by Run (the lines' suspensions belong to a node).
func resetWatch() {
	watch.Lock()
	defer watch.Unlock()
	watch.down = map[string]int64{}
	watch.lastRx = time.Now()
	watch.suspended = map[string]time.Time{}
}

// Health reads the open connections through the tunnel: "stalled <n>" when n TCP connections have waited at
// least stallAge without a byte back and nothing came back through the tunnel for stallQuiet, else "ok". group
// is the apps' fallback group, whose suspended lines are kept out of use until their time is up.
func Health(group string) string {
	now := time.Now()
	watch.Lock()
	defer watch.Unlock()
	stuck := 0
	live := map[string]bool{}
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		info := c.Info()
		if direct(info) {
			return true
		}
		id := c.ID()
		live[id] = true
		down := info.DownloadTotal.Load()
		if last, ok := watch.down[id]; !ok || down > last {
			if down > 0 {
				watch.lastRx = now
			}
			watch.down[id] = down
		}
		if info.Metadata != nil && info.Metadata.NetWork == C.TCP && down == 0 && now.Sub(info.Start) >= stallAge {
			stuck++
		}
		return true
	})
	for id := range watch.down {
		if !live[id] {
			delete(watch.down, id)
		}
	}
	keepSuspended(group, now)
	if stuck >= stallCount && now.Sub(watch.lastRx) >= stallQuiet {
		return fmt.Sprintf("stalled %d", stuck)
	}
	return "ok"
}

// keepSuspended marks each suspended line dead again (the group's own health check or a probe may have found it
// answering a test page) and forgets suspensions whose time is up. Called with the watch lock held.
func keepSuspended(group string, now time.Time) {
	if len(watch.suspended) == 0 {
		return
	}
	testURL := groupURL(group)
	proxies := tunnel.Proxies()
	for name, until := range watch.suspended {
		if now.After(until) {
			delete(watch.suspended, name)
			continue
		}
		if proxy, ok := proxies[name]; ok && testURL != "" && proxy.AliveForTestUrl(testURL) {
			markDead(proxy, testURL)
		}
	}
}

// markDead records a failed test of url on proxy, which is what a fallback group reads: a test with a context
// that is already over fails without sending anything.
func markDead(proxy C.Proxy, testURL string) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _ = proxy.URLTest(ctx, testURL, utils.IntRanges[uint16]{})
}

// groupURL is the test URL a group checks its lines with (config.go sets testURL); "" when there is no group.
func groupURL(group string) string {
	g, ok := groupOf(group)
	if !ok {
		return ""
	}
	var fields struct {
		TestURL string `json:"testUrl"`
	}
	if data, err := g.MarshalJSON(); err == nil && json.Unmarshal(data, &fields) == nil && fields.TestURL != "" {
		return fields.TestURL
	}
	return testURL
}

// Suspend keeps the named lines (comma-separated) out of the group for seconds: they answered a probe but not
// the user's traffic. Probe and ProbeFirst report them as not answering meanwhile.
func Suspend(group string, names string, seconds int) {
	watch.Lock()
	defer watch.Unlock()
	until := time.Now().Add(time.Duration(seconds) * time.Second)
	for _, name := range strings.Split(names, ",") {
		if name = strings.TrimSpace(name); name != "" {
			watch.suspended[name] = until
		}
	}
	keepSuspended(group, time.Now())
}

// suspended tells Probe and ProbeFirst to skip a line.
func suspended(name string) bool {
	watch.Lock()
	defer watch.Unlock()
	until, ok := watch.suspended[name]
	return ok && time.Now().Before(until)
}

// Check tests the path the user's traffic takes, unlike Probe: a lookup of a name no cache holds through the
// core's own resolver (the tunnel's DNS), then a download of url through via (the apps' group, or one line).
// It returns "dns=ms,web=ms" (-1: failed); dns is 0 when skipped (via is a single line: DNS goes through the group).
func Check(via string, checkURL string, timeoutMs int, lookup bool) string {
	timeout := time.Duration(timeoutMs) * time.Millisecond
	dnsMs := 0
	if lookup {
		dnsMs = checkDNS(timeout)
	}
	return fmt.Sprintf("dns=%d,web=%d", dnsMs, fetchThrough(via, checkURL, timeout))
}

// CheckEach downloads url through each named line at once: "name=ms" pairs (-1: failed), in the order given.
func CheckEach(names string, checkURL string, timeoutMs int) string {
	list := strings.Split(names, ",")
	results := make([]string, len(list))
	var wait sync.WaitGroup
	for i, name := range list {
		wait.Add(1)
		go func(i int, name string) {
			defer wait.Done()
			results[i] = name + "=" + strconv.Itoa(fetchThrough(name, checkURL, time.Duration(timeoutMs)*time.Millisecond))
		}(i, name)
	}
	wait.Wait()
	return strings.Join(results, ",")
}

func checkDNS(timeout time.Duration) int {
	if resolver.DefaultResolver == nil {
		return 0
	}
	label := make([]byte, 6)
	_, _ = rand.Read(label)
	msg := dns.Msg{}
	// A random name: an answer (NXDOMAIN counts) must come from the resolver, not from its cache.
	msg.SetQuestion(dns.Fqdn("tn-"+hex.EncodeToString(label)+".gstatic.com"), dns.TypeA)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	started := time.Now()
	if _, err := resolver.DefaultResolver.ExchangeContext(ctx, &msg); err != nil {
		return -1
	}
	return max(1, int(time.Since(started).Milliseconds()))
}

// fetchThrough fetches checkURL through the named proxy or group and reads the whole body (bounded): -1 when the
// request, the status or the body fails within timeout.
func fetchThrough(via string, checkURL string, timeout time.Duration) int {
	proxy, ok := tunnel.Proxies()[via]
	if !ok {
		return -1
	}
	target, err := url.Parse(checkURL)
	if err != nil {
		return -1
	}
	port := target.Port()
	if port == "" {
		port = "80"
		if target.Scheme == "https" {
			port = "443"
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	tlsConfig, err := ca.GetTLSConfig(ca.Option{})
	if err != nil {
		return -1
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			metadata := &C.Metadata{NetWork: C.TCP, Host: target.Hostname()}
			if parsed, err := strconv.ParseUint(port, 10, 16); err == nil {
				metadata.DstPort = uint16(parsed)
			}
			return proxy.DialContext(ctx, metadata)
		},
		TLSClientConfig:   tlsConfig,
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, checkURL, nil)
	if err != nil {
		return -1
	}
	started := time.Now()
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		return -1
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return -1
	}
	if _, err := io.Copy(io.Discard, io.LimitReader(response.Body, 4<<20)); err != nil {
		return -1
	}
	return max(1, int(time.Since(started).Milliseconds()))
}
