package core

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// Fetch is how every app calls the TrackNothing API, so all of them reach it the same way when its domain
// is blocked. A request goes to the first origin that completes a TLS handshake; nothing is sent twice.
//
//   - Several origins: the app's own API domain first, then the other sites' API domains and the backup
//     domains the server lists (server/api-origins.ts). Later origins start a little later each.
//   - Per host, the addresses that worked before (cached in home) are dialled first, so a poisoned or
//     slow DNS answer is never needed. A cached address that fails is dropped.
//   - System DNS next, then DNS over HTTPS to public resolvers addressed by IP, for networks whose DNS
//     lies about the domain.
//
// Certificates are always checked against the domain name (SNI and verification use the host, never the
// IP), so a wrong address can only fail, never impersonate the server.

// FetchRequest is one API call.
type FetchRequest struct {
	Origins   []string          `json:"origins"`
	Method    string            `json:"method"`
	Path      string            `json:"path"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	TimeoutMs int               `json:"timeoutMs"`
}

// FetchResponse is what the app gets back. Origin is the one that answered: the app tries it first next time.
// Error is set only when no origin could be reached; any HTTP status counts as an answer.
type FetchResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
	Origin string `json:"origin"`
	Error  string `json:"error,omitempty"`
}

const (
	addressFile    = "api-addresses.json"
	maxBody        = 512 << 10
	originStagger  = 1200 * time.Millisecond
	dnsAfterCache  = 300 * time.Millisecond
	dohAfter       = 1500 * time.Millisecond
	dialTimeout    = 6 * time.Second
	addressesKept  = 4
	addressMaxDays = 30
)

// Public resolvers by address, so they need no DNS themselves; their certificates name these IPs.
var dohServers = []string{"1.1.1.1", "8.8.8.8", "9.9.9.9", "223.5.5.5", "1.12.12.12"}

// rootCAs replaces the system roots in tests.
var rootCAs *x509.CertPool

var cacheLock sync.Mutex

type cachedAddress struct {
	IP string `json:"ip"`
	At int64  `json:"at"`
}

func loadAddresses(home string) map[string][]cachedAddress {
	cache := map[string][]cachedAddress{}
	if data, err := os.ReadFile(filepath.Join(home, addressFile)); err == nil {
		_ = json.Unmarshal(data, &cache)
	}
	return cache
}

func saveAddresses(home string, cache map[string][]cachedAddress) {
	data, err := json.Marshal(cache)
	if err != nil || os.MkdirAll(home, 0o700) != nil {
		return
	}
	temporary := filepath.Join(home, addressFile+".tmp")
	if os.WriteFile(temporary, data, 0o600) == nil {
		_ = os.Rename(temporary, filepath.Join(home, addressFile))
	}
}

// remember moves ip to the front of host's list (worked) or removes it (failed).
func remember(home, host, ip string, worked bool) {
	cacheLock.Lock()
	defer cacheLock.Unlock()
	cache := loadAddresses(home)
	cutoff := time.Now().Add(-addressMaxDays * 24 * time.Hour).Unix()
	list := []cachedAddress{}
	if worked {
		list = append(list, cachedAddress{IP: ip, At: time.Now().Unix()})
	}
	for _, entry := range cache[host] {
		if entry.IP != ip && entry.At > cutoff && len(list) < addressesKept {
			list = append(list, entry)
		}
	}
	if len(list) == 0 {
		delete(cache, host)
	} else {
		cache[host] = list
	}
	saveAddresses(home, cache)
}

func cachedFor(home, host string) []string {
	cacheLock.Lock()
	defer cacheLock.Unlock()
	ips := []string{}
	for _, entry := range loadAddresses(home)[host] {
		ips = append(ips, entry.IP)
	}
	return ips
}

type dialResult struct {
	conn   *tls.Conn
	origin string
	host   string
	ip     string
	cached bool
	err    error
}

func tlsConfig(host string) *tls.Config {
	return &tls.Config{ServerName: host, NextProtos: []string{"http/1.1"}, RootCAs: rootCAs, MinVersion: tls.VersionTLS12}
}

func dialTLS(ctx context.Context, host, port, ip string) (*tls.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(ip, port))
	if err != nil {
		return nil, err
	}
	conn := tls.Client(raw, tlsConfig(host))
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}
	return conn, nil
}

// ordered puts IPv4 first: many networks hand out IPv6 addresses that do not route.
func ordered(ips []string) []string {
	sort.SliceStable(ips, func(i, j int) bool { return strings.Contains(ips[j], ":") && !strings.Contains(ips[i], ":") })
	return ips
}

func systemLookup(ctx context.Context, host string) []string {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil {
		return nil
	}
	return ordered(addresses)
}

// dohLookup asks the public resolvers at once (RFC 8484, GET) and returns the first non-empty answer.
func dohLookup(ctx context.Context, host string) []string {
	if len(dohServers) == 0 {
		return nil
	}
	name, err := dnsmessage.NewName(strings.TrimSuffix(host, ".") + ".")
	if err != nil {
		return nil
	}
	message := dnsmessage.Message{Header: dnsmessage.Header{RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}}}
	packed, err := message.Pack()
	if err != nil {
		return nil
	}
	query := base64.RawURLEncoding.EncodeToString(packed)
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	answers := make(chan []string, len(dohServers))
	for _, server := range dohServers {
		go func(server string) {
			answers <- askDoH(ctx, server, query)
		}(server)
	}
	for range dohServers {
		select {
		case ips := <-answers:
			if len(ips) > 0 {
				return ips
			}
		case <-ctx.Done():
			return nil
		}
	}
	return nil
}

func askDoH(ctx context.Context, server, query string) []string {
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{ServerName: server, RootCAs: rootCAs}, Proxy: nil}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+server+"/dns-query?dns="+query, nil)
	if err != nil {
		return nil
	}
	request.Header.Set("Accept", "application/dns-message")
	response, err := client.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil || response.StatusCode != http.StatusOK {
		return nil
	}
	var reply dnsmessage.Message
	if reply.Unpack(data) != nil {
		return nil
	}
	ips := []string{}
	for _, answer := range reply.Answers {
		if a, ok := answer.Body.(*dnsmessage.AResource); ok {
			ips = append(ips, net.IP(a.A[:]).String())
		}
	}
	return ips
}

func wait(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// connect races the origins' addresses and returns the first finished TLS handshake.
func connect(ctx context.Context, home string, origins []*url.URL) (dialResult, error) {
	ctx, cancel := context.WithCancel(ctx)
	results := make(chan dialResult, 64)
	var group sync.WaitGroup
	var lock sync.Mutex
	tried := map[string]bool{}
	launch := func(delay time.Duration, origin *url.URL, ip string, cached bool) {
		host, port := origin.Hostname(), origin.Port()
		if port == "" {
			port = "443"
		}
		lock.Lock()
		key := host + "|" + ip
		if tried[key] {
			lock.Unlock()
			return
		}
		tried[key] = true
		lock.Unlock()
		group.Add(1)
		go func() {
			defer group.Done()
			if !wait(ctx, delay) {
				return
			}
			conn, err := dialTLS(ctx, host, port, ip)
			results <- dialResult{conn: conn, origin: origin.Scheme + "://" + origin.Host, host: host, ip: ip, cached: cached, err: err}
		}()
	}
	for index, origin := range origins {
		origin, start := origin, time.Duration(index)*originStagger
		host := origin.Hostname()
		if net.ParseIP(host) != nil {
			launch(start, origin, host, false)
			continue
		}
		cached := cachedFor(home, host)
		for position, ip := range cached {
			launch(start+time.Duration(position)*200*time.Millisecond, origin, ip, true)
		}
		systemDone := make(chan bool, 1)
		group.Add(2)
		go func() {
			defer group.Done()
			delay := start
			if len(cached) > 0 {
				delay += dnsAfterCache
			}
			if !wait(ctx, delay) {
				systemDone <- false
				return
			}
			ips := systemLookup(ctx, host)
			systemDone <- len(ips) > 0
			for position, ip := range ips {
				launch(time.Duration(position)*150*time.Millisecond, origin, ip, false)
			}
		}()
		go func() {
			defer group.Done()
			// DNS over HTTPS when the system resolver has nothing, or after a while in any case: a poisoned
			// answer resolves fine but fails the handshake.
			deadline := time.Now().Add(start + dohAfter)
			timer := time.NewTimer(start + dohAfter)
			defer timer.Stop()
			select {
			case found := <-systemDone:
				if found && !wait(ctx, time.Until(deadline)) {
					return
				}
			case <-timer.C:
			case <-ctx.Done():
				return
			}
			for position, ip := range dohLookup(ctx, host) {
				launch(time.Duration(position)*150*time.Millisecond, origin, ip, false)
			}
		}()
	}
	go func() {
		group.Wait()
		close(results)
	}()
	var failures []string
	for result := range results {
		if result.err == nil {
			cancel()
			// Close the handshakes that finished after the winner.
			go func() {
				for late := range results {
					if late.conn != nil {
						_ = late.conn.Close()
					}
				}
			}()
			return result, nil
		}
		if ctx.Err() == nil {
			if result.cached {
				remember(home, result.host, result.ip, false)
			}
			failures = append(failures, fmt.Sprintf("%s (%s): %v", result.host, result.ip, scrubError(result.err)))
		}
	}
	cancel()
	if len(failures) == 0 {
		return dialResult{}, errors.New("no address found")
	}
	if len(failures) > 3 {
		failures = failures[:3]
	}
	return dialResult{}, errors.New(strings.Join(failures, "; "))
}

// scrubError keeps the reason ("connection refused", "certificate is valid for ...") and drops addresses.
func scrubError(err error) string {
	text := err.Error()
	if index := strings.LastIndex(text, ": "); index >= 0 {
		text = text[index+2:]
	}
	return text
}

func fetch(home string, input FetchRequest) FetchResponse {
	if input.TimeoutMs <= 0 {
		input.TimeoutMs = 20_000
	}
	if input.Method == "" {
		input.Method = http.MethodGet
	}
	if !strings.HasPrefix(input.Path, "/") {
		return FetchResponse{Error: "invalid path"}
	}
	origins := []*url.URL{}
	seen := map[string]bool{}
	for _, raw := range input.Origins {
		origin, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
		if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || (origin.Path != "" && origin.Path != "/") || seen[origin.Host] {
			continue
		}
		seen[origin.Host] = true
		origins = append(origins, origin)
		if len(origins) == 12 {
			break
		}
	}
	if len(origins) == 0 {
		return FetchResponse{Error: "no server address"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(input.TimeoutMs)*time.Millisecond)
	defer cancel()
	winner, err := connect(ctx, home, origins)
	if err != nil {
		return FetchResponse{Error: err.Error()}
	}
	used := false
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialTLSContext: func(context.Context, string, string) (net.Conn, error) {
			if used {
				return nil, errors.New("connection already used")
			}
			used = true
			return winner.conn, nil
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var body io.Reader
	if input.Body != "" {
		body = bytes.NewReader([]byte(input.Body))
	}
	request, err := http.NewRequestWithContext(ctx, input.Method, winner.origin+input.Path, body)
	if err != nil {
		_ = winner.conn.Close()
		return FetchResponse{Error: err.Error()}
	}
	for name, value := range input.Headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		_ = winner.conn.Close()
		return FetchResponse{Error: scrubError(err), Origin: winner.origin}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if err != nil {
		return FetchResponse{Error: scrubError(err), Origin: winner.origin}
	}
	if len(data) > maxBody {
		return FetchResponse{Error: "response too large", Origin: winner.origin}
	}
	if net.ParseIP(winner.host) == nil {
		remember(home, winner.host, winner.ip, true)
	}
	return FetchResponse{Status: response.StatusCode, Body: string(data), Origin: winner.origin}
}

// Fetch takes a FetchRequest as JSON and returns a FetchResponse as JSON (for gomobile and the Windows core).
func Fetch(home string, request string) string {
	var input FetchRequest
	var output FetchResponse
	if err := json.Unmarshal([]byte(request), &input); err != nil {
		output = FetchResponse{Error: "invalid request"}
	} else {
		output = fetch(home, input)
	}
	data, _ := json.Marshal(output)
	return string(data)
}
