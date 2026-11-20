package core

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/metacubex/mihomo/config"
)

// The configuration as Android's org.json writes it: every "/" escaped as "\/".
const escaped = `{"mode":"rule","log-level":"silent","ipv6":false,
"dns":{"enable":true,"enhanced-mode":"fake-ip","fake-ip-range":"198.18.0.1\/16","nameserver":["https:\/\/1.1.1.1\/dns-query"]},
"tun":{"enable":true,"stack":"gvisor","file-descriptor":42,"auto-route":false,"auto-detect-interface":false,"dns-hijack":["any:53"],"mtu":1500},
"proxies":[{"name":"wireguard","type":"wireguard","server":"1.2.3.4","port":51820,"ip":"10.8.0.2","private-key":"yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=","public-key":"HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=","allowed-ips":["0.0.0.0\/0"],"udp":true,"mtu":1280,"remote-dns-resolve":true,"dns":["1.1.1.1"]},
 {"name":"reality","type":"vless","server":"1.2.3.4","port":443,"uuid":"9d8a8e0e-0000-4000-8000-000000000000","network":"tcp","tls":true,"udp":true,"flow":"xtls-rprx-vision","servername":"www.microsoft.com","client-fingerprint":"chrome","reality-opts":{"public-key":"HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw","short-id":"abcd"}}],
"proxy-groups":[{"name":"TrackNothing","type":"fallback","proxies":["wireguard","reality"],"url":"https:\/\/www.gstatic.com\/generate_204","interval":300,"lazy":false}],
"rules":["IP-CIDR,10.0.0.0\/8,DIRECT,no-resolve","MATCH,TrackNothing"]}`

func TestEscapedSlashesParse(t *testing.T) {
	if _, err := config.Parse([]byte(escaped)); err == nil {
		t.Fatal("expected the raw escaped configuration to be rejected; the test no longer covers the bug")
	}
	cfg, err := config.Parse(normalize([]byte(escaped)))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.General.Tun.FileDescriptor != 42 {
		t.Fatalf("tun file descriptor = %d", cfg.General.Tun.FileDescriptor)
	}
	if _, ok := cfg.Proxies["reality"]; !ok {
		t.Fatal("reality proxy missing")
	}
}

func TestYAMLUnchanged(t *testing.T) {
	if got := string(normalize([]byte(idle))); got != idle {
		t.Fatalf("normalize changed YAML: %q", got)
	}
}

func TestBuildParsesOnEveryPlatform(t *testing.T) {
	proxies := []map[string]any{
		{"name": "wireguard", "type": "wireguard", "server": "1.2.3.4", "port": 51820, "ip": "10.8.0.2",
			"private-key": "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=", "public-key": "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=",
			"allowed-ips": []string{"0.0.0.0/0"}, "udp": true, "mtu": 1280, "remote-dns-resolve": true, "dns": []string{"1.1.1.1"}},
	}
	for _, platform := range []string{"android", "apple", "windows"} {
		for _, smart := range []bool{false, true} {
			text, err := Build(Options{Platform: platform, FD: 42, Smart: smart, Proxies: proxies, Order: []string{"wireguard"}})
			if err != nil {
				t.Fatal(platform, err)
			}
			cfg, err := config.Parse(normalize([]byte(text)))
			if err != nil {
				t.Fatal(platform, smart, err)
			}
			if platform == "windows" {
				if cfg.General.Tun.FileDescriptor != 0 || !cfg.General.Tun.AutoRoute || cfg.Rules[0].Payload() != "Veilbird.exe" {
					t.Fatalf("windows tun or process rule wrong: %+v", cfg.General.Tun)
				}
			} else if cfg.General.Tun.FileDescriptor != 42 || cfg.General.Tun.AutoRoute {
				t.Fatalf("%s tun = %+v", platform, cfg.General.Tun)
			}
			if got := len(cfg.RuleProviders); (got > 0) != smart {
				t.Fatalf("%s smart=%v rule providers = %d", platform, smart, got)
			}
			if last := cfg.Rules[len(cfg.Rules)-1]; last.Adapter() != group {
				t.Fatalf("last rule goes to %s", last.Adapter())
			}
		}
	}
	if _, err := Build(Options{Platform: "linux", Proxies: proxies, Order: []string{"wireguard"}}); err == nil {
		t.Fatal("unknown platform accepted")
	}
}

func TestReachWithoutCoreAnswersMinusOne(t *testing.T) {
	if got := Reach("not an address", 100); got != -1 {
		t.Fatalf("Reach(bad) = %d, want -1", got)
	}
}

