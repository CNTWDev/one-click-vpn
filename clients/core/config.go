package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	P "github.com/metacubex/mihomo/constant/provider"
	"github.com/metacubex/mihomo/rules/provider"
)

// The one mihomo configuration every app runs, built here so Android, Apple and Windows cannot drift.
const (
	group    = "TrackNothing"
	testURL  = "https://www.gstatic.com/generate_204"
	ruleSets = "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo"
)

// The smart-routing rule sets: provider name, kind (geosite/geoip) and file name in meta-rules-dat, behavior.
var smartRuleSets = []struct{ provider, kind, name, behavior string }{
	{"private_domain", "geosite", "private", "domain"},
	{"cn_domain", "geosite", "cn", "domain"},
	{"cn_ip", "geoip", "cn", "ipcidr"},
}

func ruleSetPath(kind, name string) string { return "./rules/" + kind + "-" + name + ".mrs" }

var privateNetworks = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16"}

// Options is what an app knows about one connection: the node's proxies in fallback order, the
// routing mode and, on the phones, the tun the app already opened.
type Options struct {
	Platform string           `json:"platform"` // "android", "apple" or "windows"
	FD       int              `json:"fd"`       // tun file descriptor (Android, Apple)
	Smart    bool             `json:"smart"`    // mainland China sites go direct
	Proxies  []map[string]any `json:"proxies"`
	Order    []string         `json:"order"`
}

// Run builds the configuration from options (JSON) and applies it with home as the data directory.
func Run(home string, options string) error {
	var o Options
	if err := json.Unmarshal([]byte(options), &o); err != nil {
		return fmt.Errorf("options: %w", err)
	}
	configuration, err := Build(o)
	if err != nil {
		return err
	}
	if o.Smart {
		seedRuleSets(home)
	}
	return start(home, configuration)
}

// Build returns the mihomo configuration as JSON (valid YAML).
func Build(o Options) (string, error) {
	filter := []string{"+.lan", "+.local", "time.*.com", "+.ntp.org.cn"}
	var tun map[string]any
	rules := []string{}
	ipv6 := false
	findProcess := "off"
	switch o.Platform {
	case "android", "apple":
		// The app owns the tun and excludes itself from it, so mihomo neither routes nor binds.
		tun = map[string]any{"enable": true, "stack": "gvisor", "file-descriptor": o.FD, "auto-route": false,
			"auto-detect-interface": false, "dns-hijack": []string{"any:53"}, "mtu": 1500}
		if o.Platform == "apple" {
			filter = append(filter, "+.apple.com")
		} else {
			filter = append(filter, "localhost.ptlogin2.qq.com", "+.msftconnecttest.com", "+.msftncsi.com")
		}
	case "windows":
		// mihomo creates the adapter; strict-route keeps DNS and other traffic from leaking around it.
		tun = map[string]any{"enable": true, "device": "TrackNothing", "stack": "mixed", "auto-route": true, "strict-route": true,
			"auto-detect-interface": true, "dns-hijack": []string{"any:53"}, "mtu": 1500}
		filter = append(filter, "+.msftconnecttest.com", "+.msftncsi.com")
		// The app's own requests (API, latency tests) and the core's stay outside the tunnel, as on the phones.
		rules = append(rules, "PROCESS-NAME,Veilbird.exe,DIRECT")
		ipv6 = true
		findProcess = "strict"
	default:
		return "", fmt.Errorf("unknown platform %q", o.Platform)
	}
	if len(o.Proxies) == 0 || len(o.Order) == 0 {
		return "", fmt.Errorf("no proxies")
	}
	dns := map[string]any{"enable": true, "ipv6": false, "enhanced-mode": "fake-ip", "fake-ip-range": "198.18.0.1/16",
		"fake-ip-filter": filter, "respect-rules": true,
		"default-nameserver":      []string{"223.5.5.5", "119.29.29.29"},
		"nameserver":              []string{"https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"},
		"proxy-server-nameserver": []string{"https://doh.pub/dns-query", "223.5.5.5"}}
	for _, cidr := range privateNetworks {
		rules = append(rules, "IP-CIDR,"+cidr+",DIRECT,no-resolve")
	}
	config := map[string]any{"mode": "rule", "log-level": "silent", "ipv6": ipv6, "find-process-mode": findProcess,
		"unified-delay": true, "tcp-concurrent": true, "geo-auto-update": false,
		"profile": map[string]any{"store-selected": false, "store-fake-ip": false},
		"dns":     dns, "tun": tun, "proxies": o.Proxies,
		// lazy: the group's own health check runs only while it carries traffic; the apps probe on their own schedule,
		// so an idle phone or laptop is not woken every 5 minutes to test every transport.
		"proxy-groups": []map[string]any{{"name": group, "type": "fallback", "proxies": o.Order, "url": testURL, "interval": 300, "lazy": true}}}
	if o.Smart {
		// Same small rule sets as the subscription profiles (server/mihomo-config.mjs), fetched through the tunnel.
		providers := map[string]any{}
		for _, set := range smartRuleSets {
			providers[set.provider] = map[string]any{"type": "http", "behavior": set.behavior, "format": "mrs", "url": ruleSets + "/" + set.kind + "/" + set.name + ".mrs",
				"path": ruleSetPath(set.kind, set.name), "interval": 86400, "proxy": group}
			rules = append(rules, "RULE-SET,"+set.provider+",DIRECT")
		}
		dns["nameserver-policy"] = map[string]any{"rule-set:private_domain,cn_domain": []string{"https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"}}
		config["rule-providers"] = providers
	}
	config["rules"] = append(rules, "MATCH,"+group)
	out, err := json.Marshal(config)
	return string(out), err
}

// seedRuleSets keeps the first smart connection from waiting for the rule sets. mihomo downloads a rule set
// that has no file yet before it starts the tunnel (through the tunnel's own, still untested transport, so a
// blocked first transport held the connect for the whole download timeout). A set without a file gets a
// one-entry placeholder dated 1970: mihomo loads it at once and, finding it stale, downloads the real set in
// the background and swaps it in (retrying from 10 s on failure). Until then everything goes through the
// tunnel, as in global mode. A set that exists but is old was already refreshed in the background.
func seedRuleSets(home string) {
	placeholders := map[string]string{"domain": "tracknothing.invalid", "ipcidr": "192.0.2.255/32"}
	for _, set := range smartRuleSets {
		path := filepath.Join(home, filepath.FromSlash(ruleSetPath(set.kind, set.name)))
		if _, err := os.Stat(path); err == nil {
			continue
		}
		behavior, err := P.ParseBehavior(set.behavior)
		if err != nil {
			continue
		}
		var buf bytes.Buffer
		if provider.ConvertToMrs([]byte(placeholders[set.behavior]+"\n"), behavior, P.TextRule, &buf) != nil {
			continue
		}
		if os.MkdirAll(filepath.Dir(path), 0o700) != nil || os.WriteFile(path, buf.Bytes(), 0o600) != nil {
			continue
		}
		_ = os.Chtimes(path, time.Unix(0, 0), time.Unix(0, 0))
	}
}
