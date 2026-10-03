// Plain ESM so Node tests and the Next build can both import it without a TS loader.
const privateNetworks = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16"];
// Geo data from a CDN reachable in mainland China; clients fetch it once and cache it.
const geoData = "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release";

/** Fixed YAML keys + JSON flow values: no interpolation of user data into YAML syntax. */
/**
 * @param {Array<Record<string, unknown> & { name: string; type: string }>} proxies
 * @param {{ mode?: "smart" | "global" }} [options]
 */
export function renderMihomoConfig(proxies, options = {}) {
  if (!proxies.length) throw new Error("节点尚未就绪，请稍后刷新订阅");
  const names = proxies.map((proxy) => proxy.name);
  const smart = (options.mode || "smart") === "smart";
  const config = {
    "mixed-port": 7890, "allow-lan": false, "bind-address": "127.0.0.1", mode: "rule", "log-level": "warning", ipv6: false,
    ...(smart ? { "geodata-mode": true, "geo-auto-update": false, "geox-url": { geoip: `${geoData}/geoip.dat`, geosite: `${geoData}/geosite.dat`, mmdb: `${geoData}/country.mmdb` } } : {}),
    dns: { enable: true, ipv6: false, "enhanced-mode": "redir-host", "respect-rules": true,
      "default-nameserver": ["223.5.5.5", "119.29.29.29"],
      nameserver: ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"],
      ...(smart ? { "nameserver-policy": { "geosite:cn,private": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"] } } : {}),
      // Resolves node hostnames before the tunnel exists; domestic resolvers are reachable everywhere.
      "proxy-server-nameserver": ["https://doh.pub/dns-query", "223.5.5.5"] },
    proxies,
    "proxy-groups": [
      { name: "Northstar", type: "select", proxies: ["自动选择", ...names] },
      { name: "自动选择", type: "url-test", proxies: names, url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 80 },
    ],
    rules: smart
      ? [...privateNetworks.map((cidr) => `IP-CIDR,${cidr},DIRECT,no-resolve`), "GEOSITE,private,DIRECT", "GEOSITE,cn,DIRECT", "GEOIP,CN,DIRECT", "MATCH,Northstar"]
      : [...privateNetworks.map((cidr) => `IP-CIDR,${cidr},DIRECT,no-resolve`), "MATCH,Northstar"],
  };
  return Object.entries(config).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n";
}

