#!/usr/bin/env python3
"""Northstar outbound edge agent.

The agent accepts only structured reconcile tasks. It never executes a command
received from the controller and it never sends a private key to the controller.
The first enabled data-plane task is ApplyWireGuardPeers.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


CONTROLLER = os.environ["NORTHSTAR_CONTROLLER_URL"].rstrip("/")
NODE_ID = os.environ["NORTHSTAR_NODE_ID"]
TOKEN = os.environ["NORTHSTAR_AGENT_TOKEN"]
STATE_DIR = Path(os.environ.get("NORTHSTAR_AGENT_STATE_DIR", "/opt/northstar-agent/state"))
WIREGUARD_DIR = STATE_DIR / "wireguard"
WIREGUARD_KEY = WIREGUARD_DIR / "server.key"
WIREGUARD_CONFIG = WIREGUARD_DIR / "northstar.conf"
KEY_PATTERN = re.compile(r"^[A-Za-z0-9+/]{42}={0,2}$")
last_cpu_sample = None
last_network_sample = None
last_error_message = ""
last_error_logged_at = 0


def log_failure(operation, error):
    """Write actionable, rate-limited errors to the systemd journal.

    A node must never silently disappear from the Controller.  The same failure
    is logged at most once a minute, while a changed failure is logged
    immediately so a journal remains useful without becoming noisy.
    """
    global last_error_message, last_error_logged_at
    message = f"northstar-agent {operation} failed: {error}"
    now = time.time()
    if message != last_error_message or now - last_error_logged_at >= 60:
        print(message, file=sys.stderr, flush=True)
        last_error_message = message
        last_error_logged_at = now


def request_json(path, payload):
    request = urllib.request.Request(
        CONTROLLER + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read()
        return json.loads(raw.decode() or "{}")


def run_fixed(command, *, input_text=None):
    return subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
    )


def wireguard_public_key():
    if not WIREGUARD_KEY.exists() or shutil.which("wg") is None:
        return ""
    try:
        result = run_fixed(["wg", "pubkey"], input_text=WIREGUARD_KEY.read_text())
        return result.stdout.strip()
    except Exception:
        return ""


def validate_key(value):
    return isinstance(value, str) and bool(KEY_PATTERN.fullmatch(value))


def default_interface():
    if shutil.which("ip") is None:
        raise RuntimeError("iproute2 is not installed")
    result = run_fixed(["ip", "-4", "route", "show", "default"])
    match = re.search(r"(?:^|\s)dev\s+(\S+)", result.stdout)
    if not match:
        raise RuntimeError("default network interface was not found")
    return match.group(1)


def ensure_wireguard_key():
    WIREGUARD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not WIREGUARD_KEY.exists():
        if shutil.which("wg") is None:
            raise RuntimeError("wireguard-tools is not installed")
        private_key = run_fixed(["wg", "genkey"]).stdout.strip()
        if not validate_key(private_key):
            raise RuntimeError("wg genkey returned an invalid key")
        WIREGUARD_KEY.write_text(private_key + "\n")
        os.chmod(WIREGUARD_KEY, 0o600)
    return WIREGUARD_KEY.read_text().strip()


def wireguard_sync_config(desired):
    if desired.get("interface") != "northstar":
        raise ValueError("only the northstar interface is allowed")
    if shutil.which("wg") is None or shutil.which("wg-quick") is None:
        raise RuntimeError("wireguard-tools is not installed")
    listen_port = int(desired.get("listenPort", 51820))
    if listen_port < 1 or listen_port > 65535:
        raise ValueError("invalid WireGuard listen port")
    private_key = ensure_wireguard_key()
    peers = desired.get("peers", [])
    if not isinstance(peers, list) or len(peers) > 4096:
        raise ValueError("invalid WireGuard peer list")
    egress_interface = default_interface()

    full_lines = [
        "[Interface]",
        f"PrivateKey = {private_key}",
        "Address = 10.70.0.1/24",
        f"ListenPort = {listen_port}",
        "SaveConfig = false",
        "PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -o " + egress_interface + " -j MASQUERADE",
        "PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -o " + egress_interface + " -j MASQUERADE",
        "",
    ]
    sync_lines = [
        "[Interface]",
        f"PrivateKey = {private_key}",
        f"ListenPort = {listen_port}",
        "",
    ]
    for peer in peers:
        if not isinstance(peer, dict) or not validate_key(peer.get("publicKey")):
            raise ValueError("invalid WireGuard peer public key")
        allowed_ips = peer.get("allowedIps", [])
        if not isinstance(allowed_ips, list) or not allowed_ips or any(not isinstance(item, str) or len(item) > 64 for item in allowed_ips):
            raise ValueError("invalid WireGuard peer allowed IPs")
        keepalive = int(peer.get("persistentKeepaliveSeconds", 25))
        if keepalive < 0 or keepalive > 65535:
            raise ValueError("invalid WireGuard keepalive")
        peer_lines = [
            "[Peer]",
            f"PublicKey = {peer['publicKey']}",
            f"AllowedIPs = {', '.join(allowed_ips)}",
        ]
        if keepalive:
            peer_lines.append(f"PersistentKeepalive = {keepalive}")
        full_lines.extend(peer_lines + [""])
        sync_lines.extend(peer_lines + [""])

    WIREGUARD_CONFIG.write_text("\n".join(full_lines))
    os.chmod(WIREGUARD_CONFIG, 0o600)
    try:
        run_fixed(["wg", "show", "northstar"])
        run_fixed(["wg", "syncconf", "northstar", "/dev/stdin"], input_text="\n".join(sync_lines))
    except subprocess.CalledProcessError:
        run_fixed(["wg-quick", "up", str(WIREGUARD_CONFIG)])
    digest = hashlib.sha256(json.dumps(desired, sort_keys=True).encode()).hexdigest()
    return {"observedHash": digest, "observedStatus": "applied", "serverPublicKey": wireguard_public_key()}


def apply_task(task):
    task_type = task.get("taskType")
    payload = task.get("payload") or {}
    if task_type == "ApplyWireGuardPeers":
        return wireguard_sync_config(payload)
    raise ValueError(f"unsupported structured task: {task_type}")


def capabilities():
    protocols = []
    transports = {}
    if shutil.which("wg") is not None and shutil.which("wg-quick") is not None:
        protocols.append("wireguard")
        transports["wireguard"] = ["udp"]
    return {
        "protocols": protocols,
        "transports": transports,
        "routing": ["full", "split"],
        "runtime": {
            "wireguardTools": "wireguard" in protocols,
            "python": os.sys.version.split()[0],
        },
    }


def read_memory():
    values = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0]) * 1024
        total = values.get("MemTotal", 0)
        available = values.get("MemAvailable", values.get("MemFree", 0))
        used = max(total - available, 0)
        return {"usedBytes": used, "totalBytes": total, "percent": round((used / total) * 100, 1) if total else 0}
    except (OSError, ValueError):
        return {"usedBytes": 0, "totalBytes": 0, "percent": 0}


def read_cpu():
    global last_cpu_sample
    try:
        fields = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
        values = [int(value) for value in fields]
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        total = sum(values)
        current = (total, idle)
        if last_cpu_sample is None:
            last_cpu_sample = current
            return 0
        previous_total, previous_idle = last_cpu_sample
        last_cpu_sample = current
        total_delta = total - previous_total
        idle_delta = idle - previous_idle
        return round(max(0, min(100, (1 - idle_delta / total_delta) * 100)), 1) if total_delta else 0
    except (OSError, ValueError, IndexError):
        return 0


def read_network():
    global last_network_sample
    try:
        received = sent = 0
        for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
            interface, data = line.split(":", 1)
            if interface.strip() == "lo":
                continue
            fields = data.split()
            if len(fields) >= 9:
                received += int(fields[0])
                sent += int(fields[8])
        now = time.time()
        rx_rate = tx_rate = 0
        if last_network_sample is not None:
            previous_time, previous_received, previous_sent = last_network_sample
            elapsed = max(now - previous_time, 0.001)
            rx_rate = round(max(0, received - previous_received) / elapsed)
            tx_rate = round(max(0, sent - previous_sent) / elapsed)
        last_network_sample = (now, received, sent)
        return {"rxBytes": received, "txBytes": sent, "rxBytesPerSecond": rx_rate, "txBytesPerSecond": tx_rate}
    except (OSError, ValueError, IndexError):
        return {"rxBytes": 0, "txBytes": 0, "rxBytesPerSecond": 0, "txBytesPerSecond": 0}


def metrics():
    disk = shutil.disk_usage("/")
    used_disk = max(disk.total - disk.free, 0)
    memory = read_memory()
    return {
        "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cpuPercent": read_cpu(),
        "load1": round(os.getloadavg()[0], 2) if hasattr(os, "getloadavg") else 0,
        "memory": memory,
        "disk": {"usedBytes": used_disk, "totalBytes": disk.total, "percent": round((used_disk / disk.total) * 100, 1) if disk.total else 0},
        "network": read_network(),
    }


def heartbeat():
    return request_json("/api/v1/agent/heartbeat", {
        "nodeId": NODE_ID,
        "token": TOKEN,
        "hostname": socket.gethostname(),
        "version": "agent 2.0.0",
        "serverPublicKey": wireguard_public_key(),
        "capabilities": capabilities(),
        "metrics": metrics(),
    })


def poll_tasks():
    response = request_json("/api/v1/agent/tasks/pull", {"nodeId": NODE_ID, "token": TOKEN, "limit": 10})
    for task in response.get("tasks", []):
        try:
            result = apply_task(task)
            request_json("/api/v1/agent/reconcile-result", {
                "nodeId": NODE_ID,
                "token": TOKEN,
                "taskId": task["id"],
                "status": "succeeded",
                "observedRevision": task.get("desiredRevision", 0),
                "observedHash": result.get("observedHash", ""),
                "observedStatus": result.get("observedStatus", "applied"),
            })
        except Exception as error:
            request_json("/api/v1/agent/reconcile-result", {
                "nodeId": NODE_ID,
                "token": TOKEN,
                "taskId": task.get("id", ""),
                "status": "failed",
                "error": str(error)[-4000:],
            })


def restore_wireguard():
    if not WIREGUARD_CONFIG.exists() or shutil.which("wg") is None or shutil.which("wg-quick") is None:
        return
    try:
        run_fixed(["wg", "show", "northstar"])
    except subprocess.CalledProcessError:
        run_fixed(["wg-quick", "up", str(WIREGUARD_CONFIG)])


def main():
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        restore_wireguard()
    except Exception:
        pass
    last_heartbeat = 0
    while True:
        if time.time() - last_heartbeat >= 30:
            try:
                heartbeat()
                last_heartbeat = time.time()
            except Exception as error:
                log_failure("heartbeat", error)
        try:
            poll_tasks()
        except Exception as error:
            log_failure("task poll", error)
        time.sleep(5)


if __name__ == "__main__":
    main()
