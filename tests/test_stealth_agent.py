import importlib.util
import os
from pathlib import Path
import unittest
import unittest.mock

os.environ.update(NORTHSTAR_CONTROLLER_URL="http://127.0.0.1", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

SERVER = {"obfsPassword": "abcdefghijklmnopqrstuvwxyz012345", "certificate": "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n",
          "privateKey": "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n", "xhttpPath": "/AbCdEfGhIjKl"}
REALITY = {"privateKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "serverName": "www.example.com", "shortId": "0123456789abcdef"}
USER = {"id": "12345678-1234-4234-9234-123456789abc", "email": "87654321-1234-4234-9234-123456789abc"}


class StealthTests(unittest.TestCase):
    def test_listeners_share_port_users_and_reality_keys(self):
        config = agent.stealth_config({"listenPort": 8443}, SERVER, REALITY, [USER], "93.184.215.14:443")
        hysteria, xhttp = config["listeners"]
        self.assertEqual((hysteria["type"], xhttp["type"]), ("hysteria2", "vless"))
        self.assertEqual(hysteria["port"], xhttp["port"])
        # The telemetry identity names the user; the secret is only its password / UUID.
        self.assertEqual(hysteria["users"], {USER["email"]: USER["id"]})
        self.assertEqual(xhttp["users"], [{"username": USER["email"], "uuid": USER["id"], "flow": ""}])
        self.assertEqual(hysteria["obfs"], "salamander")
        self.assertEqual(xhttp["reality-config"]["server-names"], ["www.example.com"])
        self.assertEqual(xhttp["reality-config"]["dest"], "93.184.215.14:443")
        self.assertEqual(config["rules"][-1], "MATCH,DIRECT")
        self.assertIn("IP-CIDR,10.0.0.0/8,REJECT,no-resolve", config["rules"])

    def test_input_validation(self):
        bad = [
            ({"listenPort": 0}, SERVER, REALITY, [USER]),
            ({"listenPort": True}, SERVER, REALITY, [USER]),
            ({"listenPort": 8443}, {**SERVER, "obfsPassword": "short"}, REALITY, [USER]),
            ({"listenPort": 8443}, {**SERVER, "xhttpPath": "/../etc"}, REALITY, [USER]),
            ({"listenPort": 8443}, {**SERVER, "certificate": "none"}, REALITY, [USER]),
            ({"listenPort": 8443}, SERVER, {**REALITY, "shortId": "zz"}, [USER]),
            ({"listenPort": 8443}, SERVER, REALITY, [{"id": "shell; command", "email": USER["email"]}]),
        ]
        for desired, server, reality, users in bad:
            with self.assertRaises(ValueError):
                agent.stealth_config(desired, server, reality, users, "93.184.215.14:443")

    def test_capability_advertised_with_both_transports(self):
        if agent.platform.system() != "Linux" or agent.platform.machine() not in ("x86_64", "aarch64", "arm64"):
            self.skipTest("stealth is Linux amd64/arm64 only")
        with unittest.mock.patch.object(agent, "connectivity_snapshot", return_value={}):
            capabilities = agent.capabilities()
        self.assertIn("stealth", capabilities["protocols"])
        self.assertEqual(capabilities["transports"]["stealth"], ["udp", "tcp"])


if __name__ == "__main__":
    unittest.main()
