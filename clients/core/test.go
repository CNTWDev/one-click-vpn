package core

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/metacubex/mihomo/adapter"
	"github.com/metacubex/mihomo/common/utils"
)

// testWorkers bounds how many transports are dialled at once, so a long node list does not open
// hundreds of sockets together (and a phone stays responsive while the list is measured).
const testWorkers = 16

type testInput struct {
	Nodes     map[string][]map[string]any `json:"nodes"`
	URL       string                      `json:"url"`
	TimeoutMs int                         `json:"timeoutMs"`
}

// Test measures nodes the way connecting would use them, as Clash apps do: an HTTP request to url through
// every transport the node offers (Hysteria2, REALITY, XHTTP), all at once; the fastest answer counts. A TCP
// port that answers says nothing about a transport that is blocked after the handshake, and a node reached
// only over UDP has no TCP port to answer, so this is the measurement the apps show and rank by.
//
// input is {"nodes":{"<node id>":[<mihomo proxy>,...]},"url":"...","timeoutMs":5000}. It needs no running core:
// each transport is built on its own and dials directly (the apps are outside their own tunnel). The reply is
// {"<node id>":<milliseconds or -1>}, or {} when input cannot be read.
func Test(input string) string {
	var request testInput
	if err := json.Unmarshal([]byte(input), &request); err != nil || request.URL == "" {
		return "{}"
	}
	adapter.UnifiedDelay.Store(true) // the apps' configuration (config.go) sets the same
	timeout := time.Duration(request.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	results := make(map[string]int, len(request.Nodes))
	var mutex sync.Mutex
	var wait sync.WaitGroup
	slots := make(chan struct{}, testWorkers)
	for id, proxies := range request.Nodes {
		mutex.Lock()
		results[id] = -1
		mutex.Unlock()
		for _, mapping := range proxies {
			wait.Add(1)
			go func(id string, mapping map[string]any) {
				defer wait.Done()
				slots <- struct{}{}
				defer func() { <-slots }()
				delay := testOne(mapping, request.URL, timeout)
				if delay < 0 {
					return
				}
				mutex.Lock()
				if best := results[id]; best < 0 || delay < best {
					results[id] = delay
				}
				mutex.Unlock()
			}(id, mapping)
		}
	}
	wait.Wait()
	reply, _ := json.Marshal(results)
	return string(reply)
}

// testOne is one transport's delay in milliseconds, or -1. Unified delay (as the apps' own configuration sets)
// times a second request on the opened connection, so the figure is the round trip and not the handshake.
func testOne(mapping map[string]any, url string, timeout time.Duration) int {
	proxy, err := adapter.ParseProxy(mapping)
	if err != nil {
		return -1
	}
	defer func() { _ = proxy.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	delay, err := proxy.URLTest(ctx, url, utils.IntRanges[uint16]{})
	if err != nil {
		return -1
	}
	return int(delay)
}
