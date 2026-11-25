package core

import (
	"encoding/json"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel/statistic"
)

// Activity: what the apps' "活动" views show — the open connections, where this connection's
// traffic went (by domain, rule and, on Windows, process), proxied vs direct per hour, and the
// names looked up. It is kept in memory only, sampled once a second while the core runs, and
// cleared when it stops: nothing is written to disk or sent anywhere.

const (
	activityKeys = 2000 // per ranking; later new keys are not counted once full (bounded memory on iOS)
	activityDNS  = 50
	activityList = 200
)

type amount struct {
	Proxy  int64
	Direct int64
}

type seen struct {
	up, down int64
	rate     int64
}

type activityState struct {
	sync.Mutex
	conns   map[string]*seen
	domains map[string]*amount
	rules   map[string]*amount
	apps    map[string]*amount
	hours   [24]amount
	names   map[string]bool
	dns     []dnsEntry
	stop    chan struct{}
}

type dnsEntry struct {
	Time   int64  `json:"time"`
	Host   string `json:"host"`
	Result string `json:"result"`
	Proxy  bool   `json:"proxy"`
}

var activity = &activityState{}

func (a *activityState) reset() {
	a.conns = map[string]*seen{}
	a.domains = map[string]*amount{}
	a.rules = map[string]*amount{}
	a.apps = map[string]*amount{}
	a.hours = [24]amount{}
	a.names = map[string]bool{}
	a.dns = nil
}

// startActivity begins sampling; called with the core lock held.
func startActivity() {
	a := activity
	a.Lock()
	if a.stop != nil {
		close(a.stop)
	}
	a.reset()
	stop := make(chan struct{})
	a.stop = stop
	a.Unlock()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				a.sample()
			}
		}
	}()
}

// stopActivity ends sampling and forgets everything; called with the core lock held.
func stopActivity() {
	a := activity
	a.Lock()
	defer a.Unlock()
	if a.stop != nil {
		close(a.stop)
		a.stop = nil
	}
	a.reset()
}

func add(table map[string]*amount, key string, delta int64, proxy bool) {
	if key == "" || delta <= 0 {
		return
	}
	entry, ok := table[key]
	if !ok {
		if len(table) >= activityKeys {
			return
		}
		entry = &amount{}
		table[key] = entry
	}
	if proxy {
		entry.Proxy += delta
	} else {
		entry.Direct += delta
	}
}

func host(m *C.Metadata) string {
	if h := m.RuleHost(); h != "" {
		return h
	}
	if m.DstIP.IsValid() {
		return m.DstIP.String()
	}
	return ""
}

// site groups a host by its registrable part: objects.githubusercontent.com -> githubusercontent.com,
// mirrors.tuna.tsinghua.edu.cn -> tsinghua.edu.cn. IP addresses stay as they are.
func site(name string) string {
	if net.ParseIP(name) != nil {
		return name
	}
	labels := strings.Split(strings.TrimSuffix(name, "."), ".")
	keep := 2
	if n := len(labels); n >= 3 && len(labels[n-1]) == 2 {
		switch labels[n-2] {
		case "com", "net", "org", "edu", "gov", "co", "ac", "or", "ne", "go":
			keep = 3
		}
	}
	if len(labels) <= keep {
		return name
	}
	return strings.Join(labels[len(labels)-keep:], ".")
}

// rule names the rule that matched, as written in the configuration: "RULE-SET,cn_domain", "MATCH".
func rule(info *statistic.TrackerInfo) string {
	kind := info.Rule
	switch kind {
	case "RuleSet":
		kind = "RULE-SET"
	case "Match":
		return "MATCH"
	case "IPCIDR":
		kind = "IP-CIDR"
	case "Domain":
		kind = "DOMAIN"
	case "DomainSuffix":
		kind = "DOMAIN-SUFFIX"
	case "DomainKeyword":
		kind = "DOMAIN-KEYWORD"
	case "ProcessName":
		kind = "PROCESS-NAME"
	case "":
		return ""
	default:
		kind = strings.ToUpper(kind)
	}
	if info.RulePayload == "" {
		return kind
	}
	return kind + "," + info.RulePayload
}

func direct(info *statistic.TrackerInfo) bool {
	return len(info.Chain) == 0 || info.Chain[0] == "DIRECT"
}

