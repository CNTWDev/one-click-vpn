package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var installer = bytes.Repeat([]byte("TrackNothing installer "), 40000)

func digestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// fileServer serves body with Range support; breakAfter > 0 cuts the first full response after that many bytes.
func fileServer(t *testing.T, body []byte, breakAfter int, ranges *[]string) string {
	t.Helper()
	var first atomic.Bool
	first.Store(true)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ranges != nil {
			*ranges = append(*ranges, r.Header.Get("Range"))
		}
		if breakAfter > 0 && r.Header.Get("Range") == "" && first.Swap(false) {
			w.Header().Set("Content-Length", "999999999")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body[:breakAfter])
			w.(http.Flusher).Flush()
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
			return
		}
		http.ServeContent(w, r, "app.apk", time.Unix(0, 0), bytes.NewReader(body))
	}))
	t.Cleanup(server.Close)
	rootCAs = server.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
	saved, pause := dohServers, retryPause
	dohServers, retryPause = nil, 10*time.Millisecond
	t.Cleanup(func() { rootCAs, dohServers, retryPause = nil, saved, pause })
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	return "https://example.com:" + port
}

func runDownload(t *testing.T, home string, request DownloadRequest) DownloadStatus {
	t.Helper()
	data, _ := json.Marshal(request)
	var status DownloadStatus
	if err := json.Unmarshal([]byte(Download(home, string(data))), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestDownloadFallsBackFromMirrorToServerAndVerifies(t *testing.T) {
	origin := fileServer(t, installer, 0, nil)
	home := t.TempDir()
	remember(home, "example.com", "127.0.0.1", true)
	file := filepath.Join(t.TempDir(), "app.apk")
	status := runDownload(t, home, DownloadRequest{
		URLs: []string{"https://127.0.0.2:1/clients/app.apk"}, Origins: []string{origin}, Path: "/api/v1/client-releases/files/app.apk",
		File: file, SHA256: digestOf(installer), Size: int64(len(installer)),
	})
	if status.State != "done" || status.Source != "server" {
		t.Fatalf("status %+v", status)
	}
	if data, _ := os.ReadFile(file); !bytes.Equal(data, installer) {
		t.Fatal("file differs")
	}
}

func TestDownloadResumesBrokenTransfer(t *testing.T) {
	var ranges []string
	origin := fileServer(t, installer, 100000, &ranges)
	home := t.TempDir()
	remember(home, "example.com", "127.0.0.1", true)
	file := filepath.Join(t.TempDir(), "app.apk")
	status := runDownload(t, home, DownloadRequest{URLs: []string{origin + "/app.apk"}, File: file, SHA256: digestOf(installer), Size: int64(len(installer))})
	if status.State != "done" || status.Source != "mirror" {
		t.Fatalf("status %+v", status)
	}
	if len(ranges) != 2 || ranges[1] != "bytes=100000-" {
		t.Fatalf("ranges %q", ranges)
	}
	if data, _ := os.ReadFile(file); !bytes.Equal(data, installer) {
		t.Fatal("file differs")
	}
}

func TestDownloadRejectsWrongFileFromEverySource(t *testing.T) {
	origin := fileServer(t, installer, 0, nil)
	home := t.TempDir()
	remember(home, "example.com", "127.0.0.1", true)
	file := filepath.Join(t.TempDir(), "app.apk")
	status := runDownload(t, home, DownloadRequest{URLs: []string{origin + "/app.apk"}, Origins: []string{origin}, Path: "/app.apk",
		File: file, SHA256: strings.Repeat("0", 64), Size: int64(len(installer))})
	if status.State != "failed" || status.Error != "digest" {
		t.Fatalf("status %+v", status)
	}
	if _, err := os.Stat(file); err == nil {
		t.Fatal("a wrong file must not be kept")
	}
}

func TestDownloadReportsUnreachableAndCancel(t *testing.T) {
	_ = fileServer(t, installer, 0, nil)
	file := filepath.Join(t.TempDir(), "app.apk")
	status := runDownload(t, t.TempDir(), DownloadRequest{URLs: []string{"https://127.0.0.2:1/app.apk"}, File: file, SHA256: digestOf(installer), Size: int64(len(installer))})
	if status.State != "failed" || status.Error != "network" {
		t.Fatalf("status %+v", status)
	}
	if invalid := runDownload(t, t.TempDir(), DownloadRequest{URLs: []string{"http://example.com/app.apk"}, File: file, SHA256: digestOf(installer), Size: 1}); invalid.Error != "invalid" {
		t.Fatalf("status %+v", invalid)
	}
	// A server that accepts and never answers: the download waits until it is cancelled.
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = silent.Close() })
	go func() {
		for {
			if _, err := silent.Accept(); err != nil {
				return
			}
		}
	}()
	done := make(chan DownloadStatus)
	go func() {
		done <- runDownload(t, t.TempDir(), DownloadRequest{URLs: []string{"https://" + silent.Addr().String() + "/app.apk"}, File: file, SHA256: digestOf(installer), Size: int64(len(installer))})
	}()
	time.Sleep(50 * time.Millisecond)
	var progress DownloadStatus
	_ = json.Unmarshal([]byte(DownloadProgress()), &progress)
	if progress.State != "running" {
		t.Fatalf("progress %+v", progress)
	}
	CancelDownload()
	if status := <-done; status.State != "cancelled" {
		t.Fatalf("status %+v", status)
	}
}
