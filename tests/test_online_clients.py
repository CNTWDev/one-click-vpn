import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import time
import unittest
import unittest.mock

os.environ.update(NORTHSTAR_CONTROLLER_URL="http://127.0.0.1", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

USER = "87654321-1234-4234-9234-123456789abc"
OTHER = "12345678-1234-4234-9234-123456789abc"


def done(stdout="", code=0):
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr="")


class OnlineClientTests(unittest.TestCase):
    def setUp(self):
        agent.stealth_addresses.clear()

    def test_hash_is_short_stable_and_never_the_address(self):
        value = agent.online_client_hash("203.0.113.7")
        self.assertRegex(value, r"^[0-9a-f]{16}$")
        self.assertEqual(value, agent.online_client_hash("203.0.113.7"))
        self.assertNotEqual(value, agent.online_client_hash("203.0.113.8"))
        self.assertNotIn("203", value)

    def test_xray_online_users_and_addresses(self):
        calls = []

        def run(command):
            calls.append(command)
            if "statsgetallonlineusers" in command:
                return done(json.dumps({"users": [f"user>>>{USER}>>>online", "user>>>not-a-uuid>>>online"]}))
            return done(json.dumps({"name": f"user>>>{USER}>>>online", "ips": {"203.0.113.7": 1700000000, "198.51.100.2": 1700000001}}))

        with tempfile.TemporaryDirectory() as directory, \
                unittest.mock.patch.object(agent, "XRAY_PATH", Path(directory) / "xray"), \
                unittest.mock.patch.object(agent, "VLESS_CONFIG", Path(directory) / "vless.json"), \
                unittest.mock.patch.object(agent, "run_optional", side_effect=run):
            (Path(directory) / "xray").write_text("")
            (Path(directory) / "vless.json").write_text("{}")
            clients = agent.vless_online_clients()
        self.assertEqual(clients, {USER: {agent.online_client_hash("203.0.113.7"), agent.online_client_hash("198.51.100.2")}})
        self.assertEqual(sum("statsonlineiplist" in command for command in calls), 1)

    def test_old_xray_without_online_stats_reports_nothing(self):
        with tempfile.TemporaryDirectory() as directory, \
                unittest.mock.patch.object(agent, "XRAY_PATH", Path(directory) / "xray"), \
                unittest.mock.patch.object(agent, "VLESS_CONFIG", Path(directory) / "vless.json"), \
                unittest.mock.patch.object(agent, "run_optional", return_value=done("unknown command", 1)):
            (Path(directory) / "xray").write_text("")
            (Path(directory) / "vless.json").write_text("{}")
            self.assertEqual(agent.vless_online_clients(), {})

    def test_stealth_addresses_merge_with_xray_and_expire(self):
        now = time.time()
        agent.stealth_addresses.update({USER: {"203.0.113.7": now, "192.0.2.1": now - 600}, OTHER: {"192.0.2.9": now - 600}})
        with unittest.mock.patch.object(agent, "vless_online_clients", return_value={USER: {agent.online_client_hash("203.0.113.7")}}):
            report = agent.online_clients()
        self.assertEqual(report, [{"identityKey": USER, "clients": [agent.online_client_hash("203.0.113.7")]}])
        self.assertNotIn(OTHER, agent.stealth_addresses)
        self.assertEqual(list(agent.stealth_addresses[USER]), ["203.0.113.7"])

    def test_vless_config_turns_on_online_stats(self):
        config = agent.vless_config({"listenPort": 443, "users": [{"id": OTHER, "email": USER}]},
                                    {"privateKey": "A" * 43, "shortId": "0123456789abcdef", "serverName": "www.example.com"}, "93.184.215.14:443")
        self.assertTrue(config["policy"]["levels"]["0"]["statsUserOnline"])

    def test_existing_config_gets_online_stats_once(self):
        with tempfile.TemporaryDirectory() as directory, \
                unittest.mock.patch.object(agent, "VLESS_CONFIG", Path(directory) / "vless.json"), \
                unittest.mock.patch.object(agent, "STATE_DIR", Path(directory)), \
                unittest.mock.patch.object(agent, "VLESS_RESTART_DUE", Path(directory) / "restart-due"), \
                unittest.mock.patch.object(agent, "run_fixed", return_value=done()):
            (Path(directory) / "vless.json").write_text(json.dumps({"policy": {"levels": {"0": {"statsUserUplink": True}}}}))
            self.assertTrue(agent.enable_vless_online_stats())
            self.assertTrue(json.loads((Path(directory) / "vless.json").read_text())["policy"]["levels"]["0"]["statsUserOnline"])
            self.assertTrue((Path(directory) / "restart-due").exists())
            self.assertFalse(agent.enable_vless_online_stats())


if __name__ == "__main__":
    unittest.main()
