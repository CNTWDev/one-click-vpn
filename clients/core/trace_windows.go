//go:build windows

package core

import (
	"errors"
	"net/netip"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/metacubex/mihomo/component/dialer"
	"github.com/metacubex/mihomo/component/iface"
)

var (
	iphlpapi        = syscall.NewLazyDLL("iphlpapi.dll")
	icmpCreateFile  = iphlpapi.NewProc("IcmpCreateFile")
	icmpCloseHandle = iphlpapi.NewProc("IcmpCloseHandle")
	icmpSendEcho2Ex = iphlpapi.NewProc("IcmpSendEcho2Ex")
)

// ipOptionInformation is IP_OPTION_INFORMATION; Go's struct layout gives the same padding before the pointer.
type ipOptionInformation struct {
	TTL, TOS, Flags, OptionsSize uint8
	OptionsData                  uintptr
}

// icmpEchoReply is ICMP_ECHO_REPLY.
type icmpEchoReply struct {
	Address       [4]byte
	Status        uint32
	RoundTripTime uint32
	DataSize      uint16
	Reserved      uint16
	Data          uintptr
	Options       ipOptionInformation
}

const (
	ipSuccess            = 0
	ipDestHostUnreachble = 11003
	ipTTLExpiredTransit  = 11013
)

// tracePlatform on Windows: the ICMP helper API (what tracert uses), which needs no administrator rights. Each TTL
// waits in its own goroutine, all at once. The requests leave from the physical network's address (the interface
// the core's DIRECT outbound is bound to), so they do not enter the tunnel.
func tracePlatform(target netip.Addr, hops int, timeout time.Duration) ([]probeAnswer, error) {
	if err := iphlpapi.Load(); err != nil {
		return nil, err
	}
	var source [4]byte
	if name := dialer.DefaultInterface.Load(); name != "" {
		if i, err := iface.ResolveInterface(name); err == nil {
			if p, err := i.PickIPv4Addr(target); err == nil {
				source = p.Addr().As4()
			}
		}
	}
	dest := target.As4()
	var (
		mu      sync.Mutex
		answers []probeAnswer
		wg      sync.WaitGroup
		failed  error
	)
	data := []byte("veilbird")
	for ttl := 1; ttl <= hops; ttl++ {
		wg.Add(1)
		go func(ttl int) {
			defer wg.Done()
			h, _, err := icmpCreateFile.Call()
			if h == 0 || h == ^uintptr(0) {
				mu.Lock()
				failed = err
				mu.Unlock()
				return
			}
			defer icmpCloseHandle.Call(h)
			options := ipOptionInformation{TTL: uint8(ttl)}
			reply := make([]byte, int(unsafe.Sizeof(icmpEchoReply{}))+len(data)+64)
			started := time.Now()
			icmpSendEcho2Ex.Call(h, 0, 0, 0,
				uintptr(*(*uint32)(unsafe.Pointer(&source[0]))), uintptr(*(*uint32)(unsafe.Pointer(&dest[0]))),
				uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), uintptr(unsafe.Pointer(&options)),
				uintptr(unsafe.Pointer(&reply[0])), uintptr(len(reply)), uintptr(timeout/time.Millisecond))
			r := (*icmpEchoReply)(unsafe.Pointer(&reply[0]))
			from := netip.AddrFrom4(r.Address)
			if from.IsUnspecified() {
				return
			}
			switch r.Status {
			case ipSuccess, ipTTLExpiredTransit, ipDestHostUnreachble:
			default:
				return
			}
			mu.Lock()
			answers = append(answers, probeAnswer{ttl: ttl, from: from, rtt: time.Since(started), last: from == target})
			mu.Unlock()
		}(ttl)
		// A little spacing, as routers rate-limit their ICMP answers.
		time.Sleep(3 * time.Millisecond)
	}
	wg.Wait()
	if len(answers) == 0 && failed != nil {
		return nil, errors.New("icmp: " + failed.Error())
	}
	return answers, nil
}
