package core

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/metacubex/mihomo/adapter/outboundgroup"
	"github.com/metacubex/mihomo/common/utils"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel"
)

// The connection check's speed test ("测网速"): latency and jitter from a few small requests, then a download of
// a few seconds, all through the transport carrying traffic now, so it measures exactly what the user gets. It
// runs only while connected and only on the current connection, never across every node, to spare data.
// One test runs at a time; the apps poll SpeedProgress for the bar and the figures.

// SpeedRequest names what to measure: the proxy group the tunnel uses, a small page for latency, a large file
// to download and for how long.
type SpeedRequest struct {
	Group   string `json:"group"`
	PingURL string `json:"pingUrl"`
	URL     string `json:"url"`
	Seconds int    `json:"seconds"`
}

// SpeedStatus: State is idle, ping, download, done or failed. Mbps is the average so far (megabits per second),
// Bytes what was downloaded, Line the transport the group used (for the hidden log). Error, when failed:
// "not connected", "no answer" or "download".
type SpeedStatus struct {
	State     string  `json:"state"`
	Mbps      float64 `json:"mbps"`
	Bytes     int64   `json:"bytes"`
	ElapsedMs int64   `json:"elapsedMs"`
	Seconds   int     `json:"seconds"`
	Latency   int     `json:"latency"`
	Jitter    int     `json:"jitter"`
	Line      string  `json:"line,omitempty"`
	Error     string  `json:"error,omitempty"`
}

const (
	speedStreams = 4
	speedPings   = 5
	speedMaxSecs = 10
)

var speed struct {
	sync.Mutex
	status  SpeedStatus
	cancel  context.CancelFunc
	bytes   atomic.Int64
	started time.Time
}

// SpeedStart begins a speed test from a JSON SpeedRequest; "ok", or "error <reason>" when it cannot start.
func SpeedStart(input string) string {
	var request SpeedRequest
	if err := json.Unmarshal([]byte(input), &request); err != nil || request.URL == "" || request.PingURL == "" || request.Group == "" {
		return "error invalid"
	}
	if request.Seconds <= 0 || request.Seconds > speedMaxSecs {
		request.Seconds = 6
	}
	proxy, ok := tunnel.Proxies()[request.Group]
	if !ok {
		return "error not connected"
	}
	speed.Lock()
	defer speed.Unlock()
	if speed.cancel != nil {
		speed.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	speed.cancel = cancel
	speed.bytes.Store(0)
	speed.status = SpeedStatus{State: "ping", Seconds: request.Seconds, Latency: -1, Jitter: -1, Line: lineOf(proxy)}
	go runSpeed(ctx, proxy, request)
	return "ok"
}

// SpeedProgress is the running or last test's status as JSON.
func SpeedProgress() string {
	speed.Lock()
	status := speed.status
	if status.State == "" {
		status.State = "idle"
	}
	if status.State == "download" {
		status.Bytes = speed.bytes.Load()
		status.ElapsedMs = time.Since(speed.started).Milliseconds()
		status.Mbps = mbps(status.Bytes, status.ElapsedMs)
	}
	speed.Unlock()
	reply, _ := json.Marshal(status)
	return string(reply)
}

// SpeedStop ends a running test; its figures so far stay as the result.
func SpeedStop() {
	speed.Lock()
	defer speed.Unlock()
	if speed.cancel != nil {
		speed.cancel()
	}
}

func lineOf(proxy C.Proxy) string {
	if group, ok := proxy.Adapter().(outboundgroup.ProxyGroup); ok {
		return group.Now()
	}
	return proxy.Name()
}

func mbps(bytes, elapsedMs int64) float64 {
	if elapsedMs <= 0 {
		return 0
	}
	return float64(bytes) * 8 / float64(elapsedMs) / 1000
}

func finishSpeed(update func(*SpeedStatus)) {
	speed.Lock()
	update(&speed.status)
	speed.Unlock()
}

func runSpeed(ctx context.Context, proxy C.Proxy, request SpeedRequest) {
	// Latency: the median of a few requests on the opened connection (unified delay), jitter the mean step.
	var samples []int
	for i := 0; i < speedPings && ctx.Err() == nil; i++ {
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		delay, err := proxy.URLTest(pingCtx, request.PingURL, utils.IntRanges[uint16]{})
		cancel()
		if err == nil {
			samples = append(samples, int(delay))
		}
	}
	if len(samples) == 0 {
		finishSpeed(func(s *SpeedStatus) { s.State, s.Error = "failed", "no answer" })
		return
	}
	jitter := 0
	for i := 1; i < len(samples); i++ {
		step := samples[i] - samples[i-1]
		if step < 0 {
			step = -step
		}
		jitter += step
	}
	if len(samples) > 1 {
		jitter /= len(samples) - 1
	}
	sorted := append([]int(nil), samples...)
	sort.Ints(sorted)
	speed.Lock()
	speed.status.Latency, speed.status.Jitter, speed.status.Line = sorted[len(sorted)/2], jitter, lineOf(proxy)
	speed.status.State = "download"
	speed.started = time.Now()
	speed.Unlock()

	// Download: a few parallel streams for the set time, each re-requesting the file when it ends.
	download, cancel := context.WithTimeout(ctx, time.Duration(request.Seconds)*time.Second)
	defer cancel()
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			metadata := &C.Metadata{NetWork: C.TCP}
			if err := metadata.SetRemoteAddress(address); err != nil {
				return nil, err
			}
			return proxy.DialContext(ctx, metadata)
		},
		ForceAttemptHTTP2:   false,
		TLSHandshakeTimeout: 10 * time.Second,
	}}
	defer client.CloseIdleConnections()
	var failures atomic.Int32
	var wait sync.WaitGroup
	for i := 0; i < speedStreams; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			buffer := make([]byte, 32<<10)
			for download.Err() == nil {
				if err := fetchInto(download, client, request.URL, buffer); err != nil && download.Err() == nil {
					failures.Add(1)
					return
				}
			}
		}()
	}
	wait.Wait()
	elapsed := time.Since(speed.started).Milliseconds()
	received := speed.bytes.Load()
	finishSpeed(func(s *SpeedStatus) {
		s.Bytes, s.ElapsedMs, s.Mbps = received, elapsed, mbps(received, elapsed)
		if received == 0 && failures.Load() > 0 {
			s.State, s.Error = "failed", "download"
		} else {
			s.State = "done"
		}
	})
}

func fetchInto(ctx context.Context, client *http.Client, url string, buffer []byte) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New(response.Status)
	}
	for {
		n, err := response.Body.Read(buffer)
		speed.bytes.Add(int64(n))
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
