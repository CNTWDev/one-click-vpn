package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Download is how every app fetches its own update, so a slow or blocked path does not end in "update failed":
//
//   - Sources in order: the release's mirror URLs (a CDN) first, then the installer's path on the API origins,
//     raced like Fetch (cached addresses, DNS over HTTPS). Each source is dialled the same way as the API.
//   - A broken or stalled transfer resumes where it stopped (HTTP Range), on the same source or the next one;
//     every source serves the same immutable file.
//   - The finished file must have the published size and SHA-256 before it replaces File, whichever source
//     served it, so a mirror can make a download fail but never change what is installed.
//
// One download runs at a time. The apps poll DownloadProgress for the progress bar.

// DownloadRequest is one installer download.
type DownloadRequest struct {
	URLs    []string `json:"urls"`
	Origins []string `json:"origins"`
	Path    string   `json:"path"`
	File    string   `json:"file"`
	SHA256  string   `json:"sha256"`
	Size    int64    `json:"size"`
}

// DownloadStatus is the progress, and at the end the outcome. Seconds is -1 until the rate has settled.
// Error, when State is "failed": network (no source finished), digest (wrong file), storage (disk), invalid.
type DownloadStatus struct {
	State    string `json:"state"`
	Received int64  `json:"received"`
	Size     int64  `json:"size"`
	Rate     int64  `json:"rate"`
	Seconds  int64  `json:"seconds"`
	Source   string `json:"source,omitempty"`
	Error    string `json:"error,omitempty"`
	Detail   string `json:"detail,omitempty"`
}

const (
	maxDownload     = 1 << 30
	stallTimeout    = 20 * time.Second
	downloadRounds  = 3
	etaAfter        = 2 * time.Second
	rateSampleEvery = 500 * time.Millisecond
)

// retryPause is shortened by tests.
var retryPause = 2 * time.Second

type source struct {
	name    string
	origins []*url.URL
	path    string
}

type download struct {
	size     int64
	received atomic.Int64
	rate     atomic.Int64
	seconds  atomic.Int64
	source   atomic.Value
	cancel   context.CancelFunc
}

var (
	downloadLock sync.Mutex
	current      *download
	lastStatus   = DownloadStatus{State: "idle", Seconds: -1}
)

// stallConn fails a read that waits longer than stallTimeout, so a transfer that stops moving is retried.
type stallConn struct{ net.Conn }

func (c stallConn) Read(p []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(stallTimeout))
	return c.Conn.Read(p)
}

func parseOrigin(raw string) *url.URL {
	origin, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || (origin.Path != "" && origin.Path != "/") {
		return nil
	}
	origin.Path = ""
	return origin
}

func sources(input DownloadRequest) []source {
	list := []source{}
	for _, raw := range input.URLs {
		link, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || link.Scheme != "https" || link.Host == "" || link.User != nil || link.Fragment != "" || !strings.HasPrefix(link.EscapedPath(), "/") {
			continue
		}
		list = append(list, source{name: "mirror", origins: []*url.URL{{Scheme: "https", Host: link.Host}}, path: link.RequestURI()})
	}
	if strings.HasPrefix(input.Path, "/") {
		origins, seen := []*url.URL{}, map[string]bool{}
		for _, raw := range input.Origins {
			if origin := parseOrigin(raw); origin != nil && !seen[origin.Host] && len(origins) < 12 {
				seen[origin.Host] = true
				origins = append(origins, origin)
			}
		}
		if len(origins) > 0 {
			list = append(list, source{name: "server", origins: origins, path: input.Path})
		}
	}
	return list
}

// attempt continues the partial file from one source. It reports whether any bytes arrived.
func (d *download) attempt(ctx context.Context, home string, from source, part string) (bool, error) {
	dialContext, cancelDial := context.WithTimeout(ctx, 20*time.Second)
	winner, err := connect(dialContext, home, from.origins)
	cancelDial()
	if err != nil {
		return false, err
	}
	d.source.Store(from.name)
	used := false
	transport := &http.Transport{
		DisableKeepAlives:  true,
		DisableCompression: true,
		DialTLSContext: func(context.Context, string, string) (net.Conn, error) {
			if used {
				return nil, errors.New("connection already used")
			}
			used = true
			return stallConn{winner.conn}, nil
		},
	}
	defer transport.CloseIdleConnections()
	// Redirects would leave the dialled address; mirrors and the server answer directly.
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, winner.origin+from.path, nil)
	if err != nil {
		_ = winner.conn.Close()
		return false, err
	}
	offset := d.received.Load()
	request.Header.Set("Accept-Encoding", "identity")
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := client.Do(request)
	if err != nil {
		_ = winner.conn.Close()
		return false, errors.New(scrubError(err))
	}
	defer response.Body.Close()
	if net.ParseIP(winner.host) == nil {
		remember(home, winner.host, winner.ip, true)
	}
	switch {
	case response.StatusCode == http.StatusPartialContent && offset > 0:
		if !strings.HasPrefix(response.Header.Get("Content-Range"), fmt.Sprintf("bytes %d-", offset)) {
			return false, errors.New("unexpected range")
		}
	case response.StatusCode == http.StatusOK:
		offset = 0
		d.received.Store(0)
	case response.StatusCode == http.StatusRequestedRangeNotSatisfiable && offset == d.size:
		return false, nil
	default:
		return false, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	file, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return false, storageError{err}
	}
	defer file.Close()
	if err := file.Truncate(offset); err != nil {
		return false, storageError{err}
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return false, storageError{err}
	}
	buffer := make([]byte, 64<<10)
	progressed := false
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if d.received.Load()+int64(count) > d.size {
				return progressed, errors.New("larger than published")
			}
			if _, err := file.Write(buffer[:count]); err != nil {
				return progressed, storageError{err}
			}
			d.received.Add(int64(count))
			progressed = true
		}
		if readErr == io.EOF {
			return progressed, nil
		}
		if readErr != nil {
			return progressed, errors.New(scrubError(readErr))
		}
	}
}

