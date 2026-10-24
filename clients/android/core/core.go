// Package core embeds mihomo for the TrackNothing Android app (built with gomobile bind).
//
// The app owns the VpnService and hands the tun file descriptor to mihomo through the
// configuration (tun.file-descriptor). The app excludes itself from its own VPN, so the
// connections mihomo opens to nodes leave through the underlying network.
package core

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

// idle replaces a running configuration on Stop: no tun, no listeners, no proxies.
const idle = "mode: direct\nlog-level: silent\nipv6: false\n"

// Start applies a mihomo configuration (YAML or JSON) with home as its data directory.
func Start(home string, configuration string) error {
	lock.Lock()
	defer lock.Unlock()
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	C.SetHomeDir(home)
	C.SetConfig(filepath.Join(home, "config.yaml"))
	cfg, err := config.Parse([]byte(configuration))
	if err != nil {
		return err
	}
	executor.ApplyConfig(cfg, true)
	running = true
	return nil
}

// Stop closes the tun and every open connection, then drops all proxies.
func Stop() {
	lock.Lock()
	defer lock.Unlock()
	if !running {
		return
	}
	running = false
	executor.Shutdown()
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		_ = c.Close()
		return true
	})
	if cfg, err := config.Parse([]byte(idle)); err == nil {
		executor.ApplyConfig(cfg, true)
	}
	statistic.DefaultManager.ResetStatistic()
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
			if proxy, ok := proxies[name]; ok {
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
