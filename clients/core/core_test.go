package core

import (
	"testing"

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
