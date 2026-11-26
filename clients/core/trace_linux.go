//go:build linux

package core

import (
	"encoding/binary"
	"math/rand/v2"
	"net/netip"
	"time"

	"golang.org/x/sys/unix"
)

// tracePlatform on Android (and Linux): an unprivileged ICMP "ping" socket. Routers' "time exceeded" answers do not
// arrive as data on such a socket; with IP_RECVERR the kernel queues them as errors carrying the router's address
// and our original request. Android allows these sockets to every app, and the app itself is left out of the VPN,
// so the probes take the physical network.
func tracePlatform(target netip.Addr, hops int, timeout time.Duration) ([]probeAnswer, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK, unix.IPPROTO_ICMP)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	if err := unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_RECVERR, 1); err != nil {
		return nil, err
	}
	base := 1000 + rand.IntN(60000)
	sent := make([]time.Time, hops+1)
	to := &unix.SockaddrInet4{Addr: target.As4()}
	for ttl := 1; ttl <= hops; ttl++ {
		if unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_TTL, ttl) != nil {
			continue
		}
		sent[ttl] = time.Now()
		_ = unix.Sendto(fd, echoRequest(0, base+ttl), 0, to)
	}
	var answers []probeAnswer
	got := func(seq int, from netip.Addr, last bool) {
		if ttl := seq - base; ttl >= 1 && ttl <= hops && !sent[ttl].IsZero() {
			answers = append(answers, probeAnswer{ttl: ttl, from: from, rtt: time.Since(sent[ttl]), last: last})
		}
	}
	buf, oob := make([]byte, 1500), make([]byte, 512)
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 || traceDone(answers) {
			return answers, nil
		}
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN | unix.POLLERR}}
		if n, err := unix.Poll(fds, int(left/time.Millisecond)+1); err != nil && err != unix.EINTR {
			return answers, nil
		} else if n <= 0 {
			continue
		}
		// Routers' answers: the error queue.
		for {
			n, oobn, _, _, err := unix.Recvmsg(fd, buf, oob, unix.MSG_ERRQUEUE|unix.MSG_DONTWAIT)
			if err != nil {
				break
			}
			from, ok := offender(oob[:oobn])
			if !ok || n < 8 || buf[0] != 8 {
				continue
			}
			got(int(binary.BigEndian.Uint16(buf[6:8])), from, from == target)
		}
		// The target's own echo replies: ordinary data.
		for {
			n, _, err := unix.Recvfrom(fd, buf, unix.MSG_DONTWAIT)
			if err != nil {
				break
			}
			if seq, reply, ok := parseICMP(buf[:n], -1); ok && reply {
				got(seq, target, true)
			}
		}
	}
}

// offender reads the router's address from an IP_RECVERR control message (struct sock_extended_err followed by
// the sockaddr_in of the router that sent the ICMP error).
func offender(oob []byte) (netip.Addr, bool) {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return netip.Addr{}, false
	}
	for _, m := range msgs {
		if m.Header.Level != unix.IPPROTO_IP || m.Header.Type != unix.IP_RECVERR || len(m.Data) < 16+8 {
			continue
		}
		if m.Data[4] != unix.SO_EE_ORIGIN_ICMP {
			continue
		}
		sa := m.Data[16:]
		if binary.NativeEndian.Uint16(sa[0:2]) != unix.AF_INET {
			continue
		}
		return netip.AddrFrom4([4]byte(sa[4:8])), true
	}
	return netip.Addr{}, false
}
