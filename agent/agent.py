#!/usr/bin/env python3
"""Northstar outbound edge agent.

The agent accepts only structured reconcile tasks. It never executes a command
received from the controller and it never sends a private key to the controller.
Supported data-plane tasks apply or disable a known VPN protocol. Arbitrary
remote command execution is deliberately not part of this channel.
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
import urllib.error
import urllib.request
from pathlib import Path


CONTROLLER = os.environ["NORTHSTAR_CONTROLLER_URL"].rstrip("/")
NODE_ID = os.environ["NORTHSTAR_NODE_ID"]
TOKEN = os.environ["NORTHSTAR_AGENT_TOKEN"]
STATE_DIR = Path(os.environ.get("NORTHSTAR_AGENT_STATE_DIR", "/opt/northstar-agent/state"))
WIREGUARD_DIR = STATE_DIR / "wireguard"
WIREGUARD_KEY = WIREGUARD_DIR / "server.key"
WIREGUARD_CONFIG = Path("/etc/wireguard/northstar.conf")
OPENVPN_DIR = STATE_DIR / "openvpn"
OPENVPN_CONFIG = OPENVPN_DIR / "server.conf"
OPENVPN_REVOKED_DIR = OPENVPN_DIR / "revoked"
KEY_PATTERN = re.compile(r"^[A-Za-z0-9+/]{43}=$")
VPN_PORTS = {
    "wireguard": {"transport": "udp", "port": 51820, "comment": "northstar-wireguard"},
    "openvpn": {"transport": "udp", "port": 1194, "comment": "northstar-openvpn"},
}
last_cpu_sample = None
last_network_sample = None
last_errors = {}


class AgentRequestError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def request_retry_delay(error, failure_count):
    if isinstance(error, AgentRequestError) and error.status in (401, 429):
        return 60
    return min(5 * (2 ** min(max(failure_count - 1, 0), 4)), 60)


def log_failure(operation, error):
    """Write actionable, rate-limited errors to the systemd journal.

    A node must never silently disappear from the Controller.  The same failure
    is logged at most once a minute, while a changed failure is logged
    immediately so a journal remains useful without becoming noisy.
    """
    message = f"northstar-agent {operation} failed: {error}"
    now = time.time()
    previous_message, previous_time = last_errors.get(operation, ("", 0))
    if message != previous_message or now - previous_time >= 60:
        print(message, file=sys.stderr, flush=True)
        last_errors[operation] = (message, now)
        try:
            request_json("/api/v1/agent/logs", {"nodeId": NODE_ID, "token": TOKEN, "entries": [{"level": "error", "message": message}]})
        except Exception:
            pass


def request_json(path, payload):
    request = urllib.request.Request(
        CONTROLLER + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read()
            return json.loads(raw.decode() or "{}")
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read().decode() or "{}")
            detail = body.get("error") if isinstance(body, dict) else ""
        except (UnicodeDecodeError, json.JSONDecodeError):
            detail = ""
        if error.code == 401:
            detail = detail or "Agent credentials are no longer accepted; repair the Agent identity from the Controller"
        raise AgentRequestError(error.code, f"HTTP {error.code}: {detail or error.reason}") from error


def request_node_secret(secret_id):
    if not isinstance(secret_id, str) or not re.fullmatch(r"secret_[A-Za-z0-9-]{8,}", secret_id):
        raise ValueError("invalid node secret reference")
    response = request_json("/api/v1/agent/secrets/pull", {"nodeId": NODE_ID, "token": TOKEN, "secretId": secret_id})
    value = response.get("value")
    if not isinstance(value, str) or not value:
        raise RuntimeError("node secret response was empty")
    return value


def run_fixed(command, *, input_text=None):
    return subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
    )


def run_optional(command):
    return subprocess.run(command, text=True, capture_output=True, check=False, timeout=30)


def command_failure_detail(error):
    if not isinstance(error, subprocess.CalledProcessError):
        return str(error)
    parts = [f"command {' '.join(str(item) for item in error.cmd)} exited with code {error.returncode}"]
    if error.stderr and error.stderr.strip():
        parts.append("stderr: " + error.stderr.strip())
    if error.stdout and error.stdout.strip():
        parts.append("stdout: " + error.stdout.strip())
    return " | ".join(parts)[-4000:]


def wireguard_public_key():
    if shutil.which("wg") is None:
        return ""
    try:
        private_key = ensure_wireguard_key()
        result = run_fixed(["wg", "pubkey"], input_text=private_key + "\n")
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
    WIREGUARD_CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    peers = desired.get("peers", [])
    if not isinstance(peers, list) or len(peers) > 4096:
        raise ValueError("invalid WireGuard peer list")
    egress_interface = default_interface()

    input_rule = f"iptables -C INPUT -p udp --dport {listen_port} -m comment --comment northstar-wireguard -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport {listen_port} -m comment --comment northstar-wireguard -j ACCEPT"
    remove_input_rule = f"iptables -D INPUT -p udp --dport {listen_port} -m comment --comment northstar-wireguard -j ACCEPT 2>/dev/null || true"
    full_lines = [
        "[Interface]",
        f"PrivateKey = {private_key}",
        "Address = 10.70.0.1/24",
        f"ListenPort = {listen_port}",
        "SaveConfig = false",
        "PostUp = " + input_rule + "; iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -o " + egress_interface + " -j MASQUERADE",
        "PostDown = " + remove_input_rule + "; iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -o " + egress_interface + " -j MASQUERADE",
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
        try:
            run_fixed(["wg-quick", "up", str(WIREGUARD_CONFIG)])
        except subprocess.CalledProcessError as error:
            raise RuntimeError("WireGuard activation failed: " + command_failure_detail(error)) from error
    digest = hashlib.sha256(json.dumps(desired, sort_keys=True).encode()).hexdigest()
    return {"observedHash": digest, "observedStatus": "applied", "serverPublicKey": wireguard_public_key()}


def disable_wireguard():
    if WIREGUARD_CONFIG.exists() and shutil.which("wg-quick") is not None:
        run_optional(["wg-quick", "down", str(WIREGUARD_CONFIG)])
    WIREGUARD_CONFIG.unlink(missing_ok=True)
    return {"observedHash": hashlib.sha256(b"wireguard-disabled").hexdigest(), "observedStatus": "disabled"}


def safe_revocation_serial(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-F0-9]{1,128}", value):
        raise ValueError("invalid OpenVPN revoked certificate serial")
    return value


def openvpn_sync_config(desired):
    bundle_raw = request_node_secret(desired.get("serverBundleSecretId"))
    try:
        bundle = json.loads(bundle_raw)
    except json.JSONDecodeError as error:
        raise ValueError("OpenVPN server bundle is invalid") from error
    required = ("caCertificate", "serverCertificate", "serverPrivateKey", "tlsCryptKey")
    if not all(isinstance(bundle.get(key), str) and bundle[key] for key in required):
        raise ValueError("OpenVPN server bundle is incomplete")
    if shutil.which("openvpn") is None:
        raise RuntimeError("openvpn is not installed")
    transport = desired.get("transport", "udp")
    if transport not in ("udp", "tcp"):
        raise ValueError("invalid OpenVPN transport")
    listen_port = int(desired.get("listenPort", 1194))
    if listen_port < 1 or listen_port > 65535:
        raise ValueError("invalid OpenVPN listen port")
    if desired.get("subnet", "10.71.0.0/24") != "10.71.0.0/24":
        raise ValueError("unsupported OpenVPN subnet")
    dns = desired.get("dns", ["1.1.1.1"])
    if not isinstance(dns, list) or any(not isinstance(item, str) or len(item) > 64 for item in dns):
        raise ValueError("invalid OpenVPN DNS configuration")
    revoked = desired.get("revokedSerials", [])
    if not isinstance(revoked, list) or len(revoked) > 100000:
        raise ValueError("invalid OpenVPN revocation list")
    serials = {safe_revocation_serial(item) for item in revoked}
    egress_interface = default_interface()
    OPENVPN_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    OPENVPN_REVOKED_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    for item in OPENVPN_REVOKED_DIR.iterdir():
        if item.is_file() and re.fullmatch(r"[A-F0-9]{1,128}", item.name) and item.name not in serials:
            item.unlink()
    for serial in serials:
        (OPENVPN_REVOKED_DIR / serial).touch(mode=0o600, exist_ok=True)
    firewall_rules = [
        (["iptables", "-C", "INPUT", "-p", transport, "--dport", str(listen_port), "-m", "comment", "--comment", "northstar-openvpn", "-j", "ACCEPT"], "-I"),
        ["iptables", "-C", "FORWARD", "-s", "10.71.0.0/24", "-j", "ACCEPT"],
        ["iptables", "-C", "FORWARD", "-d", "10.71.0.0/24", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
        ["iptables", "-t", "nat", "-C", "POSTROUTING", "-s", "10.71.0.0/24", "-o", egress_interface, "-j", "MASQUERADE"],
    ]
    firewall_rules = [(rule, "-A") if isinstance(rule, list) else rule for rule in firewall_rules]
    for check, operation in firewall_rules:
        try:
            run_fixed(check)
        except subprocess.CalledProcessError:
            add = check.copy()
            add[add.index("-C")] = operation
            try:
                run_fixed(add)
            except subprocess.CalledProcessError as error:
                raise RuntimeError("OpenVPN firewall configuration failed: " + command_failure_detail(error)) from error
    for name, value in {
        "ca.crt": bundle["caCertificate"], "server.crt": bundle["serverCertificate"],
        "server.key": bundle["serverPrivateKey"], "tls-crypt.key": bundle["tlsCryptKey"],
    }.items():
        target = OPENVPN_DIR / name
        target.write_text(value if value.endswith("\n") else value + "\n")
        os.chmod(target, 0o600)
    proto = "tcp-server" if transport == "tcp" else "udp"
    push_lines = ["push \"redirect-gateway def1 bypass-dhcp\""] + [f"push \"dhcp-option DNS {item}\"" for item in dns]
    config_lines = [
        f"port {listen_port}", f"proto {proto}", "dev tun", "topology subnet", "server 10.71.0.0 255.255.255.0",
        f"ca {OPENVPN_DIR / 'ca.crt'}", f"cert {OPENVPN_DIR / 'server.crt'}", f"key {OPENVPN_DIR / 'server.key'}",
        f"crl-verify {OPENVPN_REVOKED_DIR} dir", f"tls-crypt {OPENVPN_DIR / 'tls-crypt.key'}", "dh none", "ecdh-curve prime256v1",
        "auth SHA256", "data-ciphers AES-256-GCM:CHACHA20-POLY1305", "data-ciphers-fallback AES-256-GCM", "keepalive 10 120",
        "persist-key", "persist-tun", "explicit-exit-notify 1", "verb 3", *push_lines, "",
    ]
    OPENVPN_CONFIG.write_text("\n".join(config_lines))
    os.chmod(OPENVPN_CONFIG, 0o600)
    openvpn_path = shutil.which("openvpn")
    unit = f"""[Unit]
