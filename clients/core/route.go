package core

import (
	"encoding/json"
	"math"
	"net/netip"
)

// The path drawn on the route globe, built from a Trace and the places the server gave its routers' addresses
// (POST /api/v2/native/route-hops). It is shared by every app so they all draw and list the same thing, and it is
// strict about what it shows: a router is placed only at city level, routers in one city are one row, a place that
// the round trip makes impossible (faster than light in fibre) is dropped, and silent routers are never guessed.

type routePlace struct {
	IP      string            `json:"ip"`
	Lat     *float64          `json:"lat"`
	Lon     *float64          `json:"lon"`
	Country string            `json:"country"`
	Names   map[string]string `json:"names"`
	Network string            `json:"network"`
}

type routeSpot struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type routeInput struct {
	Origin *routeSpot  `json:"origin"`
	Exit   routeSpot   `json:"exit"`
	Trace  traceResult `json:"trace"`
	Places struct {
		Hops []routePlace `json:"hops"`
	} `json:"places"`
}

// RouteRow is one line of the "via" list. Kind: local (home or provider network), city, unknown (answered, place
// not known), gap (N routers did not answer), exit (the node).
type RouteRow struct {
	Kind    string            `json:"kind"`
	N       int               `json:"n,omitempty"`
	Ms      int               `json:"ms,omitempty"`
	Names   map[string]string `json:"names,omitempty"`
	Network string            `json:"network,omitempty"`
	Border  bool              `json:"border,omitempty"`
	Lat     float64           `json:"lat,omitempty"`
	Lon     float64           `json:"lon,omitempty"`
	country string
}

// RoutePoint is a stop drawn on the globe between this device and the exit; Faint marks the stretch leading to it
// as unmeasured (routers on it stayed silent).
type RoutePoint struct {
	Lat   float64           `json:"lat"`
	Lon   float64           `json:"lon"`
	Names map[string]string `json:"names"`
	Faint bool              `json:"faint,omitempty"`
}

type routeResult struct {
	Rows      []RouteRow   `json:"rows"`
	Points    []RoutePoint `json:"points"`
	ExitFaint bool         `json:"exitFaint,omitempty"`
	Ms        int          `json:"ms,omitempty"`
	Reached   bool         `json:"reached"`
}

// sameCityKm: stops closer than this are one place (a city and its suburbs, the database's coarse coordinates).
const sameCityKm = 60

// Route builds the globe's path and the list from a JSON input {origin, exit, trace, places} and returns
// {rows, points, exitFaint, ms, reached}; an unreadable input gives no points and no rows.
func Route(input string) string {
	var in routeInput
	if json.Unmarshal([]byte(input), &in) != nil {
		return `{"rows":[],"points":[],"reached":false}`
	}
	out, _ := json.Marshal(buildRoute(in))
	return string(out)
}

