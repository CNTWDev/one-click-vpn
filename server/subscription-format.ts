export type SubscriptionProxy = Record<string, unknown> & { name: string; type: string };

/** Fixed YAML keys + JSON flow values: no interpolation of user data into YAML syntax. */
export function renderSubscription(proxies: SubscriptionProxy[]) {
  if (!proxies.length) throw new Error("节点尚未就绪，请稍后刷新订阅");
  const names = proxies.map((proxy) => proxy.name);
  const config = {
    "mixed-port": 7890, "allow-lan": false, "bind-address": "127.0.0.1", mode: "rule", "log-level": "warning", ipv6: false,
    dns: { enable: true, ipv6: false, "enhanced-mode": "redir-host", "respect-rules": true,
      nameserver: ["https://1.1.1.1/dns-query"], "proxy-server-nameserver": ["1.1.1.1", "8.8.8.8"] },
    proxies,
    "proxy-groups": [
      { name: "Northstar", type: "select", proxies: ["自动选择", ...names] },
      { name: "自动选择", type: "url-test", proxies: names, url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 80 },
    ], rules: ["MATCH,Northstar"],
  };
  return Object.entries(config).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n";
}
