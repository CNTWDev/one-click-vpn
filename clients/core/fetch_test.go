package core

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(r.Method + " " + r.URL.Path + " " + r.Header.Get("X-Test")))
	}))
	t.Cleanup(server.Close)
	rootCAs = server.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
	saved := dohServers
	dohServers = nil
	t.Cleanup(func() { rootCAs, dohServers = nil, saved })
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	return server, port
}

func call(t *testing.T, home string, request FetchRequest) FetchResponse {
	t.Helper()
	data, _ := json.Marshal(request)
	var response FetchResponse
	if err := json.Unmarshal([]byte(Fetch(home, string(data))), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestFetchUsesFirstReachableOriginAndCachesAddress(t *testing.T) {
	_, port := testServer(t)
	home := t.TempDir()
	// The test certificate names example.com; localhost resolves through the system resolver.
	remember(home, "example.com", "127.0.0.1", true)
	response := call(t, home, FetchRequest{
		Origins: []string{"https://127.0.0.2:1", "https://example.com:" + port},
		Method:  "POST", Path: "/api/v2/native/login", Headers: map[string]string{"X-Test": "yes"}, Body: "{}", TimeoutMs: 8000,
	})
	if response.Error != "" || response.Status != http.StatusTeapot || response.Body != "POST /api/v2/native/login yes" {
		t.Fatalf("unexpected response %+v", response)
	}
	if response.Origin != "https://example.com:"+port {
		t.Fatalf("origin %q", response.Origin)
	}
	if got := cachedFor(home, "example.com"); len(got) != 1 || got[0] != "127.0.0.1" {
		t.Fatalf("cache %v", got)
	}
}

func TestFetchDropsFailingCachedAddressAndChecksCertificate(t *testing.T) {
	_, port := testServer(t)
	home := t.TempDir()
	remember(home, "example.com", "127.0.0.1", true)
	remember(home, "example.com", "127.0.0.3", true)
	// 127.0.0.3 is dialled first and refuses at once; 127.0.0.1 answers 200 ms later.
	response := call(t, home, FetchRequest{Origins: []string{"https://example.com:" + port}, Path: "/x", TimeoutMs: 8000})
	if response.Status != http.StatusTeapot {
		t.Fatalf("unexpected response %+v", response)
	}
	if got := cachedFor(home, "example.com"); len(got) != 1 || got[0] != "127.0.0.1" {
		t.Fatalf("failing address kept: %v", got)
	}
	// A name the certificate does not cover never gets a request, even at the right address.
	remember(home, "wrong.test", "127.0.0.1", true)
	response = call(t, home, FetchRequest{Origins: []string{"https://wrong.test:" + port}, Path: "/x", TimeoutMs: 3000})
	if response.Error == "" || response.Status != 0 {
		t.Fatalf("certificate not checked: %+v", response)
	}
}

func TestFetchRejectsBadInput(t *testing.T) {
	home := t.TempDir()
	for _, request := range []FetchRequest{
		{Origins: []string{"http://example.com"}, Path: "/x"},
		{Origins: []string{"https://user@example.com"}, Path: "/x"},
		{Origins: []string{"https://example.com"}, Path: "x"},
	} {
		if response := call(t, home, request); response.Error == "" {
			t.Fatalf("accepted %+v", request)
		}
	}
	if !strings.Contains(Fetch(home, "{"), "invalid request") {
		t.Fatal("bad JSON accepted")
	}
}
