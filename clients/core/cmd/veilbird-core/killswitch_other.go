//go:build !windows

package main

import "errors"

func applyKillSwitch() error { return nil }

func setKillSwitch(on bool) error {
	if on {
		return errors.New("kill switch is Windows only")
	}
	return nil
}