type storageError struct{ error }

// sample keeps a smoothed rate and the time left, for the progress line.
func (d *download) sample(ctx context.Context) {
	ticker := time.NewTicker(rateSampleEvery)
	defer ticker.Stop()
	started, last, smoothed := time.Now(), d.received.Load(), 0.0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := d.received.Load()
		instant := float64(now-last) / rateSampleEvery.Seconds()
		if now < last {
			instant = 0
		}
		last = now
		if smoothed == 0 {
			smoothed = instant
		} else {
			smoothed = 0.25*instant + 0.75*smoothed
		}
		d.rate.Store(int64(smoothed))
		if smoothed >= 1 && time.Since(started) >= etaAfter {
			d.seconds.Store(int64(float64(d.size-now)/smoothed) + 1)
		} else {
			d.seconds.Store(-1)
		}
	}
}

func verify(part string, size int64, digest string) error {
	file, err := os.Open(part)
	if err != nil {
		return storageError{err}
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, file)
	if err != nil {
		return storageError{err}
	}
	if count != size || hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("digest")
	}
	return nil
}

func failed(d *download, code string, detail error) DownloadStatus {
	status := DownloadStatus{State: "failed", Received: d.received.Load(), Size: d.size, Seconds: -1, Error: code}
	if detail != nil {
		status.Detail = scrubError(detail)
	}
	return status
}

func run(ctx context.Context, home string, d *download, input DownloadRequest) DownloadStatus {
	list := sources(input)
	digest := strings.ToLower(input.SHA256)
	if input.File == "" || input.Size <= 0 || input.Size > maxDownload || len(digest) != 64 || len(list) == 0 {
		return failed(d, "invalid", nil)
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return failed(d, "invalid", nil)
	}
	part := input.File + ".part"
	// A partial file from an earlier attempt (same build: the name carries it) resumes.
	if info, err := os.Stat(part); err == nil && info.Size() <= input.Size {
		d.received.Store(info.Size())
	} else {
		_ = os.Remove(part)
	}
	var lastErr error
	fresh := false
	for round := 0; round < downloadRounds; {
		for index := 0; index < len(list); index++ {
			progressed, err := d.attempt(ctx, home, list[index], part)
			if ctx.Err() != nil {
				return DownloadStatus{State: "cancelled", Received: d.received.Load(), Size: d.size, Seconds: -1}
			}
			if err == nil && d.received.Load() == d.size {
				if verifyErr := verify(part, d.size, digest); verifyErr != nil {
					var storage storageError
					if errors.As(verifyErr, &storage) {
						return failed(d, "storage", verifyErr)
					}
					// A wrong file: start over once from the last source (the server's own copy), then give up.
					_ = os.Remove(part)
					d.received.Store(0)
					if fresh {
						return failed(d, "digest", nil)
					}
					fresh, index, round = true, len(list)-2, 0
					continue
				}
				if err := os.Rename(part, input.File); err != nil {
					return failed(d, "storage", err)
				}
				return DownloadStatus{State: "done", Received: d.size, Size: d.size, Seconds: 0, Source: d.source.Load().(string)}
			}
			var storage storageError
			if errors.As(err, &storage) {
				return failed(d, "storage", err)
			}
			if err != nil {
				lastErr = err
			}
			if progressed {
				// Moving again: stay on this source and do not count the break.
				index--
				round = 0
			}
		}
		round++
		if round < downloadRounds && !wait(ctx, time.Duration(round)*retryPause) {
			return DownloadStatus{State: "cancelled", Received: d.received.Load(), Size: d.size, Seconds: -1}
		}
	}
	return failed(d, "network", lastErr)
}

// Download takes a DownloadRequest as JSON, runs it to the end and returns the final DownloadStatus as JSON.
func Download(home string, request string) string {
	var input DownloadRequest
	if err := json.Unmarshal([]byte(request), &input); err != nil {
		data, _ := json.Marshal(DownloadStatus{State: "failed", Error: "invalid", Seconds: -1})
		return string(data)
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &download{size: input.Size, cancel: cancel}
	d.seconds.Store(-1)
	d.source.Store("")
	downloadLock.Lock()
	if current != nil {
		downloadLock.Unlock()
		cancel()
		data, _ := json.Marshal(DownloadStatus{State: "failed", Error: "busy", Seconds: -1})
		return string(data)
	}
	current = d
	downloadLock.Unlock()
	go d.sample(ctx)
	status := run(ctx, home, d, input)
	cancel()
	downloadLock.Lock()
	current, lastStatus = nil, status
	downloadLock.Unlock()
	data, _ := json.Marshal(status)
	return string(data)
}

// DownloadProgress returns the running download's DownloadStatus as JSON, or the last outcome.
func DownloadProgress() string {
	downloadLock.Lock()
	d, status := current, lastStatus
	downloadLock.Unlock()
	if d != nil {
		source, _ := d.source.Load().(string)
		status = DownloadStatus{State: "running", Received: d.received.Load(), Size: d.size, Rate: d.rate.Load(), Seconds: d.seconds.Load(), Source: source}
	}
	data, _ := json.Marshal(status)
	return string(data)
}

// CancelDownload stops the running download. Its partial file stays, so the next Download resumes.
func CancelDownload() {
	downloadLock.Lock()
	defer downloadLock.Unlock()
	if current != nil {
		current.cancel()
	}
}
