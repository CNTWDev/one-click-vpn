package core

import (
	"net/netip"
	"strings"
)

// Custom routing rules (advanced): the person's own lines, kept on the device, ahead of smart routing. Each line is
// either a Clash rule ("DOMAIN-SUFFIX,example.com,Proxy") or a short form ("example.com, direct"); the apps
// parse the same way (Advanced.rules) to show how many lines count. '#' starts a comment.
const maxCustomRules = 2000

var customRuleTypes = map[string]bool{"DOMAIN": true, "DOMAIN-SUFFIX": true, "DOMAIN-KEYWORD": true, "IP-CIDR": true, "IP-CIDR6": true}

// customRules turns the lines into mihomo rules sending matches to target (the tunnel's group), DIRECT or REJECT;
// lines it cannot read are left out.
func customRules(lines []string, target string) []string {
	out := []string{}
	for _, line := range lines {
		if rule, ok := customRule(line, target); ok {
			out = append(out, rule)
			if len(out) == maxCustomRules {
				break
			}
		}
	}
	return out
}

func customRule(line, target string) (string, bool) {
	if i := strings.Index(line, "#"); i >= 0 {
		line = line[:i]
	}
	parts := []string{}
	for _, part := range strings.Split(line, ",") {
		if part = strings.TrimSpace(part); part != "" {
			parts = append(parts, part)
		}
	}
	var kind, value, policy string
	switch {
	case len(parts) >= 3 && customRuleTypes[strings.ToUpper(parts[0])]:
		kind, value, policy = strings.ToUpper(parts[0]), parts[1], parts[2]
	case len(parts) == 2:
		value, policy = parts[0], parts[1]
		switch {
		case strings.Contains(value, "/"):
			kind = "IP-CIDR"
		case strings.HasPrefix(value, "+."):
			kind, value = "DOMAIN-SUFFIX", value[2:]
		default:
			kind = "DOMAIN-SUFFIX"
		}
	default:
		return "", false
	}
	if value == "" || strings.ContainsAny(value, " \t") {
		return "", false
	}
	if kind == "IP-CIDR" || kind == "IP-CIDR6" {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return "", false
		}
		if prefix.Addr().Is6() {
			kind = "IP-CIDR6"
		} else {
			kind = "IP-CIDR"
		}
		value = prefix.Masked().String()
	} else {
		value = strings.ToLower(strings.TrimPrefix(value, "."))
		if value == "" {
			return "", false
		}
	}
	switch strings.ToUpper(policy) {
	case "DIRECT":
		policy = "DIRECT"
	case "REJECT", "BLOCK", "REJECT-DROP":
		policy = "REJECT"
	default:
		policy = target
	}
	rule := kind + "," + value + "," + policy
	if kind == "IP-CIDR" || kind == "IP-CIDR6" {
		rule += ",no-resolve"
	}
	return rule, true
}
