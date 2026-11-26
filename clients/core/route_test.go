package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func f(v float64) *float64 { return &v }

func TestRouteBuildsStopsAndRows(t *testing.T) {
	in := routeInput{Origin: &routeSpot{39.9, 116.4}, Exit: routeSpot{34.05, -118.24}}
	in.Trace = traceResult{Reached: true, Hops: []hop{
		{TTL: 1, Addr: "192.168.1.1", Ms: 2}, {TTL: 2, Addr: "100.72.0.1", Ms: 3},
		{TTL: 3, Addr: "202.97.1.1", Ms: 4}, {TTL: 4, Addr: "202.97.1.2", Ms: 5}, // Beijing, twice: one row, no stop (it is home)
		{TTL: 5, Addr: "202.97.2.1", Ms: 27}, // Shanghai
		{TTL: 6}, {TTL: 7},                   // silent
		{TTL: 8, Addr: "203.0.113.9", Ms: 6}, // "Los Angeles" in 6 ms from Beijing: impossible, not placed
		{TTL: 9, Addr: "198.51.100.7", Ms: 158},
	}}
	in.Places.Hops = []routePlace{
		{IP: "202.97.1.1", Lat: f(39.9), Lon: f(116.4), Country: "CN", Names: map[string]string{"en": "Beijing"}, Network: "China Telecom"},
		{IP: "202.97.1.2", Lat: f(39.95), Lon: f(116.3), Country: "CN", Names: map[string]string{"en": "Beijing"}},
		{IP: "202.97.2.1", Lat: f(31.2), Lon: f(121.5), Country: "CN", Names: map[string]string{"en": "Shanghai"}},
		{IP: "203.0.113.9", Lat: f(34.0), Lon: f(-118.2), Country: "US", Names: map[string]string{"en": "Los Angeles"}},
	}
	r := buildRoute(in)
	kinds := []string{}
	for _, row := range r.Rows {
		kinds = append(kinds, row.Kind)
	}
	if got := strings.Join(kinds, ","); got != "local,city,city,gap,unknown,exit" {
		t.Fatalf("rows %s", got)
	}
	if r.Rows[0].N != 2 || r.Rows[0].Ms != 3 || r.Rows[1].Ms != 5 || r.Rows[1].Network != "China Telecom" || r.Rows[3].N != 2 {
		t.Fatalf("rows %+v", r.Rows)
	}
	if len(r.Points) != 1 || r.Points[0].Names["en"] != "Shanghai" || r.Points[0].Faint || !r.ExitFaint || r.Ms != 158 || !r.Reached {
		t.Fatalf("points %+v exitFaint %v ms %d", r.Points, r.ExitFaint, r.Ms)
	}
}

func TestRouteMarksBorderAndUnreachedTarget(t *testing.T) {
	in := routeInput{Origin: &routeSpot{55.76, 37.62}, Exit: routeSpot{50.11, 8.68}}
	in.Trace = traceResult{Reached: false, Hops: []hop{{TTL: 1, Addr: "5.0.0.1", Ms: 3}, {TTL: 2, Addr: "5.0.0.2", Ms: 14}, {TTL: 3, Addr: "5.0.0.3", Ms: 37}}}
	in.Places.Hops = []routePlace{
		{IP: "5.0.0.1", Lat: f(55.7), Lon: f(37.6), Country: "RU", Names: map[string]string{"en": "Moscow"}},
		{IP: "5.0.0.2", Lat: f(60.17), Lon: f(24.94), Country: "FI", Names: map[string]string{"en": "Helsinki"}},
		{IP: "5.0.0.3", Lat: f(50.1), Lon: f(8.7), Country: "DE", Names: map[string]string{"en": "Frankfurt"}},
	}
	r := buildRoute(in)
	if len(r.Rows) != 5 || !r.Rows[1].Border || r.Rows[2].Border || r.Rows[3].Kind != "gap" || r.Rows[4].Kind != "exit" || r.Reached || r.Ms != 0 {
		t.Fatalf("rows %+v", r.Rows)
	}
	// Frankfurt answered next to the exit: the stretch to the exit is measured, only Helsinki is a stop.
	if len(r.Points) != 1 || r.Points[0].Names["en"] != "Helsinki" || r.ExitFaint {
		t.Fatalf("points %+v exitFaint %v", r.Points, r.ExitFaint)
	}
}

func TestRouteUnreadableInput(t *testing.T) {
	var out map[string]any
	if json.Unmarshal([]byte(Route("{")), &out) != nil || len(out["rows"].([]any)) != 0 {
		t.Fatal(Route("{"))
	}
}

func TestParseICMPMatchesOurRequests(t *testing.T) {
	req := echoRequest(7, 1234)
	if icmpChecksum(req) != 0 {
		t.Fatal("checksum")
	}
	reply := append([]byte{0, 0, 0, 0}, req[4:]...)
	if seq, last, ok := parseICMP(reply, 7); !ok || !last || seq != 1234 {
		t.Fatal("echo reply", seq, last, ok)
	}
	ip := []byte{0x45, 0, 0, 36, 0, 0, 0, 0, 1, 1, 0, 0, 10, 0, 0, 1, 1, 2, 3, 4}
	exceeded := append(append([]byte{11, 0, 0, 0, 0, 0, 0, 0}, ip...), req[:8]...)
	withHeader := append(append([]byte{}, ip...), exceeded...)
	for _, b := range [][]byte{exceeded, withHeader} {
		if seq, last, ok := parseICMP(b, 7); !ok || last || seq != 1234 {
			t.Fatal("time exceeded", seq, last, ok)
		}
	}
	if _, _, ok := parseICMP(exceeded, 8); ok {
		t.Fatal("someone else's request matched")
	}
}

func TestCollectHopsStopsAtTarget(t *testing.T) {
	target := mustAddr("192.0.2.9")
	r := collectHops(target, []probeAnswer{{ttl: 1, from: mustAddr("10.0.0.1"), rtt: 2e6}, {ttl: 3, from: target, rtt: 9e6, last: true}, {ttl: 4, from: target, rtt: 9e6, last: true}})
	if !r.Reached || len(r.Hops) != 3 || r.Hops[1].Addr != "" || r.Hops[2].Ms != 9 || r.Hops[0].Ms != 2 {
		t.Fatalf("%+v", r)
	}
}

func TestTraceLoopback(t *testing.T) {
	var r traceResult
	if err := json.Unmarshal([]byte(Trace("127.0.0.1:443", 1500)), &r); err != nil {
		t.Fatal(err)
	}
	if r.Error != "" {
		t.Skip("no unprivileged ICMP here: " + r.Error)
	}
	if !r.Reached || len(r.Hops) != 1 || r.Hops[0].Addr != "127.0.0.1" {
		t.Fatalf("%+v", r)
	}
}
