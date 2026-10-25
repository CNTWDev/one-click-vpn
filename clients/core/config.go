package core

import (
	"encoding/json"
	"fmt"
)

// The one mihomo configuration every app runs, built here so Android, Apple and Windows cannot drift.
const (
	group    = "TrackNothing"
	testURL  = "https://www.gstatic.com/generate_204"
	ruleSets = "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo"
)

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
		"proxy-groups": []map[string]any{{"name": group, "type": "fallback", "proxies": o.Order, "url": testURL, "interval": 300, "lazy": false}}}
	if o.Smart {
		// Same small rule sets as the subscription profiles (server/mihomo-config.mjs), fetched through the tunnel.
		ruleSet := func(kind, name, behavior string) map[string]any {
			return map[string]any{"type": "http", "behavior": behavior, "format": "mrs", "url": ruleSets + "/" + kind + "/" + name + ".mrs",
				"path": "./rules/" + kind + "-" + name + ".mrs", "interval": 86400, "proxy": group}
		}
		dns["nameserver-policy"] = map[string]any{"rule-set:private_domain,cn_domain": []string{"https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"}}
		rules = append(rules, "RULE-SET,private_domain,DIRECT", "RULE-SET,cn_domain,DIRECT", "RULE-SET,cn_ip,DIRECT")
		config["rule-providers"] = map[string]any{"private_domain": ruleSet("geosite", "private", "domain"),
			"cn_domain": ruleSet("geosite", "cn", "domain"), "cn_ip": ruleSet("geoip", "cn", "ipcidr")}
	}
	config["rules"] = append(rules, "MATCH,"+group)
	out, err := json.Marshal(config)
	return string(out), err
}