func buildRoute(in routeInput) routeResult {
	places := map[string]routePlace{}
	for _, p := range in.Places.Hops {
		places[p.IP] = p
	}
	result := routeResult{Rows: []RouteRow{}, Points: []RoutePoint{}, Reached: in.Trace.Reached}
	hops := in.Trace.Hops
	if in.Trace.Reached && len(hops) > 0 {
		result.Ms = hops[len(hops)-1].Ms
		hops = hops[:len(hops)-1]
	}
	add := func(row RouteRow) {
		if n := len(result.Rows); n > 0 {
			last := &result.Rows[n-1]
			merge := last.Kind == row.Kind && (row.Kind == "local" || row.Kind == "gap" || row.Kind == "unknown" ||
				row.Kind == "city" && km(last.Lat, last.Lon, row.Lat, row.Lon) < sameCityKm)
			if merge {
				last.N += row.N
				if row.Ms > 0 {
					last.Ms = row.Ms
				}
				if last.Network == "" {
					last.Network = row.Network
				}
				return
			}
		}
		result.Rows = append(result.Rows, row)
	}
	for _, h := range hops {
		addr, err := netip.ParseAddr(h.Addr)
		switch {
		case h.Addr == "" || err != nil:
			add(RouteRow{Kind: "gap", N: 1})
		case !addr.IsGlobalUnicast() || addr.IsPrivate() || cgnat(addr):
			add(RouteRow{Kind: "local", N: 1, Ms: h.Ms})
		default:
			p, ok := places[h.Addr]
			if !ok || p.Lat == nil || p.Lon == nil || !possible(in.Origin, *p.Lat, *p.Lon, h.Ms) {
				add(RouteRow{Kind: "unknown", N: 1, Ms: h.Ms, Network: p.Network})
				continue
			}
			add(RouteRow{Kind: "city", N: 1, Ms: h.Ms, Names: p.Names, Network: p.Network, Lat: *p.Lat, Lon: *p.Lon, country: p.Country})
		}
	}
	// Silent routers after the last answer, before a target that never answered, say nothing: one gap row.
	if !in.Trace.Reached {
		if n := len(result.Rows); n == 0 || result.Rows[n-1].Kind != "gap" {
			result.Rows = append(result.Rows, RouteRow{Kind: "gap"})
		}
	}
	// The border: the first city in another country than the city before it.
	prev := ""
	for i := range result.Rows {
		r := &result.Rows[i]
		if r.Kind != "city" || r.country == "" {
			continue
		}
		if prev != "" && r.country != prev {
			r.Border = true
			break
		}
		prev = r.country
	}
	result.Rows = append(result.Rows, RouteRow{Kind: "exit", Ms: result.Ms})
	// The stops on the globe: cities away from this device, the exit and the stop before them.
	faint, atExit := false, false
	var last *routeSpot = in.Origin
	for _, r := range result.Rows {
		switch r.Kind {
		case "gap", "unknown":
			// The silent target itself (the row added above, N 0) leaves no stretch unmeasured when the last router
			// that answered is already at the exit.
			if r.N > 0 || !atExit {
				faint = true
			}
		case "city":
			atExit = km(in.Exit.Lat, in.Exit.Lon, r.Lat, r.Lon) < sameCityKm
			if last != nil && km(last.Lat, last.Lon, r.Lat, r.Lon) < sameCityKm || km(in.Exit.Lat, in.Exit.Lon, r.Lat, r.Lon) < sameCityKm {
				faint = false // measured up to here: the silence was inside one place
				continue
			}
			result.Points = append(result.Points, RoutePoint{Lat: r.Lat, Lon: r.Lon, Names: r.Names, Faint: faint})
			last = &routeSpot{r.Lat, r.Lon}
			faint = false
		}
	}
	result.ExitFaint = faint
	for i := range result.Rows {
		if result.Rows[i].Kind == "city" {
			result.Rows[i].N = 0
		}
	}
	return result
}

// possible tells whether a router at (lat, lon) can answer in ms from a device at origin: light in fibre covers
// about 100 km of distance per millisecond of round trip; a quarter of slack covers coarse coordinates.
func possible(origin *routeSpot, lat, lon float64, ms int) bool {
	if origin == nil {
		return true
	}
	d := km(origin.Lat, origin.Lon, lat, lon)
	return d < 300 || float64(ms)*100*1.25 >= d
}

func cgnat(a netip.Addr) bool {
	return netip.MustParsePrefix("100.64.0.0/10").Contains(a) || netip.MustParsePrefix("198.18.0.0/15").Contains(a)
}

func km(aLat, aLon, bLat, bLon float64) float64 {
	r := math.Pi / 180
	s := math.Sin(aLat*r)*math.Sin(bLat*r) + math.Cos(aLat*r)*math.Cos(bLat*r)*math.Cos((aLon-bLon)*r)
	return math.Acos(math.Max(-1, math.Min(1, s))) * 6371
}
