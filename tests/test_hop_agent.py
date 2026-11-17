import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path
import unittest
import unittest.mock

os.environ.update(NORTHSTAR_CONTROLLER_URL="http://127.0.0.1", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

HOP = {"udpFrom": 20000, "udpTo": 29999, "udpTarget": 8443, "tcpPort": 24567, "tcpTarget": 443}


class FakeTables:
    """iptables -t nat stand-in: -S lists, -C/-I/-D edit, in the canonical form iptables prints."""

    def __init__(self, listening=""):
        self.rules = {"iptables": [], "ip6tables": []}
        self.listening = listening

    def canonical(self, args):
        # iptables -S adds nothing we parse beyond what we pass; keep the order we insert.
        return "-A " + " ".join(args)

    def __call__(self, command):
        tool = command[0]
        if tool == "ss":
            return subprocess.CompletedProcess(command, 0, self.listening, "")
        table = self.rules[tool]
        op, args = command[3], command[4:]
        if op == "-S":
            return subprocess.CompletedProcess(command, 0, "-P PREROUTING ACCEPT\n" + "\n".join(table) + "\n", "")
        line = self.canonical(args)
        if op == "-I":
            table.insert(0, line)
            return subprocess.CompletedProcess(command, 0, "", "")
        if op == "-D" and line in table:
            table.remove(line)
            return subprocess.CompletedProcess(command, 0, "", "")
        return subprocess.CompletedProcess(command, 1, "", "")


class HopTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.patches = [unittest.mock.patch.object(agent, "HOP_STATE", Path(self.dir.name) / "hop.json"),
                        unittest.mock.patch.object(agent, "STEALTH_DIR", Path(self.dir.name)),
                        unittest.mock.patch.object(agent.shutil, "which", return_value="/usr/sbin/x")]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.dir.cleanup()

    def test_wanted_rules_validate_input(self):
        self.assertEqual(agent.hop_wanted(HOP), [("udp", "20000:29999", 8443), ("tcp", "24567", 443)])
        self.assertEqual(agent.hop_wanted(None), [])
        # The target inside the range would redirect the listener to itself.
        self.assertEqual(agent.hop_wanted({**HOP, "udpTarget": 25000, "tcpPort": True}), [])
        self.assertEqual(agent.hop_wanted({"udpFrom": "20000; rm", "udpTo": 29999, "udpTarget": 8443}), [])

    def test_rules_only_match_local_traffic(self):
        rule = agent.hop_rule("udp", "20000:29999", 8443)
        self.assertIn("LOCAL", rule)
        self.assertEqual(rule[-3:], ["REDIRECT", "--to-ports", "8443"])

    def test_apply_adds_reports_and_removes(self):
        tables = FakeTables()
        with unittest.mock.patch.object(agent, "run_optional", side_effect=tables):
            agent.apply_hop(HOP)
            self.assertEqual(agent.hop_status, {"udp": "20000-29999", "tcp": 24567})
            self.assertEqual(len(tables.rules["iptables"]), 2)
            self.assertEqual(json.loads(agent.HOP_STATE.read_text()), HOP)
            # Idempotent: a second run (the minute check) adds nothing.
            agent.ensure_hop_rules()
            self.assertEqual(len(tables.rules["iptables"]), 2)
            # A changed spare port replaces the old rule.
            agent.apply_hop({**HOP, "tcpPort": 21000})
            self.assertEqual(len(tables.rules["iptables"]), 2)
            self.assertTrue(any("--dport 21000" in rule for rule in tables.rules["iptables"]))
            agent.apply_hop(None)
            self.assertEqual(tables.rules, {"iptables": [], "ip6tables": []})
            self.assertEqual(agent.hop_status, {"udp": None, "tcp": None})
            self.assertFalse(agent.HOP_STATE.exists())

    def test_program_in_range_blocks_new_rule_only(self):
        tables = FakeTables(listening="UNCONN 0 0 0.0.0.0:25000 0.0.0.0:*\n")
        with unittest.mock.patch.object(agent, "run_optional", side_effect=tables):
            agent.apply_hop(HOP)
            self.assertEqual(agent.hop_status["udp"], None)
            self.assertEqual(agent.hop_status["tcp"], 24567)


if __name__ == "__main__":
    unittest.main()
