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

    full_lines = [
        "[Interface]",
        f"PrivateKey = {private_key}",
        "Address = 10.70.0.1/24",
        f"ListenPort = {listen_port}",
        "SaveConfig = false",
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


def heartbeat():
    return request_json("/api/v1/agent/heartbeat", {
        "nodeId": NODE_ID,
        "token": TOKEN,
        "hostname": socket.gethostname(),
        "version": "agent 2.0.0",
        "serverPublicKey": wireguard_public_key(),
        "capabilities": capabilities(),
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
        try:
            if time.time() - last_heartbeat >= 30:
                heartbeat()
                last_heartbeat = time.time()
            poll_tasks()
        except Exception:
            pass
        time.sleep(5)


if __name__ == "__main__":
    main()
