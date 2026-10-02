#!/usr/bin/env python3
"""Northstar outbound edge agent.

The agent accepts only structured reconcile tasks. It never executes a command
received from the controller and it never sends a private key to the controller.
Supported data-plane tasks apply or disable a known VPN protocol. Arbitrary
remote command execution is deliberately not part of this channel.
"""

import base64
import hashlib
import ipaddress
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import ssl
import platform
import zipfile
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
OPENVPN_STATUS = OPENVPN_DIR / "status.tsv"
OPENVPN_REVOKED_DIR = OPENVPN_DIR / "revoked"
VLESS_CONFIG = STATE_DIR / "vless.json"
XRAY_PATH = Path("/opt/northstar-agent/bin/xray")
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
    request_payload = dict(payload)
    request_payload.pop("token", None)
    request = urllib.request.Request(
        CONTROLLER + path,
        data=json.dumps(request_payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
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


def atomic_write(path, text, mode=0o600):
    """Replace a file atomically so a crash never leaves a truncated config or key."""
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.")
    try:
        with os.fdopen(descriptor, "w") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def has_control_characters(value):
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def valid_network(value):
    if not isinstance(value, str) or len(value) > 64 or has_control_characters(value):
        return False
    try:
        ipaddress.ip_network(value.strip(), strict=False)
    except ValueError:
        return False
    return value == value.strip()


def valid_address(value):
    if not isinstance(value, str) or len(value) > 64 or has_control_characters(value):
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def replace_input_rule(comment, old_listener, new_listener):
    """Keep exactly one managed INPUT rule for the current listener.

    wg-quick PostUp and the OpenVPN setup only add rules, so a listen-port change
    would otherwise leave the old port open and, for WireGuard syncconf, never
    open the new one.
    """
    if shutil.which("iptables") is None:
        return
    def rule(operation, listener):
        transport, port = listener
        return ["iptables", operation, "INPUT", "-p", transport, "--dport", str(port), "-m", "comment", "--comment", comment, "-j", "ACCEPT"]
    if old_listener is not None and old_listener != new_listener:
        while run_optional(rule("-D", old_listener)).returncode == 0:
            pass
    if new_listener is not None and run_optional(rule("-C", new_listener)).returncode != 0:
        try:
            run_fixed(rule("-I", new_listener))
        except subprocess.CalledProcessError as error:
            raise RuntimeError("firewall configuration failed: " + command_failure_detail(error)) from error


WIREGUARD_TCP_MSS = 1240  # 1280-byte client MTU minus IPv4 and TCP headers


def wireguard_mss_rules(operation):
    """Cap TCP MSS through the tunnel so older profiles without an MTU line do not
    push 1420-byte packets into paths that silently drop fragments (common on mobile)."""
    return [
        ["iptables", "-t", "mangle", operation, "FORWARD", direction, "northstar", "-p", "tcp",
         "--tcp-flags", "SYN,RST", "SYN", "-m", "comment", "--comment", "northstar-wireguard-mss",
         "-j", "TCPMSS", "--set-mss", str(WIREGUARD_TCP_MSS)]
        for direction in ("-i", "-o")
    ]


def ensure_wireguard_mss_clamp():
    if shutil.which("iptables") is None:
        return
    for check in wireguard_mss_rules("-C"):
        if run_optional(check).returncode != 0:
            add = check.copy()
            add[add.index("-C")] = "-A"
            # Best effort: a kernel without xt_TCPMSS must not take the tunnel down.
            run_optional(add)


def remove_wireguard_mss_clamp():
    if shutil.which("iptables") is None:
        return
    for rule in wireguard_mss_rules("-D"):
        while run_optional(rule).returncode == 0:
            pass


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
        atomic_write(WIREGUARD_KEY, private_key + "\n")
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
        if not isinstance(allowed_ips, list) or not allowed_ips or len(allowed_ips) > 64 or not all(valid_network(item) for item in allowed_ips):
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

    previous_listener = configured_listener(WIREGUARD_CONFIG, 51820, "udp") if WIREGUARD_CONFIG.exists() else None
    atomic_write(WIREGUARD_CONFIG, "\n".join(full_lines))
    try:
        run_fixed(["wg", "show", "northstar"])
        run_fixed(["wg", "syncconf", "northstar", "/dev/stdin"], input_text="\n".join(sync_lines))
        # syncconf never runs PostUp/PostDown, so move the managed INPUT rule here.
        replace_input_rule("northstar-wireguard", previous_listener, ("udp", listen_port))
    except subprocess.CalledProcessError:
        if previous_listener is not None and previous_listener != ("udp", listen_port):
            replace_input_rule("northstar-wireguard", previous_listener, ("udp", listen_port))
        try:
            run_fixed(["wg-quick", "up", str(WIREGUARD_CONFIG)])
        except subprocess.CalledProcessError as error:
            raise RuntimeError("WireGuard activation failed: " + command_failure_detail(error)) from error
    ensure_wireguard_mss_clamp()
    digest = hashlib.sha256(json.dumps(desired, sort_keys=True).encode()).hexdigest()
    return {"observedHash": digest, "observedStatus": "applied", "serverPublicKey": wireguard_public_key()}


def disable_wireguard():
    if WIREGUARD_CONFIG.exists() and shutil.which("wg-quick") is not None:
        run_optional(["wg-quick", "down", str(WIREGUARD_CONFIG)])
    remove_wireguard_mss_clamp()
    WIREGUARD_CONFIG.unlink(missing_ok=True)
    return {"observedHash": hashlib.sha256(b"wireguard-disabled").hexdigest(), "observedStatus": "disabled"}


def restart_wireguard(desired):
    if not WIREGUARD_CONFIG.exists() or shutil.which("wg-quick") is None:
        raise RuntimeError("WireGuard is not configured")
    run_optional(["wg-quick", "down", str(WIREGUARD_CONFIG)])
    try:
        run_fixed(["wg-quick", "up", str(WIREGUARD_CONFIG)])
    except subprocess.CalledProcessError as error:
        raise RuntimeError("WireGuard restart failed: " + command_failure_detail(error)) from error
    ensure_wireguard_mss_clamp()
    digest = hashlib.sha256(json.dumps(desired, sort_keys=True).encode()).hexdigest()
    return {"observedHash": digest, "observedStatus": "applied", "serverPublicKey": wireguard_public_key()}


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
    if any(re.search(r"[^\x20-\x7e\r\n\t]", bundle[key]) for key in required):
        raise ValueError("OpenVPN server bundle contains unexpected characters")
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
    if not isinstance(dns, list) or len(dns) > 8 or not all(valid_address(item) for item in dns):
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
    previous_listener = configured_listener(OPENVPN_CONFIG, 1194, "udp") if OPENVPN_CONFIG.exists() else None
    replace_input_rule("northstar-openvpn", previous_listener, (transport, listen_port))
    firewall_rules = [
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
        atomic_write(OPENVPN_DIR / name, value if value.endswith("\n") else value + "\n")
    proto = "tcp-server" if transport == "tcp" else "udp"
    push_lines = ["push \"redirect-gateway def1 bypass-dhcp\""] + [f"push \"dhcp-option DNS {item}\"" for item in dns]
    config_lines = [
        f"port {listen_port}", f"proto {proto}", "dev tun", "topology subnet", "server 10.71.0.0 255.255.255.0",
        f"ca {OPENVPN_DIR / 'ca.crt'}", f"cert {OPENVPN_DIR / 'server.crt'}", f"key {OPENVPN_DIR / 'server.key'}",
        f"crl-verify {OPENVPN_REVOKED_DIR} dir", f"tls-crypt {OPENVPN_DIR / 'tls-crypt.key'}", "dh none", "ecdh-curve prime256v1",
        "auth SHA256", "data-ciphers AES-256-GCM:CHACHA20-POLY1305", "data-ciphers-fallback AES-256-GCM", "keepalive 10 120",
        "persist-key", "persist-tun", "duplicate-cn", "explicit-exit-notify 1", f"status {OPENVPN_STATUS} 30", "status-version 3", "verb 3", *push_lines, "",
    ]
    atomic_write(OPENVPN_CONFIG, "\n".join(config_lines))
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
    atomic_write(Path("/etc/systemd/system/northstar-openvpn.service"), unit, 0o644)
    run_fixed(["systemctl", "daemon-reload"])
    run_fixed(["systemctl", "enable", "northstar-openvpn"])
    run_fixed(["systemctl", "restart", "northstar-openvpn"])
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
    OPENVPN_STATUS.unlink(missing_ok=True)
    return {"observedHash": hashlib.sha256(b"openvpn-disabled").hexdigest(), "observedStatus": "disabled"}


def restart_openvpn(desired):
    if not OPENVPN_CONFIG.exists() or shutil.which("openvpn") is None:
        raise RuntimeError("OpenVPN is not configured")
    try:
        run_fixed(["systemctl", "restart", "northstar-openvpn"])
        run_fixed(["systemctl", "is-active", "--quiet", "northstar-openvpn"])
    except subprocess.CalledProcessError as error:
        raise RuntimeError("OpenVPN restart failed: " + command_failure_detail(error)) from error
    digest = hashlib.sha256(json.dumps(desired, sort_keys=True).encode()).hexdigest()
    return {"observedHash": digest, "observedStatus": "applied"}


def ensure_xray():
    if XRAY_PATH.exists():
        return
    releases = {
        "x86_64": ("64", "23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae"),
        "aarch64": ("arm64-v8a", "4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c"),
        "arm64": ("arm64-v8a", "4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c"),
    }
    if platform.system() != "Linux" or platform.machine() not in releases:
        raise RuntimeError("VLESS requires Linux amd64 or arm64")
    arch, checksum = releases[platform.machine()]
    url = f"https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-{arch}.zip"
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = response.read(64 * 1024 * 1024 + 1)
    if len(archive) > 64 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != checksum:
        raise RuntimeError("Xray release checksum verification failed")
    # Extract only the pinned executable, never archive paths or shell installers.
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        binary = package.read("xray")
    XRAY_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=XRAY_PATH.parent, delete=False) as temporary:
        temporary.write(binary)
        temp_path = Path(temporary.name)
    temp_path.chmod(0o700)
    temp_path.replace(XRAY_PATH)


def reality_destination(server_name):
    if not isinstance(server_name, str) or len(server_name) > 253 or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", server_name):
        raise ValueError("invalid REALITY target hostname")
    addresses = [row[4][0] for row in socket.getaddrinfo(server_name, 443, type=socket.SOCK_STREAM)]
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("REALITY target must resolve exclusively to public addresses")
    # Pin the validated IP in the server config (avoids a later DNS rebinding into private networks).
    address = addresses[0]
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.set_alpn_protocols(["h2"])
    with socket.create_connection((address, 443), timeout=10) as connection:
        with context.wrap_socket(connection, server_hostname=server_name) as tls:
            if tls.selected_alpn_protocol() != "h2":
                raise ValueError("REALITY target must support TLS 1.3 and HTTP/2")
    return f"[{address}]:443" if ":" in address else f"{address}:443"


def vless_config(desired, bundle, target):
    port = desired.get("listenPort", 443)
    users = desired.get("users", [])
    if not isinstance(port, int) or port < 1 or port > 65535 or port == 10085:
        raise ValueError("invalid VLESS listen port")
    if not isinstance(users, list) or len(users) > 4096:
        raise ValueError("invalid VLESS users")
    clients = []
    for user in users:
        identity = user.get("id", "")
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", identity):
            raise ValueError("invalid VLESS user UUID")
        email = user.get("email", identity)
        if not isinstance(email, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", email):
            raise ValueError("invalid VLESS telemetry identity")
        clients.append({"id": identity, "email": email, "level": 0, "flow": "xtls-rprx-vision"})
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", bundle.get("privateKey", "")) or not re.fullmatch(r"[0-9a-f]{16}", bundle.get("shortId", "")):
        raise ValueError("invalid REALITY server keys")
    return {
        "log": {"loglevel": "warning", "access": "none"},
        "api": {"tag": "api", "services": ["StatsService"]}, "stats": {},
        "policy": {"levels": {"0": {"statsUserUplink": True, "statsUserDownlink": True}}},
        "inbounds": [
            {"tag": "vless", "listen": "0.0.0.0", "port": port, "protocol": "vless",
             "settings": {"clients": clients, "decryption": "none"},
             "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {
                 "show": False, "target": target, "xver": 0, "serverNames": [bundle["serverName"]],
                 "privateKey": bundle["privateKey"], "shortIds": [bundle["shortId"]]}}},
            {"tag": "api", "listen": "127.0.0.1", "port": 10085, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"}},
        ],
        "outbounds": [{"tag": "direct", "protocol": "freedom"}, {"tag": "blocked", "protocol": "blackhole"}],
        "routing": {"domainStrategy": "IPOnDemand", "rules": [
            {"type": "field", "inboundTag": ["api"], "outboundTag": "api"},
            {"type": "field", "ip": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "0.0.0.0/8", "224.0.0.0/4", "::1/128", "fc00::/7", "fe80::/10"], "outboundTag": "blocked"},
        ]},
    }


def vless_sync_config(desired):
    bundle = json.loads(request_node_secret(desired.get("serverBundleSecretId")))
    ensure_xray()
    old = json.loads(VLESS_CONFIG.read_text()) if VLESS_CONFIG.exists() else None
    # Once verified, keep the destination stable across access-list refreshes.
    previous_reality = old["inbounds"][0]["streamSettings"]["realitySettings"] if old else None
    target = previous_reality["target"] if previous_reality and previous_reality["serverNames"] == [bundle.get("serverName")] else reality_destination(bundle.get("serverName"))
    users = json.loads(request_node_secret(desired.get("usersSecretId")))
    config = vless_config({**desired, "users": users}, bundle, target)
    port = config["inbounds"][0]["port"]
    if (not old or old["inbounds"][0]["port"] != port) and socket_listening("tcp", port):
        raise RuntimeError("VLESS port is occupied; choose another port")
    if not old and socket_listening("tcp", 10085):
        raise RuntimeError("VLESS local statistics port 10085 is occupied")
    candidate = STATE_DIR / "vless-candidate.json"
    atomic_write(candidate, json.dumps(config))
    try:
        run_fixed([str(XRAY_PATH), "run", "-test", "-config", str(candidate)])
    finally:
        candidate.unlink(missing_ok=True)
    # Restarting closes sessions removed by disable/revoke as well as removing their credentials.
    atomic_write(VLESS_CONFIG, json.dumps(config))
    unit = f"""[Unit]
Description=Northstar VLESS REALITY
After=network-online.target
[Service]
ExecStart={XRAY_PATH} run -config {VLESS_CONFIG}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
[Install]
WantedBy=multi-user.target
"""
    atomic_write(Path("/etc/systemd/system/northstar-vless.service"), unit, 0o644)
    run_fixed(["systemctl", "daemon-reload"])
    run_fixed(["systemctl", "enable", "northstar-vless"])
    run_fixed(["systemctl", "restart", "northstar-vless"])
    run_fixed(["systemctl", "is-active", "--quiet", "northstar-vless"])
    replace_input_rule("northstar-vless", ("tcp", old["inbounds"][0]["port"]) if old else None, ("tcp", port))
    return {"observedHash": hashlib.sha256(json.dumps(desired, sort_keys=True).encode()).hexdigest(), "observedStatus": "applied"}


def vless_usage_snapshots():
    if not XRAY_PATH.exists() or not VLESS_CONFIG.exists():
        return []
    result = run_optional([str(XRAY_PATH), "api", "statsquery", "--server=127.0.0.1:10085", "-pattern", "user>>>"])
    if result.returncode != 0:
        return []
    try:
        stats = json.loads(result.stdout).get("stat", [])
    except (ValueError, TypeError):
        return []
    users = {}
    for item in stats:
        parts = item.get("name", "").split(">>>")
        if len(parts) != 4 or parts[0] != "user" or parts[2] != "traffic" or parts[3] not in ("uplink", "downlink"):
            continue
        user = users.setdefault(parts[1], {"protocol": "vless", "identityKey": parts[1], "rxBytes": 0, "txBytes": 0})
        user["rxBytes" if parts[3] == "uplink" else "txBytes"] = int(item.get("value", 0))
    epoch = run_optional(["systemctl", "show", "northstar-vless", "--property=InvocationID", "--value"]).stdout.strip()
    return [{**user, "counterEpoch": epoch} for user in users.values()]


def apply_task(task):
    task_type = task.get("taskType")
    payload = task.get("payload") or {}
    if task_type in ("ApplyVlessServer", "RestartVless"):
        return vless_sync_config(payload)
    if task_type == "DisableVless":
        run_optional(["systemctl", "disable", "--now", "northstar-vless"])
        if VLESS_CONFIG.exists():
            old = json.loads(VLESS_CONFIG.read_text())
            replace_input_rule("northstar-vless", ("tcp", old["inbounds"][0]["port"]), None)
            VLESS_CONFIG.unlink()
        return {"observedHash": hashlib.sha256(b"vless-disabled").hexdigest(), "observedStatus": "disabled"}
    if task_type == "ApplyWireGuardPeers":
        return wireguard_sync_config(payload)
    if task_type == "ApplyOpenVpnServer":
        return openvpn_sync_config(payload)
    if task_type == "RestartWireGuard":
        return restart_wireguard(payload)
    if task_type == "RestartOpenVpn":
        return restart_openvpn(payload)
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
    # This agent can install its pinned runtime on explicit ApplyVlessServer, even before installation.
    if platform.system() == "Linux" and platform.machine() in ("x86_64", "aarch64", "arm64"):
        protocols.append("vless")
        transports["vless"] = ["tcp"]
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
    try:
        vless_port = json.loads(VLESS_CONFIG.read_text())["inbounds"][0]["port"] if VLESS_CONFIG.exists() else 443
    except (ValueError, KeyError, IndexError):
        vless_port = 443
    wireguard_ready = shutil.which("wg") is not None and shutil.which("wg-quick") is not None
    openvpn_ready = shutil.which("openvpn") is not None
    wireguard_transport, wireguard_port = configured_listener(WIREGUARD_CONFIG, 51820, "udp")
    openvpn_transport, openvpn_port = configured_listener(OPENVPN_CONFIG, 1194, "udp")
    protocol_specs = {
        "vless": {"transport": "tcp", "port": vless_port, "comment": "northstar-vless"},
        "wireguard": {"transport": wireguard_transport, "port": wireguard_port, "comment": VPN_PORTS["wireguard"]["comment"]},
        "openvpn": {"transport": openvpn_transport, "port": openvpn_port, "comment": VPN_PORTS["openvpn"]["comment"]},
    }
    return {
        "firewall": firewall_snapshot(protocol_specs),
        "protocols": {
            "vless": {"installed": XRAY_PATH.exists(), "runtimeActive": command_succeeds(["systemctl", "is-active", "--quiet", "northstar-vless"]) if XRAY_PATH.exists() else False,
                      "listening": socket_listening("tcp", vless_port), "port": vless_port, "transport": "tcp"},
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


def counter_epoch():
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()[:128]
    except OSError:
        return "agent-" + NODE_ID


def wireguard_usage_snapshots():
    if shutil.which("wg") is None:
        return []
    result = run_optional(["wg", "show", "northstar", "dump"])
    if result.returncode != 0:
        return []
    snapshots = []
    # Suffix resets server-side deltas once, since older agents stored misaligned wg dump columns.
    epoch = counter_epoch() + ":wg2"
    for line in result.stdout.splitlines()[1:]:
        fields = line.split("\t")
        if len(fields) < 8 or not validate_key(fields[0]):
            continue
        # Peer rows: public-key, preshared-key, endpoint, allowed-ips,
        # latest-handshake, transfer-rx, transfer-tx, persistent-keepalive.
        try:
            handshake = int(fields[4] or 0)
            received = max(0, int(fields[5] or 0))
            transmitted = max(0, int(fields[6] or 0))
        except ValueError:
            continue
        snapshots.append({
            "protocol": "wireguard",
            "identityKey": fields[0],
            "rxBytes": received,
            "txBytes": transmitted,
            "lastHandshakeAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(handshake)) if handshake else None,
            "counterEpoch": epoch,
        })
    return snapshots


def openvpn_usage_snapshots():
    """Read per-client cumulative counters from OpenVPN's local status file."""
    try:
        lines = OPENVPN_STATUS.read_text().splitlines()
    except OSError:
        return []
    header = None
    snapshots = []
    observed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    boot_epoch = counter_epoch()
    for line in lines:
        fields = line.split("\t")
        if len(fields) >= 3 and fields[0] == "HEADER" and fields[1] == "CLIENT_LIST":
            header = fields[2:]
            continue
        if not header or len(fields) < 2 or fields[0] != "CLIENT_LIST":
            continue
        values = dict(zip(header, fields[1:]))
        common_name = values.get("Common Name", "").strip()
        if not common_name or len(common_name) > 128 or not re.fullmatch(r"[A-Za-z0-9_.@-]+", common_name):
            continue
        try:
            received = max(0, int(values.get("Bytes Received", "0")))
            transmitted = max(0, int(values.get("Bytes Sent", "0")))
        except ValueError:
            continue
        connected_since = values.get("Connected Since (time_t)", "") or values.get("Connected Since", "")
        client_id = values.get("Client ID", "")
        real_address = values.get("Real Address", "")
        session_key = f"{connected_since}:{client_id}:{real_address}"[:512]
        snapshots.append({
            "protocol": "openvpn",
            "identityKey": common_name,
            "sessionKey": session_key,
            "rxBytes": received,
            "txBytes": transmitted,
            "lastHandshakeAt": observed_at,
            "counterEpoch": f"{boot_epoch}:openvpn:{connected_since}:{client_id}",
        })
    return snapshots


def heartbeat():
    return request_json("/api/v1/agent/heartbeat", {
        "nodeId": NODE_ID,
        "token": TOKEN,
        "hostname": socket.gethostname(),
        "version": "agent 2.7.0",
        "serverPublicKey": wireguard_public_key(),
        "capabilities": capabilities(),
        "metrics": metrics(),
        "usageSnapshots": wireguard_usage_snapshots() + openvpn_usage_snapshots() + vless_usage_snapshots(),
    })


def poll_tasks():
    response = request_json("/api/v1/agent/tasks/pull", {"nodeId": NODE_ID, "token": TOKEN, "limit": 10})
    for task in response.get("tasks", []):
        try:
            result = apply_task(task)
            outcome = {
                "taskId": task["id"],
                "status": "succeeded",
                "observedRevision": task.get("desiredRevision", 0),
                "observedHash": result.get("observedHash", ""),
                "observedStatus": result.get("observedStatus", "applied"),
            }
        except Exception as error:
            detail = command_failure_detail(error)
            outcome = {"taskId": task.get("id", ""), "status": "failed", "error": detail[-4000:]}
        # Report each task independently so one failed post does not drop the rest.
        try:
            request_json("/api/v1/agent/reconcile-result", {"nodeId": NODE_ID, "token": TOKEN, **outcome})
        except Exception as error:
            log_failure("reconcile result", error)


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
    except Exception as error:
        log_failure("WireGuard restore", command_failure_detail(error))
    try:
        restore_openvpn()
    except Exception as error:
        log_failure("OpenVPN restore", command_failure_detail(error))
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
