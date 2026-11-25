package core

import (
	"testing"

	"github.com/metacubex/mihomo/tunnel"
)

// The person's rules change while connected: the running configuration takes them at once.
func TestSetRulesWhileRunning(t *testing.T) {
	if err := SetRules(`["example.com, direct"]`); err == nil {
		t.Fatal("SetRules before a connection should fail")
	}
	home := t.TempDir()
	if err := start(home, "mode: rule\nlog-level: silent\nrules:\n  - MATCH,DIRECT\n"); err != nil {
		t.Fatal(err)
	}
	defer Stop()
	proxies := []map[string]any{{"name": "reality", "type": "vless", "server": "1.2.3.4", "port": 443, "uuid": "c7a5b0f4-1d2e-4c3b-9a8f-0e1d2c3b4a59"}}
	// "only" leaves out the AI rule set, which this bare configuration does not load.
	rememberRun(Options{Platform: "windows", Proxies: proxies, Order: []string{"reality"}, AppMode: "only", Apps: []string{"chrome.exe"}})
	if err := SetRules(`["example.com, direct", "DOMAIN,chat.example.org,proxy", "10.9.0.0/16, block"]`); err != nil {
		t.Fatal(err)
	}
	found := map[string]string{}
	for _, rule := range tunnel.Rules() {
		found[rule.RuleType().String()+","+rule.Payload()] = rule.Adapter()
	}
	if found["DomainSuffix,example.com"] != "DIRECT" || found["Domain,chat.example.org"] != "TrackNothing" || found["IPCIDR,10.9.0.0/16"] != "REJECT" {
		t.Fatalf("rules: %v", found)
	}
	for _, rule := range []string{"DOMAIN-SUFFIX,example.com", "DOMAIN,chat.example.org", "IP-CIDR,10.9.0.0/16"} {
		if !liveRun.mine[rule] {
			t.Fatalf("%s not marked mine: %v", rule, liveRun.mine)
		}
	}
	if CloseHost("example.com", true) != 0 {
		t.Fatal("no connections to close")
	}
}
