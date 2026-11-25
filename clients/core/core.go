// Package core embeds mihomo for the TrackNothing apps: gomobile bind for Android and Apple, and
// cmd/veilbird-core for Windows. Run builds the shared configuration (config.go) and applies it.
//
// On the phones the app owns the tun and hands its file descriptor to mihomo through the
// configuration (tun.file-descriptor). The app excludes itself from its own VPN, so the
// connections mihomo opens to nodes leave through the underlying network.
package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/metacubex/mihomo/adapter/outboundgroup"
	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/config"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/metacubex/mihomo/tunnel/statistic"
)

// mihomo's own log is not exported: its lines name the sites a device visits. The app keeps a
// journal of its own steps instead.
var (
	lock    sync.Mutex
	running bool
)

func init() {
	// iOS gives a packet tunnel extension about 50 MB: keep the Go heap well below it.
	if runtime.GOOS == "ios" {
		debug.SetMemoryLimit(32 << 20)
		debug.SetGCPercent(50)
	}
}

// idle replaces a running configuration on Stop: no tun, no listeners, no proxies.
const idle = "mode: direct\nlog-level: silent\nipv6: false\n"

// start applies a mihomo configuration (YAML or JSON) with home as its data directory.
func start(home string, configuration string) error {
	lock.Lock()
	defer lock.Unlock()
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	C.SetHomeDir(home)
	C.SetConfig(filepath.Join(home, "config.yaml"))
	cfg, err := config.Parse(normalize([]byte(configuration)))
	if err != nil {
		return err
	}
	executor.ApplyConfig(cfg, true)
	running = true
	resetWatch()
	appUsage.begin(home)
	startActivity()
	return nil
}

// normalize re-encodes a JSON configuration the way YAML can read it. The apps build JSON
// (valid YAML), but Android's org.json and Apple's JSONSerialization write "/" as "\/", an
// escape YAML rejects ("found unknown escape character"); Go's encoder never writes it.
func normalize(configuration []byte) []byte {
	trimmed := bytes.TrimSpace(configuration)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return configuration
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return configuration
	}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(value) != nil {
		return configuration
	}
	return out.Bytes()
}

// Stop closes the tun and every open connection, then drops all proxies.
func Stop() {
	lock.Lock()
	defer lock.Unlock()
	if !running {
		return
	}
	running = false
	stopActivity()
	appUsage.flush()
	executor.Shutdown()
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		_ = c.Close()
		return true
	})
	if cfg, err := config.Parse([]byte(idle)); err == nil {
		executor.ApplyConfig(cfg, true)
	}
	statistic.DefaultManager.ResetStatistic()
	// The desktop apps keep the core running between connections (it also carries API calls): hand the
	// connection's buffers back to the system instead of holding the peak until the next one.
	go debug.FreeOSMemory()
}

// Reset closes every open connection but keeps the tunnel and proxies. The apps call it when the device's
// network changes (Wi-Fi <-> mobile data): connections bound to the old network would otherwise hang until
// they time out, while new ones leave through the new network right away.
func Reset() {
	lock.Lock()
	defer lock.Unlock()
	if !running {
		return
	}
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		_ = c.Close()
		return true
	})
}

// Probe tests the named proxies concurrently through url and returns
// "name=delayMs" pairs separated by commas; -1 means the proxy did not answer.
// The results also feed the health state that fallback groups choose from.
func Probe(names string, url string, timeoutMs int) string {
	proxies := tunnel.Proxies()
	list := strings.Split(names, ",")
	results := make([]string, len(list))
	var wait sync.WaitGroup
	for i, name := range list {
		wait.Add(1)
		go func(i int, name string) {
			defer wait.Done()
			delay := -1
			// A line the watchdog suspended answers test pages but not the user's traffic.
			if proxy, ok := proxies[name]; ok && !suspended(name) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
				defer cancel()
				if value, err := proxy.URLTest(ctx, url, utils.IntRanges[uint16]{}); err == nil {
					delay = int(value)
				}
			}
			results[i] = fmt.Sprintf("%s=%d", name, delay)
		}(i, name)
	}
	wait.Wait()
	return strings.Join(results, ",")
}

// settle is how long ProbeFirst waits, after a later transport answered, for the ones before it in the ladder.
const settle = 1000 * time.Millisecond

