import importlib.util
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

class NativeExpiry(unittest.TestCase):
    def test_kernel_guard_preserves_legacy_and_times_out_native_without_python(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.object(agent,"STATE_DIR",root),patch.object(agent,"command_succeeds",return_value=True),patch.object(agent,"run_fixed") as runner:
                agent.native_kernel_guard([{"allowedIps":["10.70.0.2/32"],"expiresAt":int(time.time())+60},{"allowedIps":["10.70.0.3/32"]},{"allowedIps":["10.70.0.4/32"],"expiresAt":1}])
                command=runner.call_args
                self.assertEqual(command.args[0],["iptables-restore","--noflush","--wait","5"])
                rules=command.kwargs["input_text"]
                self.assertIn("-s 10.70.0.2/32 -m time --datestop",rules)
                self.assertIn("-s 10.70.0.3/32 -j RETURN",rules)
                self.assertNotIn("10.70.0.4",rules)
                self.assertIn("-A NS_NATIVE_IN -j DROP",rules)
                self.assertIn("-A NS_NATIVE_OUT -j DROP",rules)
                self.assertTrue((root/"native-kernel-guard.enabled").exists())
                agent.native_kernel_guard([])
                self.assertIn("-j DROP",runner.call_args.kwargs["input_text"])

    def test_legacy_only_nodes_are_not_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(agent,"STATE_DIR",Path(directory)),patch.object(agent,"run_fixed") as runner:
                agent.native_kernel_guard([{"allowedIps":["10.70.0.2/32"]}])
                runner.assert_not_called()

    def test_broad_legacy_route_cannot_override_native_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(agent,"STATE_DIR",Path(directory)),patch.object(agent,"run_fixed") as runner:
                with self.assertRaises(ValueError):
                    agent.native_kernel_guard([{"allowedIps":["0.0.0.0/0"]},{"allowedIps":["10.70.0.2/32"],"expiresAt":int(time.time())+60}])
                runner.assert_not_called()

    def test_expiry_removes_live_and_persisted_peer_but_keeps_legacy(self):
        key = "A" * 43 + "="
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "northstar.conf"
            config.write_text(f"[Interface]\nListenPort = 51820\n[Peer]\nPublicKey = {key}\n# NorthstarExpiresAt={int(time.time())-1}\n[Peer]\nPublicKey = {'B'*43}=\n")
            with patch.object(agent,"STATE_DIR",root),patch.object(agent,"WIREGUARD_CONFIG",config),patch.object(agent,"command_succeeds",return_value=True),patch.object(agent,"run_fixed") as runner:
                agent.expire_native_peers()
                runner.assert_called_once_with(["wg","set","northstar","peer",key,"remove"])
                self.assertNotIn(key,config.read_text())
                self.assertIn("B"*43,config.read_text())
                agent.expire_native_peers()
                self.assertEqual(runner.call_count,1)

    def test_live_removal_failure_retains_key_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=root/"northstar.conf"
            original="[Interface]\n[Peer]\nPublicKey = "+"A"*43+"=\n# NorthstarExpiresAt=1\n"
            config.write_text(original)
            with patch.object(agent,"STATE_DIR",root),patch.object(agent,"WIREGUARD_CONFIG",config),patch.object(agent,"command_succeeds",return_value=True),patch.object(agent,"run_fixed",side_effect=subprocess.CalledProcessError(1,"wg")):
                with self.assertRaises(subprocess.CalledProcessError):agent.expire_native_peers()
                self.assertEqual(config.read_text(),original)

if __name__=="__main__":unittest.main()
