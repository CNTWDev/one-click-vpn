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

    def test_openvpn_routes_ipv6_to_server_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            config_path = state / "server.conf"
            bundle = {key: "test-material" for key in ("caCertificate", "serverCertificate", "serverPrivateKey", "tlsCryptKey")}
            real_write = agent.atomic_write
            def write(path, text, *args):
                if not str(path).startswith("/etc/"):
                    real_write(path, text, *args)
            with patch.object(agent, "OPENVPN_DIR", state), patch.object(agent, "OPENVPN_CONFIG", config_path), patch.object(agent, "OPENVPN_REVOKED_DIR", state / "revoked"), patch.object(agent, "request_node_secret", return_value=json.dumps(bundle)), patch.object(agent.shutil, "which", return_value="/usr/bin/openvpn"), patch.object(agent, "default_interface", return_value="eth0"), patch.object(agent, "replace_input_rule"), patch.object(agent, "run_fixed"), patch.object(agent, "atomic_write", side_effect=write):
                agent.openvpn_sync_config({"serverBundleSecretId": "server"})
            text = config_path.read_text()
            self.assertIn('push "redirect-gateway def1 ipv6 bypass-dhcp"', text)
            self.assertIn("server-ipv6 fd70:71::/64", text)
            self.assertIn("block-ipv6", text)
            self.assertIn("setenv opt disable-dco", text)

    def sync_fixture(self, old_users, new_users, api_output=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        state = Path(directory.name)
        old = agent.vless_config({"users": old_users}, BUNDLE, "93.184.215.14:443")
        path = state / "vless.json"
        path.write_text(json.dumps(old))
        patches = [patch.object(agent, "STATE_DIR", state), patch.object(agent, "VLESS_CONFIG", path),
                   patch.object(agent, "ensure_xray"), patch.object(agent, "validated_reality_target", return_value="93.184.215.14:443"),
                   patch.object(agent, "request_node_secret", side_effect=[json.dumps(BUNDLE), json.dumps(new_users)]),
                   patch.object(agent, "command_succeeds", return_value=True), patch.object(agent, "socket_listening", return_value=False),
                   patch.object(agent, "replace_input_rule")]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        real_write = agent.atomic_write
        def write(path, text, *args):
            if str(path).startswith("/etc/"):
                return
            real_write(path, text, *args)
        writer = patch.object(agent, "atomic_write", side_effect=write)
        writer.start()
        self.addCleanup(writer.stop)
        runner = patch.object(agent, "run_fixed", return_value=subprocess.CompletedProcess([], 0, api_output or ""))
        mocked = runner.start()
        self.addCleanup(runner.stop)
        agent.vless_sync_config({"usersSecretId": "users", "serverBundleSecretId": "server"})
        return mocked, json.loads(path.read_text())

    def test_unchanged_users_do_not_restart(self):
        mocked, _ = self.sync_fixture([{"id": USER}], [{"id": USER}])
        self.assertFalse(any("restart" in call.args[0] for call in mocked.call_args_list))

    def test_addition_uses_api_without_disconnecting_existing_users(self):
        second = "22345678-1234-4234-9234-123456789abc"
        mocked, config = self.sync_fixture([{"id": USER}], [{"id": USER}, {"id": second}], "Added 1 user(s) in total.\n")
        self.assertTrue(any("adu" in call.args[0] for call in mocked.call_args_list))
        self.assertFalse(any("restart" in call.args[0] for call in mocked.call_args_list))
        self.assertEqual(len(config["inbounds"][0]["settings"]["clients"]), 2)

    def test_revocation_restarts_to_close_established_sessions(self):
        mocked, config = self.sync_fixture([{"id": USER}], [])
        self.assertTrue(any("restart" in call.args[0] for call in mocked.call_args_list))
        self.assertEqual(config["inbounds"][0]["settings"]["clients"], [])

    def test_partial_api_failure_restarts_with_complete_desired_list(self):
        mocked, _ = self.sync_fixture([], [{"id": USER}], "Added 0 user(s) in total.\n")
        self.assertTrue(any("restart" in call.args[0] for call in mocked.call_args_list))

    def test_target_cache_expires_and_never_accepts_private_dns(self):
        agent.reality_target_cache.clear()
        with patch.object(agent, "reality_destination", side_effect=["1.1.1.1:443", "8.8.8.8:443"]), patch.object(agent.time, "monotonic", side_effect=[0, 30, 301, 301]):
            self.assertEqual(agent.validated_reality_target("www.example.com"), "1.1.1.1:443")
            self.assertEqual(agent.validated_reality_target("www.example.com"), "1.1.1.1:443")
            self.assertEqual(agent.validated_reality_target("www.example.com"), "8.8.8.8:443")
        agent.reality_target_cache.clear()

    @unittest.skipUnless(os.environ.get("NORTHSTAR_TEST_XRAY"), "optional pinned Xray binary")
    def test_real_xray_accepts_generated_config(self):
        config = agent.vless_config({"listenPort": 18443, "users": [{"id": USER}]}, BUNDLE, "93.184.215.14:443")
        with tempfile.TemporaryDirectory(prefix="northstar-xray-test-") as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config))
            result = subprocess.run([os.environ["NORTHSTAR_TEST_XRAY"], "run", "-test", "-config", str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.environ.get("NORTHSTAR_TEST_XRAY"), "optional pinned Xray binary")
    def test_real_xray_adds_users_without_process_restart(self):
        binary = os.environ["NORTHSTAR_TEST_XRAY"]
        config = agent.vless_config({"listenPort": 18443, "users": []}, BUNDLE, "93.184.215.14:443")
        with tempfile.TemporaryDirectory(prefix="northstar-xray-api-") as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config))
            process = subprocess.Popen([binary, "run", "-config", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    try:
                        with agent.socket.create_connection(("127.0.0.1", 10085), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.05)
                delta = Path(directory) / "users.json"
                inbound = config["inbounds"][0]
                inbound["settings"]["clients"] = [{"id": USER, "email": USER, "flow": "xtls-rprx-vision"}]
                delta.write_text(json.dumps({"inbounds": [inbound]}))
                result = subprocess.run([binary, "api", "adu", "--server=127.0.0.1:10085", str(delta)], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Added 1 user(s) in total.", result.stdout)
                self.assertIsNone(process.poll())
            finally:
                process.terminate()
                process.wait(timeout=5)

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
