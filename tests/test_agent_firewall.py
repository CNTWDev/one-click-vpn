import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
import unittest.mock

os.environ.update(NORTHSTAR_CONTROLLER_URL="https://api.example", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


def completed(returncode=0, stdout=""):
    return subprocess.CompletedProcess([], returncode, stdout, "")


class FirewallManagerTests(unittest.TestCase):
    def run_with(self, manager_output):
        calls = []
        def optional(command):
            calls.append(command)
            if command[:2] == ["firewall-cmd", "--state"]:
                return completed(0 if manager_output == "firewalld" else 1)
            if command[:2] == ["ufw", "status"]:
                return completed(0, "Status: active\n" if manager_output == "ufw" else "Status: inactive\n")
            if command[:2] == ["iptables", "-C"]:
                return completed(1)
            return completed(1)
        fixed = []
        with unittest.mock.patch.object(agent.shutil, "which", lambda name: "/usr/sbin/" + name), \
             unittest.mock.patch.object(agent, "run_optional", optional), \
             unittest.mock.patch.object(agent, "run_fixed", lambda command, **_: fixed.append(command) or completed()):
            agent.replace_input_rule("northstar-stealth-udp", ("udp", 9443), ("udp", 8443))
        return fixed

    def test_firewalld_opens_runtime_and_permanent_and_closes_the_old_port(self):
        fixed = self.run_with("firewalld")
        self.assertIn(["firewall-cmd", "--remove-port=9443/udp"], fixed)
        self.assertIn(["firewall-cmd", "--add-port=8443/udp"], fixed)
        self.assertIn(["firewall-cmd", "--permanent", "--add-port=8443/udp"], fixed)

    def test_ufw_allows_the_port(self):
        fixed = self.run_with("ufw")
        self.assertIn(["ufw", "allow", "8443/udp"], fixed)
        self.assertIn(["ufw", "--force", "delete", "allow", "9443/udp"], fixed)

    def test_plain_iptables_only(self):
        fixed = self.run_with(None)
        self.assertTrue(any(command[:2] == ["iptables", "-I"] for command in fixed))
        self.assertFalse(any(command[0] in ("ufw", "firewall-cmd") for command in fixed))


class PortCheckTests(unittest.TestCase):
    def test_counts_marker_packets_and_removes_the_rules(self):
        rules = {}
        def optional(command):
            tool, table, operation = command[0], command[2], command[3]
            key = (tool, table, tuple(command[4:]))
            if operation == "-I":
                if table == "raw" and tool == "ip6tables":
                    return completed(1)  # no raw table: falls back to mangle
                rules[key] = True
                return completed()
            if operation == "-D":
                return completed(0 if rules.pop(key, None) else 1)
            if operation == "-nvxL":
                lines = ["Chain PREROUTING (policy ACCEPT 0 packets, 0 bytes)", "    pkts      bytes target prot opt in out source destination"]
                for (rule_tool, rule_table, rule) in rules:
                    if rule_tool == tool and rule_table == table:
                        packets = 7 if "udp" in rule and tool == "iptables" else 0
                        lines.append(f"{packets:>8} {packets * 900:>8}            udp  --  *  *  0.0.0.0/0  0.0.0.0/0  udp dpt:51820 length 928 /* {rule[-1]} */")
                return completed(0, "\n".join(lines))
            return completed(1)
        with unittest.mock.patch.object(agent.shutil, "which", lambda name: "/usr/sbin/" + name), \
             unittest.mock.patch.object(agent, "run_optional", optional):
            outcome = agent.run_port_check({"id": "c1", "length4": 928, "length6": 948, "ports": [{"transport": "udp", "port": 51820}, {"transport": "tcp", "port": 443}, {"transport": "udp", "port": "x"}]}, wait=lambda _: None)
        self.assertEqual(outcome["results"], [{"transport": "udp", "port": 51820, "packets": 7}, {"transport": "tcp", "port": 443, "packets": 0}])
        self.assertEqual(rules, {})
        self.assertEqual(outcome["error"], "")


if __name__ == "__main__":
    unittest.main()
