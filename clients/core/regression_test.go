package core

import (
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/metacubex/mihomo/config"
)

// TestRegressionSubscription is the release gate that needs no device (.github/workflows/device-regression.yml):
// it imports the regression account's Clash subscription the way a Clash / mihomo app does, then sends a request
// through every line of every node. It runs only when VEILBIRD_REGRESSION_SUBSCRIPTION (the account's subscription
// URL) is set. VEILBIRD_REGRESSION_NODE names the test node (part of its name): every one of its lines must work,
// since the test node is not blocked anywhere. Other nodes only need one working line each.
func TestRegressionSubscription(t *testing.T) {
	url := os.Getenv("VEILBIRD_REGRESSION_SUBSCRIPTION")
	if url == "" {
		t.Skip("VEILBIRD_REGRESSION_SUBSCRIPTION not set")
	}
	request, _ := http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("User-Agent", "clash.meta/regression")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("download subscription: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("download subscription: HTTP %d", response.StatusCode)
	}
	// The whole file must load as a mihomo configuration: groups, rules and proxies, as an app imports it.
	if _, err := config.Parse(body); err != nil {
		t.Fatalf("subscription does not load in mihomo: %v", err)
	}
	raw, err := config.UnmarshalRawConfig(body)
	if err != nil || len(raw.Proxy) == 0 {
		t.Fatalf("subscription has no proxies: %v", err)
	}
	testNode := os.Getenv("VEILBIRD_REGRESSION_NODE")
	nodes := map[string][]map[string]any{}
	for _, proxy := range raw.Proxy {
		name, _ := proxy["name"].(string)
		node := name
		if index := strings.Index(name, " · "); index > 0 {
			node = name[:index]
		}
		nodes[node] = append(nodes[node], proxy)
	}
	const probe = "https://www.gstatic.com/generate_204"
	sawTestNode := false
	for node, lines := range nodes {
		working := 0
		for _, line := range lines {
			name, _ := line["name"].(string)
			kind, _ := line["type"].(string)
			delay := testOne(line, probe, 10*time.Second)
			t.Logf("%s (%s): %d ms", name, kind, delay)
			if delay >= 0 {
				working++
			} else if testNode != "" && strings.Contains(node, testNode) {
				t.Errorf("test node line %s (%s) does not work", name, kind)
			}
		}
		if testNode != "" && strings.Contains(node, testNode) {
			sawTestNode = true
		}
		if working == 0 {
			t.Errorf("node %s: none of its %d lines works", node, len(lines))
		}
	}
	if testNode != "" && !sawTestNode {
		t.Errorf("test node %q is not in the subscription", testNode)
	}
}
