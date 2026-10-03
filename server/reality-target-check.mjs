import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { connect } from "node:tls";

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]]) blocked.addSubnet(ip, prefix);
const global6 = new BlockList();
blocked.addSubnet("192.88.99.0", 24);
global6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]]) blocked.addSubnet(ip, prefix, "ipv6");

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address) : family === 6 && global6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function targetHostname(value) {
  if (typeof value !== "string") throw new Error("请填写独立站点的域名");
  const name = value.trim().toLowerCase();
  if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new Error("请填写公网域名，不要包含 https://、端口或路径");
  return name;
}

export function assertIndependentTarget(name, env = process.env) {
  const keys = ["APP_DOMAIN", "NORTHSTAR_PORTAL_DOMAIN", "NORTHSTAR_ADMIN_DOMAIN", "NORTHSTAR_API_DOMAIN", "NORTHSTAR_PUBLIC_ORIGIN", "NORTHSTAR_API_ORIGIN", "NORTHSTAR_AGENT_ORIGIN"];
  for (const key of keys) {
    const value = env[key]?.trim();
    if (!value) continue;
    let hostname;
    try { hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname; } catch { continue; }
    if (hostname.toLowerCase() === name) throw new Error("请使用独立静态站点域名，不要使用 APP、Console 或 API 域名");
  }
}

export async function targetAddresses(name, resolve = lookup) {
  let timer;
  try {
    const rows = await Promise.race([resolve(name, { all: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("目标 DNS 查询超时")), 5000); })]);
    const addresses = [...new Set(rows.map((row) => row.address))];
    if (!addresses.length || addresses.some((address) => !publicAddress(address))) throw new Error("目标必须只解析到公网 IP，不能指向本机或内网地址");
    return addresses;
  } finally { clearTimeout(timer); }
}

export async function checkTarget(value, { resolve = lookup, tlsConnect = connect, env = process.env } = {}) {
  const serverName = targetHostname(value);
  assertIndependentTarget(serverName, env);
  const addresses = await targetAddresses(serverName, resolve);
  // Connect to validated addresses only; never resolve the hostname a second time.
  const checks = await Promise.allSettled(addresses.slice(0, 4).map((host) => new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port: 443, servername: serverName, minVersion: "TLSv1.3", ALPNProtocols: ["h2"], rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error("HTTPS 检测超时")), 6000);
    socket.once("error", reject);
    socket.once("close", () => clearTimeout(timer));
    socket.once("secureConnect", () => {
      if (socket.alpnProtocol !== "h2") reject(new Error("请在站点 Nginx 中启用 HTTP/2"));
      else resolve({ address: host, tls: socket.getProtocol(), alpn: socket.alpnProtocol });
      socket.destroy();
    });
  })));
  const success = checks.find((result) => result.status === "fulfilled");
  if (!success) throw new Error(`目标检测失败：${checks.map((result) => result.reason?.message).join("；")}`);
  return { serverName, addresses, checkedAt: new Date().toISOString(), ...success.value };
}

export function selectTarget(explicit, existing, fallback) {
  const selected = explicit?.trim() || existing || fallback;
  if (!selected) throw new Error("请先在 VPN 服务中设置默认 REALITY 目标，或在高级设置中填写独立目标");
  return targetHostname(selected);
}