Description=Northstar managed OpenVPN server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={openvpn_path} --config /opt/northstar-agent/state/openvpn/server.conf
Restart=always
RestartSec=5
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
"""
    Path("/etc/systemd/system/northstar-openvpn.service").write_text(unit)
    run_fixed(["systemctl", "daemon-reload"])
    run_fixed(["systemctl", "enable", "--now", "northstar-openvpn"])
    run_fixed(["systemctl", "is-active", "--quiet", "northstar-openvpn"])
    digest = hashlib.sha256(json.dumps(desired, sort_keys=True).encode()).hexdigest()
    return {"observedHash": digest, "observedStatus": "applied"}


def disable_openvpn():
    transport, listen_port = configured_listener(OPENVPN_CONFIG, 1194, "udp")
    try:
        egress_interface = default_interface()
    except Exception:
        egress_interface = ""
    run_optional(["systemctl", "disable", "--now", "northstar-openvpn"])
    rules = [
        ["iptables", "-D", "INPUT", "-p", transport, "--dport", str(listen_port), "-m", "comment", "--comment", "northstar-openvpn", "-j", "ACCEPT"],
        ["iptables", "-D", "FORWARD", "-s", "10.71.0.0/24", "-j", "ACCEPT"],
        ["iptables", "-D", "FORWARD", "-d", "10.71.0.0/24", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
    ]
    if egress_interface:
        rules.append(["iptables", "-t", "nat", "-D", "POSTROUTING", "-s", "10.71.0.0/24", "-o", egress_interface, "-j", "MASQUERADE"])
    if shutil.which("iptables") is not None:
        for rule in rules:
            while run_optional(rule).returncode == 0:
                pass
    OPENVPN_CONFIG.unlink(missing_ok=True)
    return {"observedHash": hashlib.sha256(b"openvpn-disabled").hexdigest(), "observedStatus": "disabled"}


def apply_task(task):
    task_type = task.get("taskType")
    payload = task.get("payload") or {}
    if task_type == "ApplyWireGuardPeers":
        return wireguard_sync_config(payload)
    if task_type == "ApplyOpenVpnServer":
        return openvpn_sync_config(payload)
    if task_type == "DisableWireGuard":
        return disable_wireguard()
    if task_type == "DisableOpenVpn":
        return disable_openvpn()
    raise ValueError(f"unsupported structured task: {task_type}")


def capabilities():
    protocols = []
    transports = {}
    if shutil.which("wg") is not None and shutil.which("wg-quick") is not None:
        protocols.append("wireguard")
        transports["wireguard"] = ["udp"]
    if shutil.which("openvpn") is not None:
        protocols.append("openvpn")
        transports["openvpn"] = ["udp", "tcp"]
    return {
        "protocols": protocols,
        "transports": transports,
        "routing": ["full", "split"],
        "runtime": {
            "wireguardTools": "wireguard" in protocols,
            "openvpn": "openvpn" in protocols,
            "python": os.sys.version.split()[0],
        },
        "connectivity": connectivity_snapshot(),
    }


def command_succeeds(command):
    try:
        run_fixed(command)
        return True
    except (subprocess.CalledProcessError, OSError):
        return False


def socket_listening(transport, port):
    if shutil.which("ss") is None:
        return None
    arguments = ["ss", "-H", "-l", "-n", "-u" if transport == "udp" else "-t"]
    try:
        output = run_fixed(arguments).stdout
        return bool(re.search(rf"(?:\[::\]|\*|[0-9a-fA-F:.]+):{port}(?:\s|$)", output))
    except (subprocess.CalledProcessError, OSError):
        return None


def input_policy():
    if shutil.which("iptables") is None:
        return "unknown"
    try:
        output = run_fixed(["iptables", "-S", "INPUT"]).stdout
        match = re.search(r"^-P INPUT (ACCEPT|DROP|REJECT)$", output, re.MULTILINE)
        return match.group(1).lower() if match else "unknown"
    except (subprocess.CalledProcessError, OSError):
        return "unknown"


def configured_listener(config_path, default_port, default_transport):
    """Read the listener selected by Northstar's own generated config.

    The controller may choose a non-default port (and OpenVPN may use TCP), so
    telemetry must describe the live configuration rather than a UI default.
    """
    try:
        contents = config_path.read_text()
    except OSError:
        return default_transport, default_port
    port_match = re.search(r"^ListenPort\s*=\s*(\d+)$|^port\s+(\d+)$", contents, re.MULTILINE)
    port = int(next(value for value in port_match.groups() if value is not None)) if port_match else default_port
    transport_match = re.search(r"^proto\s+(\S+)$", contents, re.MULTILINE)
    transport = "tcp" if transport_match and transport_match.group(1).startswith("tcp") else default_transport
    return transport, port


def firewall_snapshot(protocol_specs):
    manager = "iptables" if shutil.which("iptables") else "unknown"
    if shutil.which("ufw") is not None:
        manager = "ufw"
    elif shutil.which("firewall-cmd") is not None:
        manager = "firewalld"
    managed_rules = {}
    for name, spec in protocol_specs.items():
        command = ["iptables", "-C", "INPUT", "-p", spec["transport"], "--dport", str(spec["port"]), "-m", "comment", "--comment", spec["comment"], "-j", "ACCEPT"]
        managed_rules[f"{spec['transport']}/{spec['port']}"] = command_succeeds(command) if shutil.which("iptables") else None
    return {"manager": manager, "inputPolicy": input_policy(), "managedRules": managed_rules}


def connectivity_snapshot():
    wireguard_ready = shutil.which("wg") is not None and shutil.which("wg-quick") is not None
    openvpn_ready = shutil.which("openvpn") is not None
    wireguard_transport, wireguard_port = configured_listener(WIREGUARD_CONFIG, 51820, "udp")
    openvpn_transport, openvpn_port = configured_listener(OPENVPN_CONFIG, 1194, "udp")
    protocol_specs = {
        "wireguard": {"transport": wireguard_transport, "port": wireguard_port, "comment": VPN_PORTS["wireguard"]["comment"]},
        "openvpn": {"transport": openvpn_transport, "port": openvpn_port, "comment": VPN_PORTS["openvpn"]["comment"]},
    }
    return {
        "firewall": firewall_snapshot(protocol_specs),
        "protocols": {
            "wireguard": {
                "installed": wireguard_ready,
                "interfaceActive": command_succeeds(["wg", "show", "northstar"]) if wireguard_ready else False,
                "runtimeActive": command_succeeds(["wg", "show", "northstar"]) if wireguard_ready else False,
                "listening": socket_listening(wireguard_transport, wireguard_port),
                "port": wireguard_port,
                "transport": wireguard_transport,
            },
            "openvpn": {
                "installed": openvpn_ready,
                "serviceActive": command_succeeds(["systemctl", "is-active", "--quiet", "northstar-openvpn"]) if openvpn_ready else False,
                "runtimeActive": command_succeeds(["systemctl", "is-active", "--quiet", "northstar-openvpn"]) if openvpn_ready else False,
                "listening": socket_listening(openvpn_transport, openvpn_port),
                "port": openvpn_port,
                "transport": openvpn_transport,
            },
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
        "version": "agent 2.4.3",
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
            detail = command_failure_detail(error)
            request_json("/api/v1/agent/reconcile-result", {
                "nodeId": NODE_ID,
                "token": TOKEN,
                "taskId": task.get("id", ""),
                "status": "failed",
                "error": detail[-4000:],
            })


def restore_wireguard():
    if not WIREGUARD_CONFIG.exists() or shutil.which("wg") is None or shutil.which("wg-quick") is None:
        return
    try:
        run_fixed(["wg", "show", "northstar"])
    except subprocess.CalledProcessError:
        run_fixed(["wg-quick", "up", str(WIREGUARD_CONFIG)])


def restore_openvpn():
    if OPENVPN_CONFIG.exists() and shutil.which("openvpn") is not None:
        run_fixed(["systemctl", "start", "northstar-openvpn"])


def main():
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        restore_wireguard()
    except Exception:
        pass
    try:
        restore_openvpn()
    except Exception:
        pass
    last_heartbeat_attempt = 0
    last_task_poll = 0
    request_backoff_until = 0
    consecutive_request_failures = 0
    while True:
        now = time.time()
        if now >= request_backoff_until and now - last_heartbeat_attempt >= 30:
            last_heartbeat_attempt = now
            try:
                heartbeat()
                consecutive_request_failures = 0
            except Exception as error:
                log_failure("heartbeat", error)
                consecutive_request_failures += 1
                request_backoff_until = now + request_retry_delay(error, consecutive_request_failures)
        if now >= request_backoff_until and now - last_task_poll >= 5:
            last_task_poll = now
            try:
                poll_tasks()
                consecutive_request_failures = 0
            except Exception as error:
                log_failure("task poll", error)
                consecutive_request_failures += 1
                request_backoff_until = now + request_retry_delay(error, consecutive_request_failures)
        time.sleep(1)


if __name__ == "__main__":
    main()
