package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// App usage: the usage page's "by app" list. Unlike Activity (this connection only, memory only), it keeps bytes per
// program per local day for appUsageDays days in one small file in the core's home directory, so the list covers
// several connections. Only program names and byte counts are kept, never sites or addresses, and nothing leaves the
// device. Programs are known where mihomo can see them (Windows; Android and macOS give the tunnel no process).

const (
	appUsageFile    = "app-usage.json"
	appUsageDays    = 30
	appUsagePerDay  = 200 // programs per day; later new ones that day are not counted (bounded file)
	appUsageFlushes = 60  // samples (seconds) between writes while connected
)

// appDays is the file's content: local day (2006-01-02) -> program -> bytes.
type appDays map[string]map[string]*amount

type appUsageState struct {
	sync.Mutex
	home    string
	pending appDays
	ticks   int
}

var appUsage = &appUsageState{}

// count adds one sample's bytes for a program; called from Activity's sampler.
func (u *appUsageState) count(day, program string, delta int64, proxy bool) {
	if program == "" || delta <= 0 {
		return
	}
	u.Lock()
	defer u.Unlock()
	if u.pending == nil {
		u.pending = appDays{}
	}
	programs, ok := u.pending[day]
	if !ok {
		programs = map[string]*amount{}
		u.pending[day] = programs
	}
	if _, ok := programs[program]; !ok && len(programs) >= appUsagePerDay {
		return
	}
	add(programs, program, delta, proxy)
}

// tick writes pending counts every appUsageFlushes samples.
func (u *appUsageState) tick() {
	u.Lock()
	u.ticks++
	due := u.ticks >= appUsageFlushes
	if due {
		u.ticks = 0
	}
	u.Unlock()
	if due {
		u.flush()
	}
}

// begin sets where counts are written (the core's home); called when the core starts.
func (u *appUsageState) begin(home string) {
	u.flush()
	u.Lock()
	u.home = home
	u.ticks = 0
	u.Unlock()
}

// flush merges pending counts into the file, dropping days older than appUsageDays.
func (u *appUsageState) flush() {
	u.Lock()
	defer u.Unlock()
	if u.home == "" || len(u.pending) == 0 {
		return
	}
	days := readAppDays(u.home)
	for day, programs := range u.pending {
		saved, ok := days[day]
		if !ok {
			saved = map[string]*amount{}
			days[day] = saved
		}
		for program, value := range programs {
			entry, ok := saved[program]
			if !ok {
				if len(saved) >= appUsagePerDay {
					continue
				}
				entry = &amount{}
				saved[program] = entry
			}
			entry.Proxy += value.Proxy
			entry.Direct += value.Direct
		}
	}
	oldest := time.Now().AddDate(0, 0, -(appUsageDays - 1)).Format("2006-01-02")
	for day := range days {
		if day < oldest {
			delete(days, day)
		}
	}
	out, err := json.Marshal(days)
	if err != nil {
		return
	}
	path := filepath.Join(u.home, appUsageFile)
	if os.WriteFile(path+".tmp", out, 0o600) == nil && os.Rename(path+".tmp", path) == nil {
		u.pending = nil
	}
}

func readAppDays(home string) appDays {
	days := appDays{}
	if data, err := os.ReadFile(filepath.Join(home, appUsageFile)); err == nil {
		_ = json.Unmarshal(data, &days)
	}
	for day, programs := range days {
		if programs == nil {
			delete(days, day)
		}
	}
	return days
}

// AppUsage returns the programs that used the most traffic over the last days local days (1–30), as JSON
// [{name,bytes,proxy}] (proxy: most of it went through the tunnel), the top 10. It includes the running connection.
func AppUsage(home string, days int) string {
	if days < 1 || days > appUsageDays {
		days = appUsageDays
	}
	appUsage.flush()
	oldest := time.Now().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	total := map[string]*amount{}
	merge := func(source appDays) {
		for day, programs := range source {
			if day < oldest {
				continue
			}
			for program, value := range programs {
				entry, ok := total[program]
				if !ok {
					entry = &amount{}
					total[program] = entry
				}
				entry.Proxy += value.Proxy
				entry.Direct += value.Direct
			}
		}
	}
	merge(readAppDays(home))
	// Counts not yet written (a write failed) still show.
	appUsage.Lock()
	if appUsage.home == home {
		merge(appUsage.pending)
	}
	appUsage.Unlock()
	out, _ := json.Marshal(top(total, 10))
	return string(out)
}
