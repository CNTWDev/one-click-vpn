package core

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	C "github.com/metacubex/mihomo/constant"
	R "github.com/metacubex/mihomo/rules"
	RC "github.com/metacubex/mihomo/rules/common"
	RW "github.com/metacubex/mihomo/rules/wrapper"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/metacubex/mihomo/tunnel/statistic"
)

// Changes the apps make while connected, from the Activity view: the person's own rules take effect at once
// (no reconnect, the open connections stay), and single connections can be closed.

var liveRun struct {
	sync.Mutex
	options *Options
	mine    map[string]bool // the person's rules as the core matched them: "DOMAIN-SUFFIX,openai.com"
}

// rememberRun keeps the options a connection runs with, for SetRules and Activity's "mine".
func rememberRun(o Options) {
	liveRun.Lock()
	defer liveRun.Unlock()
	liveRun.options = &o
	liveRun.mine = mineOf(o.Rules)
}

func mineOf(lines []string) map[string]bool {
	mine := map[string]bool{}
	for _, line := range customRules(lines, "x") {
		// TYPE,value,target[,no-resolve]; Activity names both address families IP-CIDR, as mihomo reports them.
		if parts := strings.SplitN(line, ",", 3); len(parts) == 3 {
			mine[strings.Replace(parts[0], "IP-CIDR6", "IP-CIDR", 1)+","+parts[1]] = true
		}
	}
	return mine
}

// SetRules replaces the person's own rules (a JSON array of lines, as in Options.Rules) in the running
// configuration: new connections follow them at once. Open connections keep their route; the apps close the ones
// the change is about (CloseHost).
func SetRules(rulesJSON string) error {
	var lines []string
	if err := json.Unmarshal([]byte(rulesJSON), &lines); err != nil {
		return fmt.Errorf("rules: %w", err)
	}
	liveRun.Lock()
	if liveRun.options == nil {
		liveRun.Unlock()
		return fmt.Errorf("not running")
	}
	o := *liveRun.options
	liveRun.Unlock()
	o.Rules = lines
	parsed, err := buildRules(o)
	if err != nil {
		return err
	}
	tunnel.UpdateRules(parsed, nil, tunnel.RuleProviders())
	rememberRun(o)
	return nil
}

// buildRules builds the configuration for o and parses its rules the way mihomo's config does.
func buildRules(o Options) ([]C.Rule, error) {
	configuration, err := Build(o)
	if err != nil {
		return nil, err
	}
	var fields struct {
		Rules []string `json:"rules"`
	}
	if err := json.Unmarshal([]byte(configuration), &fields); err != nil {
		return nil, err
	}
	providers := tunnel.RuleProviders()
	parsed := make([]C.Rule, 0, len(fields.Rules))
	for _, line := range fields.Rules {
		tp, payload, target, params := RC.ParseRulePayload(line, true)
		rule, err := R.ParseRule(tp, payload, target, params, nil)
		if err != nil {
			return nil, fmt.Errorf("rule %q: %w", line, err)
		}
		for _, name := range rule.ProviderNames() {
			if _, ok := providers[name]; !ok {
				return nil, fmt.Errorf("rule %q: rule set %s not loaded", line, name)
			}
		}
		parsed = append(parsed, RW.NewRuleWrapper(rule))
	}
	return parsed, nil
}

// CloseConnection closes one open connection by the id Activity gives it.
func CloseConnection(id string) {
	if c := statistic.DefaultManager.Get(id); c != nil {
		_ = c.Close()
	}
}

// CloseHost closes the open connections to domain and, with site true, to its subdomains: after a rule
// change, so the person sees the new route without waiting for the old connections to end. It returns how many.
func CloseHost(domain string, site bool) int {
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	if domain == "" {
		return 0
	}
	closed := 0
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		name := strings.ToLower(host(c.Info().Metadata))
		if name == domain || (site && strings.HasSuffix(name, "."+domain)) {
			_ = c.Close()
			closed++
		}
		return true
	})
	return closed
}
