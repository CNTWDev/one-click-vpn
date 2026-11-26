//go:build !linux && !darwin && !windows

package core

import (
	"errors"
	"net/netip"
	"time"
)

func tracePlatform(target netip.Addr, hops int, timeout time.Duration) ([]probeAnswer, error) {
	return nil, errors.New("unsupported")
}
