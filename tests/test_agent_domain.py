import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import unittest.mock

os.environ.update(NORTHSTAR_CONTROLLER_URL="https://api.old.example", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentDomainTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.config = Path(self.dir.name) / "config.env"
        self.config.write_text("NORTHSTAR_CONTROLLER_URL=https://api.old.example\nNORTHSTAR_NODE_ID=test\n")
        agent.CONTROLLER = "https://api.old.example"
        agent.controller_switch_retry_at = 0
        self.patches = [unittest.mock.patch.object(agent, "CONFIG_ENV", self.config),
                        unittest.mock.patch.object(agent, "capabilities", lambda: {})]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.dir.cleanup()

    def test_switches_only_after_heartbeat_on_new_domain(self):
        seen = []
        with unittest.mock.patch.object(agent, "request_json", lambda path, payload: seen.append(agent.CONTROLLER + path) or {"ok": True}):
            self.assertTrue(agent.adopt_controller_origin("https://agent.new.example/"))
        self.assertEqual(seen, ["https://agent.new.example/api/v1/agent/heartbeat"])
        self.assertEqual(agent.CONTROLLER, "https://agent.new.example")
        self.assertEqual(self.config.read_text(), "NORTHSTAR_CONTROLLER_URL=https://agent.new.example\nNORTHSTAR_NODE_ID=test\n")

    def test_unreachable_domain_keeps_old_one_and_waits_before_retrying(self):
        def fail(path, payload):
            raise OSError("connection refused")
        with unittest.mock.patch.object(agent, "request_json", fail):
            with self.assertRaises(RuntimeError):
                agent.adopt_controller_origin("https://agent.new.example")
            self.assertFalse(agent.adopt_controller_origin("https://agent.new.example"))
        self.assertEqual(agent.CONTROLLER, "https://api.old.example")
        self.assertIn("https://api.old.example", self.config.read_text())

    def test_ignores_same_or_invalid_origins(self):
        with unittest.mock.patch.object(agent, "request_json", lambda path, payload: self.fail("must not call")):
            for value in (None, "", "https://api.old.example", "http://agent.new.example", "https://agent.new.example/path", "https://a b"):
                self.assertFalse(agent.adopt_controller_origin(value))


if __name__ == "__main__":
    unittest.main()