// ProbeFirst is Probe for connecting: it tests the named proxies (ladder order) concurrently through url and
// returns as soon as the traffic has a transport, instead of waiting for the slowest one (a transport blocked on
// this network, or WireGuard before the node has applied the device, would hold every connect for the whole
// timeout). It returns when the first transport in order that has not failed answers; when only a later one has
// answered, it waits up to settle for the earlier ones and then pins group to the one that answered, since
// fallback would otherwise send traffic to an earlier, untested transport. The pin is lifted once every probe
// has finished, so the group then follows the ladder and the results. The reply lists the finished probes as
// "name=delayMs" (-1: no answer); probes still running are left out. "" means none of the names exist.
func ProbeFirst(names string, group string, url string, timeoutMs int) string {
	proxies := tunnel.Proxies()
	type answer struct {
		index int
		delay int
	}
	list := strings.Split(names, ",")
	answers := make(chan answer, len(list))
	for i, name := range list {
		go func(i int, name string) {
			delay := -1
			// A line the watchdog suspended answers test pages but not the user's traffic.
			if proxy, ok := proxies[name]; ok && !suspended(name) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
				defer cancel()
				if value, err := proxy.URLTest(ctx, url, utils.IntRanges[uint16]{}); err == nil {
					delay = int(value)
				}
			}
			answers <- answer{i, delay}
		}(i, name)
	}
	delays := make([]int, len(list))
	done := make([]bool, len(list))
	for i := range delays {
		delays[i] = -1
	}
	// best is the earliest transport in order that answered; ready once every transport before it failed.
	best := func() (int, bool) {
		for i := range list {
			if !done[i] {
				return -1, false
			}
			if delays[i] >= 0 {
				return i, true
			}
		}
		return -1, true
	}
	var deadline <-chan time.Time
	received := 0
	pinned := ""
wait:
	for received < len(list) {
		select {
		case a := <-answers:
			received++
			done[a.index], delays[a.index] = true, a.delay
			if _, ready := best(); ready {
				break wait
			}
			if a.delay >= 0 && deadline == nil {
				deadline = time.After(settle)
			}
		case <-deadline:
			for i := range list {
				if done[i] && delays[i] >= 0 {
					pinned = list[i]
					break
				}
			}
			break wait
		}
	}
	if pinned != "" {
		if g, ok := groupOf(group); ok {
			if setter, ok := g.(interface{ ForceSet(string) }); ok {
				setter.ForceSet(pinned)
				go func(left int) {
					for ; left > 0; left-- {
						<-answers
					}
					// Unpin unless the configuration (and so the group) was replaced meanwhile; the lock keeps
					// start and Stop from swapping the proxies while they are read.
					lock.Lock()
					defer lock.Unlock()
					if current, ok := groupOf(group); ok && running && current == g {
						setter.ForceSet("")
					}
				}(len(list) - received)
			}
		}
	}
	var results []string
	for i, name := range list {
		if done[i] {
			results = append(results, fmt.Sprintf("%s=%d", name, delays[i]))
		}
	}
	return strings.Join(results, ",")
}

func groupOf(name string) (outboundgroup.ProxyGroup, bool) {
	proxy, ok := tunnel.Proxies()[name]
	if !ok {
		return nil, false
	}
	g, ok := proxy.Adapter().(outboundgroup.ProxyGroup)
	return g, ok
}

// Now returns the proxy a group currently uses, or "" when the group does not exist.
func Now(group string) string {
	proxy, ok := tunnel.Proxies()[group]
	if !ok {
		return ""
	}
	if g, ok := proxy.Adapter().(outboundgroup.ProxyGroup); ok {
		return g.Now()
	}
	return ""
}

// Rate returns the current "upload download" speed in bytes per second.
func Rate() string {
	up, down := statistic.DefaultManager.Now()
	return fmt.Sprintf("%d %d", up, down)
}

// Total returns the "upload download" bytes since Start.
func Total() string {
	up, down := statistic.DefaultManager.Total()
	return fmt.Sprintf("%d %d", up, down)
}

// Reach times a TCP connect to address (host:port, or several separated by commas) outside the tunnel,
// through the core's DIRECT outbound (bound to the physical network). Several addresses are tried at once and
// the first answer counts, so a node still answers on a network that blocks one of its ports. It returns
// milliseconds, or -1 when nothing answered. The connection check uses it for the leg from this device to the node.
func Reach(address string, timeoutMs int) int {
	direct, ok := tunnel.Proxies()["DIRECT"]
	if !ok {
		return -1
	}
	var targets []*C.Metadata
	for _, item := range strings.Split(address, ",") {
		metadata := &C.Metadata{NetWork: C.TCP}
		if item = strings.TrimSpace(item); item != "" && metadata.SetRemoteAddress(item) == nil {
			targets = append(targets, metadata)
		}
	}
	if len(targets) == 0 {
		return -1
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	started := time.Now()
	answers := make(chan int, len(targets))
	for _, metadata := range targets {
		go func(metadata *C.Metadata) {
			conn, err := direct.DialContext(ctx, metadata)
			if err != nil {
				answers <- -1
				return
			}
			elapsed := int(time.Since(started).Milliseconds())
			_ = conn.Close()
			answers <- elapsed
		}(metadata)
	}
	for range targets {
		if elapsed := <-answers; elapsed >= 0 {
			return elapsed
		}
	}
	return -1
}