func (a *activityState) sample() {
	a.Lock()
	defer a.Unlock()
	if a.stop == nil {
		return
	}
	now := time.Now()
	hour, day := now.Hour(), now.Format("2006-01-02")
	live := map[string]bool{}
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		info := c.Info()
		id := c.ID()
		live[id] = true
		up, down := info.UploadTotal.Load(), info.DownloadTotal.Load()
		last, ok := a.conns[id]
		if !ok {
			last = &seen{}
			a.conns[id] = last
			a.lookup(info)
		}
		delta := (up - last.up) + (down - last.down)
		last.rate = down - last.down
		last.up, last.down = up, down
		proxy := !direct(info)
		name := host(info.Metadata)
		add(a.domains, site(name), delta, proxy)
		add(a.rules, rule(info), delta, proxy)
		add(a.apps, info.Metadata.Process, delta, proxy)
		appUsage.count(day, info.Metadata.Process, delta, proxy)
		if delta > 0 {
			if proxy {
				a.hours[hour].Proxy += delta
			} else {
				a.hours[hour].Direct += delta
			}
		}
		return true
	})
	for id := range a.conns {
		if !live[id] {
			delete(a.conns, id)
		}
	}
	appUsage.tick()
}

// lookup records a name the first time a connection uses it: proxied names are resolved by the
// node (nothing is asked locally), direct ones show the address they resolved to.
func (a *activityState) lookup(info *statistic.TrackerInfo) {
	name := info.Metadata.RuleHost()
	if name == "" || a.names[name] {
		return
	}
	if len(a.names) < activityKeys {
		a.names[name] = true
	}
	entry := dnsEntry{Time: info.Start.UnixMilli(), Host: name, Proxy: !direct(info)}
	if !entry.Proxy {
		entry.Result = info.Metadata.RemoteDst
		if entry.Result == "" && info.Metadata.DstIP.IsValid() && !strings.HasPrefix(info.Metadata.DstIP.String(), "198.18.") {
			entry.Result = info.Metadata.DstIP.String()
		}
	}
	a.dns = append([]dnsEntry{entry}, a.dns...)
	if len(a.dns) > activityDNS {
		a.dns = a.dns[:activityDNS]
	}
}

type rankRow struct {
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
	Proxy bool   `json:"proxy"`
}

func top(table map[string]*amount, n int) []rankRow {
	rows := make([]rankRow, 0, len(table))
	for name, value := range table {
		rows = append(rows, rankRow{Name: name, Bytes: value.Proxy + value.Direct, Proxy: value.Proxy >= value.Direct})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Bytes != rows[j].Bytes {
			return rows[i].Bytes > rows[j].Bytes
		}
		return rows[i].Name < rows[j].Name
	})
	if len(rows) > n {
		rows = rows[:n]
	}
	return rows
}

type connRow struct {
	ID      string `json:"id"`
	Host    string `json:"host"`
	Process string `json:"process,omitempty"`
	Rule    string `json:"rule"`
	Proxy   bool   `json:"proxy"`
	Via     string `json:"via"` // the transport carrying it, or DIRECT
	Rate    int64  `json:"rate"`
	Bytes   int64  `json:"bytes"`
	Start   int64  `json:"start"`
	Mine    bool   `json:"mine,omitempty"` // matched one of the person's own rules
}

// Activity returns the activity as JSON:
//
//	{"conns":[{id,host,process,rule,proxy,via,rate,bytes,start,mine}], "proxy":n, "direct":n,
//	 "domains":[{name,bytes,proxy}], "rules":[…], "apps":[…], "hours":[[proxy,direct]×24], "dns":[{time,host,result,proxy}]}
//
// Bytes are counted since the core started (this connection); hours are the device's local hours.
func Activity() string {
	a := activity
	a.Lock()
	defer a.Unlock()
	conns := []connRow{}
	liveRun.Lock()
	mine := liveRun.mine
	liveRun.Unlock()
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		info := c.Info()
		row := connRow{ID: c.ID(), Host: host(info.Metadata), Process: info.Metadata.Process, Rule: rule(info), Proxy: !direct(info),
			Bytes: info.UploadTotal.Load() + info.DownloadTotal.Load(), Start: info.Start.UnixMilli()}
		if len(info.Chain) > 0 {
			row.Via = info.Chain[0]
		}
		row.Mine = mine[row.Rule]
		if last, ok := a.conns[c.ID()]; ok {
			row.Rate = last.rate
		}
		conns = append(conns, row)
		return true
	})
	sort.Slice(conns, func(i, j int) bool {
		if conns[i].Rate != conns[j].Rate {
			return conns[i].Rate > conns[j].Rate
		}
		return conns[i].Start > conns[j].Start
	})
	if len(conns) > activityList {
		conns = conns[:activityList]
	}
	var proxy, directBytes int64
	hours := make([][2]int64, 24)
	for i, h := range a.hours {
		hours[i] = [2]int64{h.Proxy, h.Direct}
		proxy += h.Proxy
		directBytes += h.Direct
	}
	dns := a.dns
	if dns == nil {
		dns = []dnsEntry{}
	}
	out, _ := json.Marshal(map[string]any{"conns": conns, "proxy": proxy, "direct": directBytes,
		"domains": top(a.domains, 8), "rules": top(a.rules, 8), "apps": top(a.apps, 8), "hours": hours, "dns": dns})
	return string(out)
}
