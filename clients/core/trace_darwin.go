//go:build darwin

package core

import (
	"math/rand/v2"
	"net/netip"
	"time"

	"golang.org/x/sys/unix"
)

// tracePlatform on macOS: the unprivileged ICMP datagram socket. Unlike Linux, it hands every ICMP message for
// this host to the socket (IP header included), routers' "time exceeded" answers too, so they are read as data and
// matched to our requests by the sequence number they quote. The core runs in the packet tunnel provider, whose
// own sockets do not go through the tunnel.
func tracePlatform(target netip.Addr, hops int, timeout time.Duration) ([]probeAnswer, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_ICMP)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	unix.CloseOnExec(fd)
	if err := unix.SetNonblock(fd, true); err != nil {
		return nil, err
	}
	id := rand.IntN(0xffff)
	base := 1000 + rand.IntN(60000)
	sent := make([]time.Time, hops+1)
	to := &unix.SockaddrInet4{Addr: target.As4()}
	for ttl := 1; ttl <= hops; ttl++ {
		if unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_TTL, ttl) != nil {
			continue
		}
		sent[ttl] = time.Now()
		_ = unix.Sendto(fd, echoRequest(id, base+ttl), 0, to)
	}
	var answers []probeAnswer
	buf := make([]byte, 1500)
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 || traceDone(answers) {
			return answers, nil
		}
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		if n, err := unix.Poll(fds, int(left/time.Millisecond)+1); err != nil && err != unix.EINTR {
			return answers, nil
		} else if n <= 0 {
			continue
		}
		for {
			n, sa, err := unix.Recvfrom(fd, buf, 0)
			if err != nil {
				break
			}
			in, ok := sa.(*unix.SockaddrInet4)
			if !ok {
				continue
			}
			seq, reply, ok := parseICMP(buf[:n], id)
			ttl := seq - base
			if !ok || ttl < 1 || ttl > hops || sent[ttl].IsZero() {
				continue
			}
			from := netip.AddrFrom4(in.Addr)
			answers = append(answers, probeAnswer{ttl: ttl, from: from, rtt: time.Since(sent[ttl]), last: reply && from == target})
		}
	}
}
