package main

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/cntwdev/veilbird/clients/core/internal/wfp"
)

// Kill switch: while on, Windows lets traffic out only through the TrackNothing tun, from this core
// (it dials the nodes) and from the app next to it. Rules are re-applied after every run, since the tun
// may come back with a new LUID; they stay in place between runs so a transport switch leaks nothing.
var killSwitch struct {
	sync.Mutex
	on bool
}

// applyKillSwitch runs after every successful run.
func applyKillSwitch() error {
	killSwitch.Lock()
	defer killSwitch.Unlock()
	return enforce()
}

// setKillSwitch turns the rules on or off. On before the tun exists only records the choice.
func setKillSwitch(on bool) error {
	killSwitch.Lock()
	defer killSwitch.Unlock()
	killSwitch.on = on
	if !on {
		wfp.DisableFirewall()
		return nil
	}
	if _, err := wfp.InterfaceLUID("TrackNothing"); err != nil {
		return nil
	}
	return enforce()
}

func enforce() error {
	if !killSwitch.on {
		return nil
	}
	luid, err := wfp.InterfaceLUID("TrackNothing")
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	apps := []string{self}
	if app := filepath.Join(filepath.Dir(self), "Veilbird.exe"); fileExists(app) {
		apps = append(apps, app)
	}
	wfp.DisableFirewall()
	return wfp.EnableFirewall(luid, false, nil, apps)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
