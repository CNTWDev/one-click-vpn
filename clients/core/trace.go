package core

import (
	"context"
	"encoding/json"
	"net/netip"
	"strings"
	"time"

	"github.com/metacubex/mihomo/component/resolver"
)

// traceMaxHops bounds the path: 24 hops covers every real route to a node; the probes for all of them are sent at
// once, so a longer bound only costs packets, not time.
const traceMaxHops = 24

// hop is one TTL of a trace: the router that answered (Addr empty when nobody did) and its round trip.
type hop struct {
	TTL  int    `json:"ttl"`
	Addr string `json:"ip,omitempty"`
	Ms   int    `json:"ms,omitempty"`
}

type traceResult struct {
	Target  string `json:"target"`
	Reached bool   `json:"reached"`
	Hops    []hop  `json:"hops"`
	Error   string `json:"error,omitempty"`
}

// probeAnswer is what a platform's tracer reports for one TTL.
type probeAnswer struct {
	ttl  int
	from netip.Addr
	rtt  time.Duration
	last bool // the target itself answered (echo reply), not a router on the way
}

// Trace measures the path from this device to a node (host or host:port) outside the tunnel, like traceroute, and
// returns JSON {target, reached, hops:[{ttl, ip, ms}]} or {error}. It sends ICMP echo requests with every TTL from 1
// to traceMaxHops together and collects the routers' "time exceeded" answers, so it takes about one timeout no
// matter how long the path is. It needs no administrator rights: Android and Linux use an unprivileged ICMP
// ("ping") socket, macOS its unprivileged ICMP datagram socket, Windows the ICMP helper API. The route globe
// shows the answering hops between you and the exit; routers that stay silent are kept as hops without an address.
func Trace(address string, timeoutMs int) string {
	if timeoutMs <= 0 || timeoutMs > 10000 {
		timeoutMs = 2500
	}
	host := strings.TrimSpace(address)
	if h, _, ok := strings.Cut(host, ","); ok {
		host = strings.TrimSpace(h)
	}
	if ap, err := netip.ParseAddrPort(host); err == nil {
		host = ap.Addr().String()
	} else if i := strings.LastIndex(host, ":"); i > 0 && !strings.Contains(host[:i], ":") {
		host = host[:i]
	}
	host = strings.Trim(host, "[]")
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond+3*time.Second)
	defer cancel()
	target, err := netip.ParseAddr(host)
	if err != nil {
		// A node named by domain: resolved the way the core resolves proxy servers (never through the tunnel's fake IPs).
		target, err = resolver.ResolveIPv4WithResolver(ctx, host, resolver.ProxyServerHostResolver)
	}
	if err != nil || !target.Is4() {
		return traceJSON(traceResult{Target: host, Error: "unresolved"})
	}
	answers, err := tracePlatform(target.Unmap(), traceMaxHops, time.Duration(timeoutMs)*time.Millisecond)
	if err != nil {
		return traceJSON(traceResult{Target: target.String(), Error: err.Error()})
	}
	return traceJSON(collectHops(target.Unmap(), answers))
}

// collectHops turns the answers into one row per TTL up to the first one that reached the target.
func collectHops(target netip.Addr, answers []probeAnswer) traceResult {
	byTTL := map[int]probeAnswer{}
	end := 0
	for _, a := range answers {
		if a.ttl < 1 || a.ttl > traceMaxHops {
			continue
		}
		if old, ok := byTTL[a.ttl]; ok && old.rtt <= a.rtt {
			continue
		}
		byTTL[a.ttl] = a
		if (a.last || a.from == target) && (end == 0 || a.ttl < end) {
			end = a.ttl
		}
	}
	result := traceResult{Target: target.String(), Reached: end > 0, Hops: []hop{}}
	last := end
	if last == 0 {
		for ttl := range byTTL {
			last = max(last, ttl)
		}
	}
	for ttl := 1; ttl <= last; ttl++ {
		row := hop{TTL: ttl}
		if a, ok := byTTL[ttl]; ok {
			row.Addr = a.from.String()
			row.Ms = max(1, int((a.rtt+time.Millisecond/2)/time.Millisecond))
		}
		result.Hops = append(result.Hops, row)
	}
	return result
}

func traceJSON(r traceResult) string {
	if r.Hops == nil {
		r.Hops = []hop{}
	}
	out, _ := json.Marshal(r)
	return string(out)
}

// echoRequest builds an ICMP echo request whose sequence number carries the TTL it was sent with, so each answer
// (an echo reply, or a router's "time exceeded" quoting the request) says which hop it belongs to.
func echoRequest(id, seq int) []byte {
	b := []byte{8, 0, 0, 0, byte(id >> 8), byte(id), byte(seq >> 8), byte(seq), 'v', 'e', 'i', 'l', 'b', 'i', 'r', 'd'}
	s := icmpChecksum(b)
	b[2], b[3] = byte(s>>8), byte(s)
	return b
}

func icmpChecksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

// parseICMP reads an ICMP message (with or without the IPv4 header in front, which macOS includes) and returns the
// sequence number of our echo request it answers and whether it is the target's own echo reply. ok is false for
// anything that is not about one of our requests with this id (or any id when id < 0, as Linux rewrites it).
func parseICMP(b []byte, id int) (seq int, reply bool, ok bool) {
	if len(b) >= 20 && b[0]>>4 == 4 {
		ihl := int(b[0]&0x0f) * 4
		if ihl < 20 || len(b) < ihl+8 {
			return 0, false, false
		}
		b = b[ihl:]
	}
	if len(b) < 8 {
		return 0, false, false
	}
	switch b[0] {
	case 0: // echo reply
		if id >= 0 && int(b[4])<<8|int(b[5]) != id {
			return 0, false, false
		}
		return int(b[6])<<8 | int(b[7]), true, true
	case 11, 3: // time exceeded, destination unreachable: quote the original IP header + 8 bytes of our request
		inner := b[8:]
		if len(inner) < 28 || inner[0]>>4 != 4 {
			return 0, false, false
		}
		ihl := int(inner[0]&0x0f) * 4
		if len(inner) < ihl+8 || inner[9] != 1 || inner[ihl] != 8 {
			return 0, false, false
		}
		q := inner[ihl:]
		if id >= 0 && int(q[4])<<8|int(q[5]) != id {
			return 0, false, false
		}
		return int(q[6])<<8 | int(q[7]), b[0] == 3, true
	}
	return 0, false, false
}

// traceDone tells whether waiting longer can add nothing: the target answered and so did every TTL before it.
func traceDone(answers []probeAnswer) bool {
	end := 0
	seen := map[int]bool{}
	for _, a := range answers {
		seen[a.ttl] = true
		if a.last && (end == 0 || a.ttl < end) {
			end = a.ttl
		}
	}
	if end == 0 {
		return false
	}
	for ttl := 1; ttl < end; ttl++ {
		if !seen[ttl] {
			return false
		}
	}
	return true
}

func mustAddr(s string) netip.Addr { return netip.MustParseAddr(s) }