func TestSiteGroupsByRegistrablePart(t *testing.T) {
	cases := map[string]string{
		"objects.githubusercontent.com": "githubusercontent.com",
		"mirrors.tuna.tsinghua.edu.cn":  "tsinghua.edu.cn",
		"www.bbc.co.uk":                 "bbc.co.uk",
		"github.com":                    "github.com",
		"1.2.3.4":                       "1.2.3.4",
		"localhost":                     "localhost",
	}
	for in, want := range cases {
		if got := site(in); got != want {
			t.Errorf("site(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestActivityWithoutCoreIsEmpty(t *testing.T) {
	var out struct {
		Conns []any      `json:"conns"`
		Hours [][2]int64 `json:"hours"`
		DNS   []any      `json:"dns"`
	}
	if err := json.Unmarshal([]byte(Activity()), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Conns) != 0 || len(out.Hours) != 24 || out.DNS == nil {
		t.Fatalf("unexpected %+v", out)
	}
}

func TestTopRanksByBytes(t *testing.T) {
	rows := top(map[string]*amount{"a": {Proxy: 5}, "b": {Direct: 9}, "c": {Proxy: 1, Direct: 1}}, 2)
	if len(rows) != 2 || rows[0].Name != "b" || rows[0].Proxy || rows[1].Name != "a" || !rows[1].Proxy {
		t.Fatalf("unexpected %+v", rows)
	}
}

// hangingListener accepts connections and never answers: a transport blocked after the handshake.
func hangingListener(t *testing.T) int {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = conn.Close() })
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

// Connecting does not wait for a transport that hangs: the first answer in ladder order counts, and when only a
// later transport answered, the group is pinned to it so traffic does not go to the untested earlier one.
func TestProbeFirst(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer page.Close()
	proxy := connectProxy()
	defer proxy.Close()
	up, slow := proxy.Listener.Addr().(*net.TCPAddr).Port, hangingListener(t)
	for _, order := range [][]string{{"up", "slow"}, {"slow", "up"}} {
		configuration := fmt.Sprintf("mode: rule\nlog-level: silent\nproxies:\n  - {name: up, type: http, server: 127.0.0.1, port: %d}\n  - {name: slow, type: http, server: 127.0.0.1, port: %d}\nproxy-groups:\n  - {name: Line, type: fallback, proxies: [%s], url: '%s/204', interval: 300, lazy: true}\nrules:\n  - MATCH,Line\n", up, slow, strings.Join(order, ", "), page.URL)
		if err := start(t.TempDir(), configuration); err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		got := ProbeFirst(strings.Join(order, ","), "Line", page.URL+"/204", 4000)
		elapsed := time.Since(started)
		if !strings.HasPrefix(got, "up=") || strings.Contains(got, "slow") {
			t.Fatalf("%v: got %q", order, got)
		}
		limit := 500 * time.Millisecond
		if order[0] == "slow" {
			limit = settle + 500*time.Millisecond
		}
		if elapsed > limit {
			t.Fatalf("%v: took %v", order, elapsed)
		}
		if now := Now("Line"); now != "up" {
			t.Fatalf("%v: group uses %q", order, now)
		}
		Stop()
	}
}

// A smart connection starts without downloading the rule sets: missing ones get a stale placeholder that mihomo
// loads at once and refreshes in the background.
func TestRuleSetsDoNotBlockStart(t *testing.T) {
	home := t.TempDir()
	slow := hangingListener(t)
	providers := []string{}
	for _, set := range smartRuleSets {
		providers = append(providers, fmt.Sprintf("  %s: {type: http, behavior: %s, format: mrs, url: 'http://127.0.0.1:%d/%s.mrs', path: '%s', interval: 86400}", set.provider, set.behavior, slow, set.name, ruleSetPath(set.kind, set.name)))
	}
	configuration := "mode: rule\nlog-level: silent\nrule-providers:\n" + strings.Join(providers, "\n") + "\nrules:\n  - RULE-SET,cn_domain,DIRECT\n  - RULE-SET,cn_ip,DIRECT\n  - MATCH,DIRECT\n"
	seedRuleSets(home)
	started := time.Now()
	if err := start(home, configuration); err != nil {
		t.Fatal(err)
	}
	defer Stop()
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("start waited %v for the rule sets", elapsed)
	}
	for _, set := range smartRuleSets {
		info, err := os.Stat(filepath.Join(home, "rules", set.kind+"-"+set.name+".mrs"))
		if err != nil || info.ModTime().After(time.Unix(1, 0)) {
			t.Fatalf("%s: %v %v", set.name, err, info)
		}
	}
	// A second seeding leaves existing files alone.
	seedRuleSets(home)
}

func TestBuildPerAppRouting(t *testing.T) {
	proxies := []map[string]any{{"name": "reality", "type": "vless", "server": "1.2.3.4", "port": 443, "uuid": "c7a5b0f4-1d2e-4c3b-9a8f-0e1d2c3b4a59"}}
	parse := func(o Options) *config.Config {
		o.Platform, o.Proxies, o.Order = "windows", proxies, []string{"reality"}
		text, err := Build(o)
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := config.Parse(normalize([]byte(text)))
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}
	only := parse(Options{AppMode: "only", Apps: []string{"chrome.exe", "Telegram.exe", "bad,name.exe", "chrome.exe"}})
	var tunneled []string
	for _, rule := range only.Rules {
		if rule.RuleType().String() == "ProcessName" && rule.Adapter() == group {
			tunneled = append(tunneled, rule.Payload())
		}
	}
	if strings.Join(tunneled, " ") != "chrome.exe Telegram.exe" || only.Rules[len(only.Rules)-1].Adapter() != "DIRECT" {
		t.Fatalf("only: tunneled %v, last %s", tunneled, only.Rules[len(only.Rules)-1].Adapter())
	}
	except := parse(Options{AppMode: "except", Apps: []string{"steam.exe"}, Smart: true})
	if except.Rules[1].Payload() != "steam.exe" || except.Rules[1].Adapter() != "DIRECT" || except.Rules[len(except.Rules)-1].Adapter() != group {
		t.Fatalf("except: rule 1 %s→%s", except.Rules[1].Payload(), except.Rules[1].Adapter())
	}
	// Android leaves apps out of its tun itself; the core ignores the list there.
	text, _ := Build(Options{Platform: "android", Proxies: proxies, Order: []string{"reality"}, AppMode: "only", Apps: []string{"x"}})
	if strings.Contains(text, "PROCESS-NAME") {
		t.Fatal("android config has process rules")
	}
}
