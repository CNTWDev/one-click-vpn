import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

os.environ.update(NORTHSTAR_CONTROLLER_URL="http://127.0.0.1", NORTHSTAR_NODE_ID="test", NORTHSTAR_AGENT_TOKEN="test")
spec = importlib.util.spec_from_file_location("agent", Path(__file__).resolve().parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class FakeKernel:
    """A /proc/sys tree that refuses writes when the kernel is read-only (a container)."""

    def __init__(self, root, bbr=True, writable=True):
        self.root, self.writable = root, writable
        defaults = {"net.ipv4.tcp_available_congestion_control": "reno cubic" + (" bbr" if bbr else ""),
                    "net.ipv4.tcp_congestion_control": "cubic", "net.core.default_qdisc": "fq_codel",
                    "net.core.rmem_max": "212992", "net.core.wmem_max": "212992", "net.ipv4.tcp_rmem": "4096\t131072\t6291456",
                    "net.ipv4.tcp_wmem": "4096\t16384\t4194304", "net.ipv4.tcp_slow_start_after_idle": "1", "net.ipv4.tcp_mtu_probing": "0"}
        for key, value in defaults.items():
            self.set(key, value)
        self.calls = []

    def set(self, key, value):
        path = self.root / key.replace(".", "/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value + "\n")

    def write(self, key, value):
        if not self.writable:
            raise PermissionError(key)
        self.calls.append(("write", key))
        self.set(key, value)

    def run(self, command):
        self.calls.append(command)

        class Done:
            returncode, stdout, stderr = 0, "", ""
        return Done()


class NetworkTuning(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.sys, self.conf, self.marker = root / "sys", root / "99-northstar-tuning.conf", root / "network-tuned"
        self.patches = [patch.object(agent, "SYSCTL_ROOT", self.sys), patch.object(agent, "TUNING_CONF", self.conf),
                        patch.object(agent, "TUNING_MARKER", self.marker), patch.object(agent, "tuning_attempted", False),
                        patch.object(agent.shutil, "which", lambda name: "/usr/sbin/" + name)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.directory.cleanup()

    def kernel(self, **options):
        kernel = FakeKernel(self.sys, **options)
        for name, value in (("run_optional", kernel.run), ("write_sysctl", kernel.write)):
            patcher = patch.object(agent, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        return kernel

    def test_untuned_node_reports_default(self):
        self.kernel()
        self.assertEqual(agent.network_tuning(), {"state": "default", "congestion": "cubic", "qdisc": "fq_codel", "udpBuffer": 212992})

    def test_sets_the_kernel_even_when_sysctl_d_is_read_only(self):
        self.kernel()
        with patch.object(agent, "atomic_write", side_effect=OSError("read-only file system")):
            self.assertEqual(agent.apply_network_tuning()["state"], "tuned")
        self.assertFalse(self.conf.exists())

    def test_applies_bbr_and_buffers_in_its_own_file(self):
        self.kernel()
        self.assertEqual(agent.apply_network_tuning()["state"], "tuned")
        text = self.conf.read_text()
        self.assertIn("net.ipv4.tcp_congestion_control = bbr", text)
        self.assertIn("net.core.rmem_max = 16777216", text)
        self.assertEqual(agent.read_sysctl("net.ipv4.tcp_rmem"), "4096 131072 16777216")

    def test_kernel_without_bbr_still_gets_buffers(self):
        kernel = self.kernel(bbr=False)
        self.assertEqual(agent.apply_network_tuning()["state"], "no-bbr")
        self.assertIn(["modprobe", "tcp_bbr"], kernel.calls)
        self.assertNotIn("bbr", self.conf.read_text())

    def test_read_only_kernel_is_unsupported(self):
        self.kernel(writable=False)
        self.assertEqual(agent.apply_network_tuning()["state"], "unsupported")

    def test_tuned_node_is_left_alone(self):
        kernel = self.kernel()
        agent.apply_network_tuning()
        kernel.calls.clear()
        agent.apply_network_tuning()
        self.assertFalse([call for call in kernel.calls if call[0] == "write"])

    def test_first_tuning_measures_before_and_after(self):
        self.kernel()
        states, reported = [], []
        with patch.object(agent, "run_speed_test", lambda kind: states.append((kind, agent.network_tuning()["state"])) or {"kind": kind}), \
                patch.object(agent, "report_speed_test", lambda result, test_id=None: reported.append(result["kind"])):
            agent.first_network_tuning()
            self.assertEqual(states, [("before", "default"), ("after", "tuned")])
            self.assertEqual(reported, ["before", "after"])
            self.assertTrue(self.marker.exists())
            states.clear()
            agent.first_network_tuning()
            self.assertEqual(states, [])

    def test_speed_test_refuses_a_second_run(self):
        with agent.speed_test_lock:
            self.assertEqual(agent.run_speed_test("manual"), {"kind": "manual", "error": "busy"})

    def test_speed_test_without_network_reports_an_error(self):
        self.kernel()
        with patch.object(agent, "speed_latency", lambda: None), patch.object(agent, "speed_direction", lambda upload: None):
            result = agent.run_speed_test("baseline")
        self.assertEqual((result["downMbps"], result["upMbps"]), (None, None))
        self.assertTrue(result["error"])


if __name__ == "__main__":
    unittest.main()


class SpeedDirection(unittest.TestCase):
    """Both directions against a local stand-in for the speed test service."""

    def setUp(self):
        import http.client
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                size = int(self.path.split("bytes=")[1])
                self.send_response(200)
                self.send_header("Content-Length", str(size))
                self.end_headers()
                block = b"x" * 65536
                try:
                    while size > 0:
                        self.wfile.write(block[:size])
                        size -= len(block)
                except OSError:
                    pass

            def do_POST(self):
                left = int(self.headers["Content-Length"])
                while left > 0:
                    data = self.rfile.read(min(left, 65536))
                    if not data:
                        break
                    left -= len(data)
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        port = self.server.server_address[1]
        self.patch = patch.object(agent, "speed_connection", lambda timeout=10: http.client.HTTPConnection("127.0.0.1", port, timeout=timeout))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.server.shutdown()

    def test_download_and_upload_report_mbps(self):
        with patch.object(agent, "SPEED_DOWN_CAP", 20 * 1024 * 1024), patch.object(agent, "SPEED_UP_CAP", 10 * 1024 * 1024):
            down = agent.speed_direction(False, seconds=2, streams=2)
            up = agent.speed_direction(True, seconds=2, streams=2)
        self.assertGreater(down, 0)
        self.assertGreater(up, 0)
