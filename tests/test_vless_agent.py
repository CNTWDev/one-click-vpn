import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.update(NORTHSTAR_CONTROLLER_URL="http://127.0.0.1", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

BUNDLE = {"privateKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "serverName": "www.example.com", "shortId": "0123456789abcdef"}
USER = "12345678-1234-4234-9234-123456789abc"

class VlessTests(unittest.TestCase):
    def test_structure_and_secrets(self):
        config = agent.vless_config({"listenPort": 8443, "users": [{"id": USER}]}, BUNDLE, "93.184.215.14:443")
        self.assertEqual(config["inbounds"][0]["settings"]["clients"][0]["id"], USER)
        self.assertEqual(config["inbounds"][1]["listen"], "127.0.0.1")
        self.assertEqual(config["log"]["access"], "none")
        self.assertEqual(config["outbounds"][1]["protocol"], "blackhole")

    def test_input_validation(self):
        for desired in ({"listenPort": 10085}, {"listenPort": 0}, {"users": [{"id": "shell; command"}]}):
            with self.assertRaises(ValueError):
                agent.vless_config(desired, BUNDLE, "93.184.215.14:443")
        for name in ("localhost", "http://example.com", "a.example.com\n"):
            with self.assertRaises(ValueError):
                agent.reality_destination(name)
        with patch.object(agent.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("127.0.0.1", 443))]):
            with self.assertRaises(ValueError):
                agent.reality_destination("internal.example.com")

    def test_statistics_are_cumulative_and_per_user(self):
        stats = {"stat": [{"name": f"user>>>{USER}>>>traffic>>>uplink", "value": "100"}, {"name": f"user>>>{USER}>>>traffic>>>downlink", "value": "500"}]}
        with patch.object(Path, "exists", return_value=True), patch.object(agent, "run_optional", side_effect=[subprocess.CompletedProcess([],0,json.dumps(stats)), subprocess.CompletedProcess([],0,"invocation-1\n")]):
            self.assertEqual(agent.vless_usage_snapshots(), [{"protocol": "vless", "identityKey": USER, "rxBytes": 100, "txBytes": 500, "counterEpoch": "invocation-1"}])

    @unittest.skipUnless(os.environ.get("NORTHSTAR_TEST_XRAY"), "optional pinned Xray binary")
    def test_real_xray_accepts_generated_config(self):
        config = agent.vless_config({"listenPort": 18443, "users": [{"id": USER}]}, BUNDLE, "93.184.215.14:443")
        with tempfile.TemporaryDirectory(prefix="northstar-xray-test-") as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config))
            result = subprocess.run([os.environ["NORTHSTAR_TEST_XRAY"], "run", "-test", "-config", str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.environ.get("NORTHSTAR_TEST_REALITY_E2E") and os.environ.get("NORTHSTAR_TEST_XRAY") and os.environ.get("NORTHSTAR_TEST_MIHOMO"), "optional public-network REALITY handshake test")
    def test_mihomo_connects_through_real_xray(self):
        key_result = subprocess.run([os.environ["NORTHSTAR_TEST_XRAY"], "x25519", "-i", BUNDLE["privateKey"]], capture_output=True, text=True, check=True)
        fields = dict(line.split(": ", 1) for line in key_result.stdout.splitlines() if ": " in line)
        public_key = fields.get("Password (PublicKey)") or fields.get("Password") or fields.get("PublicKey") or fields.get("Public key")
        self.assertTrue(public_key)
        bundle = {**BUNDLE, "serverName": "www.cloudflare.com"}
        target = agent.reality_destination(bundle["serverName"])
        server_config = agent.vless_config({"listenPort": 18443, "users": [{"id": USER}]}, bundle, target)
        client_config = {"mixed-port": 18080, "allow-lan": False, "mode": "rule", "log-level": "silent", "proxies": [{
            "name": "test", "type": "vless", "server": "127.0.0.1", "port": 18443, "uuid": USER, "network": "tcp", "tls": True,
            "flow": "xtls-rprx-vision", "servername": bundle["serverName"], "client-fingerprint": "chrome",
            "reality-opts": {"public-key": public_key, "short-id": bundle["shortId"]},
        }], "rules": ["MATCH,test"]}
        with tempfile.TemporaryDirectory(prefix="northstar-reality-e2e-") as directory:
            server_path, client_path = Path(directory)/"server.json", Path(directory)/"client.json"
            server_path.write_text(json.dumps(server_config)); client_path.write_text(json.dumps(client_config))
            processes = []
            try:
                processes.append(subprocess.Popen([os.environ["NORTHSTAR_TEST_XRAY"], "run", "-config", str(server_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
                processes.append(subprocess.Popen([os.environ["NORTHSTAR_TEST_MIHOMO"], "-d", directory, "-f", str(client_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
                for _ in range(30):
                    try:
                        with agent.socket.create_connection(("127.0.0.1",18080),timeout=.2): break
                    except OSError: time.sleep(.1)
                response = subprocess.run(["curl", "-fsS", "--noproxy", "", "--proxy", "http://127.0.0.1:18080", "--connect-timeout", "10", "--max-time", "25", "https://example.com/"], capture_output=True, text=True)
                self.assertEqual(response.returncode,0,response.stderr)
                self.assertIn("Example Domain",response.stdout)
                stats = subprocess.run([os.environ["NORTHSTAR_TEST_XRAY"], "api", "statsquery", "--server=127.0.0.1:10085", "-pattern", "user>>>"], capture_output=True, text=True, check=True)
                self.assertTrue(any(int(item.get("value",0))>0 for item in json.loads(stats.stdout).get("stat",[])))
            finally:
                for process in processes: process.terminate()
                for process in processes:
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == "__main__":
    unittest.main()
