import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.update(NORTHSTAR_CONTROLLER_URL="http://127.0.0.1", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

KEY = "A" * 43 + "="


class OfflineGrace(unittest.TestCase):
    def run_grace(self, contact, deadline, now, rejected=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "northstar.conf"
            config.write_text(f"[Interface]\nListenPort = 51820\n[Peer]\nPublicKey = {KEY}\nAllowedIPs = 10.70.0.2/32\n# NorthstarExpiresAt={deadline}\n")
            with patch.object(agent, "STATE_DIR", root), patch.object(agent, "WIREGUARD_CONFIG", config), \
                    patch.object(agent, "controller_contact", contact), patch.object(agent, "controller_rejected", rejected), \
                    patch.object(agent, "restore_native_kernel_guard") as guard:
                changed = agent.extend_native_leases_offline(now)
                stamp = int(config.read_text().split("NorthstarExpiresAt=")[1].split()[0])
                return changed, stamp, guard.call_count

    def test_reachable_controller_changes_nothing(self):
        now = time.time()
        self.assertEqual(self.run_grace(now - 30, int(now) + 60, now), (False, int(now) + 60, 0))

    def test_unreachable_controller_keeps_a_valid_lease_ahead(self):
        now = time.time()
        changed, stamp, guarded = self.run_grace(now - 600, int(now) + 60, now)
        self.assertTrue(changed)
        self.assertEqual(stamp, int(now) + 300)
        self.assertEqual(guarded, 1)

    def test_grace_ends_after_the_limit(self):
        now = time.time()
        contact = now - agent.NATIVE_OFFLINE_GRACE + 100
        changed, stamp, _ = self.run_grace(contact, int(now) + 60, now)
        self.assertTrue(changed)
        self.assertEqual(stamp, int(contact + agent.NATIVE_OFFLINE_GRACE))
        self.assertEqual(self.run_grace(now - agent.NATIVE_OFFLINE_GRACE - 10, int(now) + 60, now)[0], False)

    def test_expired_lease_and_refusal_are_not_extended(self):
        now = time.time()
        self.assertEqual(self.run_grace(now - 600, int(now) - 1, now)[0], False)
        self.assertEqual(self.run_grace(now - 600, int(now) + 60, now, rejected=True)[0], False)


class SelfUpgrade(unittest.TestCase):
    def test_rejects_malformed_requests_and_mismatched_source(self):
        with self.assertRaises(ValueError):
            agent.self_upgrade({"version": "agent 2.18.0; rm", "sha256": "0" * 64})
        with self.assertRaises(ValueError):
            agent.self_upgrade({"version": "agent 2.18.0", "sha256": "xyz"})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config.env").write_text("x")
            with patch.object(agent, "AGENT_DIR", root), patch.object(agent, "request_json", lambda path, payload: {"source": "print(1)\n"}):
                with self.assertRaises(RuntimeError):
                    agent.self_upgrade({"version": "agent 2.18.0", "sha256": "0" * 64})
                self.assertFalse((root / "upgrade.pending").exists())


if __name__ == "__main__":
    unittest.main()
