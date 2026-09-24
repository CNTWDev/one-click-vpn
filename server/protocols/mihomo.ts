import { isIP } from "node:net";

type WireGuardExport = {
  name: string;
  endpoint: { host: string; port: number };
  privateKey: string;
  serverPublicKey: string;
  clientAddress: string;
  dns: string[];
  allowedIps: string[];
};

/** Serialize values as JSON flow syntax (valid YAML), never interpolate user data into YAML. */
export function renderMihomoWireGuard(input: WireGuardExport): string {
  const ip = input.clientAddress.split("/")[0];
  const keyPattern = /^[A-Za-z0-9+/]{43}=$/;
  if (isIP(ip) !== 4) throw new Error("Mihomo export requires an IPv4 WireGuard address");
  if (!keyPattern.test(input.privateKey) || !keyPattern.test(input.serverPublicKey)) throw new Error("WireGuard key material is invalid");
  if (!input.endpoint.host || /[\s\x00-\x1f]/.test(input.endpoint.host) || !Number.isInteger(input.endpoint.port) || input.endpoint.port < 1 || input.endpoint.port > 65535) throw new Error("WireGuard endpoint is invalid");
  if (!input.allowedIps.length || input.allowedIps.some((cidr) => {
    const [address, prefix, extra] = cidr.split("/");
    return extra !== undefined || isIP(address) !== 4 || !/^\d+$/.test(prefix || "") || Number(prefix) > 32;
  })) throw new Error("Mihomo export currently supports IPv4 routes only");
  const dns = input.dns.length ? input.dns : ["1.1.1.1"];
  if (dns.some((address) => isIP(address) !== 4)) throw new Error("Mihomo export requires IPv4 DNS servers");
  const proxy = {
    name: input.name, type: "wireguard", server: input.endpoint.host, port: input.endpoint.port,
    ip, "private-key": input.privateKey, "public-key": input.serverPublicKey,
    "allowed-ips": input.allowedIps, "persistent-keepalive": 25,
    udp: true, "remote-dns-resolve": true, dns,
  };
  return [
    "# Northstar · WireGuard for Mihomo (not legacy Clash)",
    "# Sensitive: contains your private key. Do not share or upload to conversion websites.",
    "# Import as a local configuration; enable system proxy or TUN in your client.",
    "# One active client per WireGuard credential. Expiry and access controls still apply.",
    "mixed-port: 7890", "allow-lan: false", 'bind-address: "127.0.0.1"',
    "mode: rule", "log-level: warning", "ipv6: false",
    // DNS follows MATCH through WG. Endpoint DNS is explicitly bootstrapped outside the tunnel.
    `dns: ${JSON.stringify({ enable: true, ipv6: false, "enhanced-mode": "redir-host", "respect-rules": true, nameserver: dns, "proxy-server-nameserver": ["1.1.1.1", "8.8.8.8"] })}`,
    "proxies:", `  - ${JSON.stringify(proxy)}`,
    "proxy-groups:", `  - ${JSON.stringify({ name: "Northstar", type: "select", proxies: [input.name] })}`,
    "rules:", '  - "MATCH,Northstar"', "",
  ].join("\n");
}
