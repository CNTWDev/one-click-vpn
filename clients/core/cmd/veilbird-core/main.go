// Command veilbird-core runs the embedded mihomo core as a child process of the desktop
// apps (Windows). The parent talks to it over stdin/stdout, one command per line, so no
// configuration with keys is written to disk and no local control port is opened. The core
// stops and exits when stdin closes, which also happens if the parent dies.
//
//	run <base64 options JSON>     -> ok | ok killswitch <message> | error <message> (see core.Options)
//	probe <names> <url> <ms>      -> name=delay,...
//	now <group>                   -> proxy name
//	rate                          -> up down (bytes per second)
//	stop                          -> ok
//	keypair                       -> <private> <public> (WireGuard, base64)
//	fetch <id> <base64 request>   -> fetch:<id> <response JSON>, possibly after later commands' replies
//	                                 (API call over every known origin, see core.Fetch)
//	killswitch on|off             -> ok | error <message> (block traffic outside the tun)
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	core "github.com/cntwdev/veilbird/clients/core"
	"golang.org/x/crypto/curve25519"
)

func main() {
	home := filepath.Join(os.TempDir(), "veilbird-core")
	if len(os.Args) == 3 && os.Args[1] == "-d" {
		home = os.Args[2]
	}
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 1<<20), 4<<20)
	output := bufio.NewWriter(os.Stdout)
	var writing sync.Mutex
	reply := func(line string) {
		writing.Lock()
		defer writing.Unlock()
		output.WriteString(strings.ReplaceAll(line, "\n", " ") + "\n")
		output.Flush()
	}
	for input.Scan() {
		fields := strings.Fields(input.Text())
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "run":
			if len(fields) != 2 {
				reply("error usage")
				continue
			}
			options, err := base64.StdEncoding.DecodeString(fields[1])
			if err == nil {
				err = core.Run(home, string(options))
			}
			if err != nil {
				reply("error " + err.Error())
			} else if err := applyKillSwitch(); err != nil {
				// The tunnel is up; the app reports that the kill switch could not be applied.
				reply("ok killswitch " + err.Error())
			} else {
				reply("ok")
			}
		case "fetch":
			// Answered when done, so a slow API call never holds up probes and rates.
			if len(fields) != 3 {
				continue
			}
			id, encoded := fields[1], fields[2]
			go func() {
				request, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil {
					reply("fetch:" + id + ` {"error":"invalid request"}`)
					return
				}
				reply("fetch:" + id + " " + core.Fetch(home, string(request)))
			}()
		case "killswitch":
			if len(fields) != 2 || (fields[1] != "on" && fields[1] != "off") {
				reply("error usage")
				continue
			}
			if err := setKillSwitch(fields[1] == "on"); err != nil {
				reply("error " + err.Error())
			} else {
				reply("ok")
			}
		case "probe":
			if len(fields) != 4 {
				reply("")
				continue
			}
			timeout, _ := strconv.Atoi(fields[3])
			reply(core.Probe(fields[1], fields[2], timeout))
		case "now":
			if len(fields) != 2 {
				reply("")
				continue
			}
			reply(core.Now(fields[1]))
		case "rate":
			reply(core.Rate())
		case "stop":
			core.Stop()
			reply("ok")
		case "keypair":
			private := make([]byte, 32)
			if _, err := rand.Read(private); err != nil {
				reply("error " + err.Error())
				continue
			}
			// Clamped as WireGuard expects.
			private[0] &= 248
			private[31] = (private[31] & 127) | 64
			public, err := curve25519.X25519(private, curve25519.Basepoint)
			if err != nil {
				reply("error " + err.Error())
				continue
			}
			reply(fmt.Sprintf("%s %s", base64.StdEncoding.EncodeToString(private), base64.StdEncoding.EncodeToString(public)))
		default:
			reply("error unknown command")
		}
	}
	core.Stop()
	_ = setKillSwitch(false)
}
