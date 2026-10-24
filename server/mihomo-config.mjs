// Plain ESM so Node tests and the Next build can both import it without a TS loader.
const privateNetworks = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16"];
// Small rule sets (~0.6 MB in total) instead of the full geo databases. A rule set that fails to
// download leaves the profile usable (that traffic is proxied) and is retried, whereas a missing
// geo database stops the whole profile from loading. Fetched through the tunnel, refreshed daily.
const ruleSets = "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo";
const ruleSet = (kind, name, behavior) => ({ type: "http", behavior, format: "mrs", url: `${ruleSets}/${kind}/${name}.mrs`,
  path: `./veilbird-rules/${kind}-${name}.mrs`, interval: 86400, proxy: "TrackNothing" });

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
    dns: { enable: true, ipv6: false, "enhanced-mode": "redir-host", "respect-rules": true,
      "default-nameserver": ["223.5.5.5", "119.29.29.29"],
      nameserver: ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"],
      ...(smart ? { "nameserver-policy": { "rule-set:private_domain,cn_domain": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"] } } : {}),
      // Resolves node hostnames before the tunnel exists; domestic resolvers are reachable everywhere.
      "proxy-server-nameserver": ["https://doh.pub/dns-query", "223.5.5.5"] },
    proxies,
    "proxy-groups": [
      // Default: lowest measured latency, switching away from a node that stops answering.
      { name: "TrackNothing", type: "select", proxies: ["自动选择", ...names] },
      { name: "自动选择", type: "url-test", proxies: names, url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 50 },
      // The client's own "Global" switch uses this group; without it Mihomo defaults to DIRECT.
      // It follows the TrackNothing choice unless a node is picked here.
      { name: "GLOBAL", type: "select", proxies: ["TrackNothing", "自动选择", ...names] },
    ],
    ...(smart ? { "rule-providers": {
      private_domain: ruleSet("geosite", "private", "domain"), cn_domain: ruleSet("geosite", "cn", "domain"), cn_ip: ruleSet("geoip", "cn", "ipcidr"),
    } } : {}),
    rules: smart
      ? [...privateNetworks.map((cidr) => `IP-CIDR,${cidr},DIRECT,no-resolve`), "RULE-SET,private_domain,DIRECT", "RULE-SET,cn_domain,DIRECT", "RULE-SET,cn_ip,DIRECT", "MATCH,TrackNothing"]
      : [...privateNetworks.map((cidr) => `IP-CIDR,${cidr},DIRECT,no-resolve`), "MATCH,TrackNothing"],
  };
  return Object.entries(config).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n";
}
