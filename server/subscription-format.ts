import { renderMihomoConfig } from "./mihomo-config.mjs";
export type SubscriptionProxy = Record<string, unknown> & { name: string; type: string };
export type SubscriptionFormat = "clash" | "v2ray";
export type RoutingMode = "smart" | "global";

/** Pick a format from an explicit ?format= or the client's User-Agent; Clash/Mihomo YAML is the default. */
export function subscriptionFormat(requested: string | null, userAgent: string | null): SubscriptionFormat {
  if (requested === "clash" || requested === "v2ray") return requested;
  const agent = (userAgent || "").toLowerCase();
  if (/clash|mihomo|stash|verge|hiddify/.test(agent)) return "clash";
  return /shadowrocket|v2rayn|v2rayng|quantumult|nekobox|loon/.test(agent) ? "v2ray" : "clash";
}

export function routingMode(requested: string | null): RoutingMode {
  return requested === "global" ? "global" : "smart";
}

/** Clash/Mihomo YAML shared by subscriptions and single-profile exports. */
export function renderSubscription(proxies: SubscriptionProxy[], options: { mode?: RoutingMode } = {}): string {
  return renderMihomoConfig(proxies, options);
}

/** Standard share link understood by Shadowrocket, v2rayN/v2rayNG, NekoBox, Hiddify and sing-box importers. */
export function vlessShareLink(proxy: SubscriptionProxy): string {
  const reality = (proxy["reality-opts"] || {}) as Record<string, unknown>;
  const host = String(proxy.server);
  const params = new URLSearchParams({
    encryption: "none", flow: String(proxy.flow || "xtls-rprx-vision"), security: "reality", sni: String(proxy.servername || ""),
    fp: String(proxy["client-fingerprint"] || "chrome"), pbk: String(reality["public-key"] || ""), sid: String(reality["short-id"] || ""),
    type: "tcp", headerType: "none",
  });
  return `vless://${encodeURIComponent(String(proxy.uuid))}@${host.includes(":") ? `[${host}]` : host}:${Number(proxy.port)}?${params}#${encodeURIComponent(proxy.name)}`;
}

/** Base64 list of share links (the "v2ray" subscription format). VLESS only; WireGuard stays on Clash. */
export function renderV2raySubscription(proxies: SubscriptionProxy[]) {
  const links = proxies.filter((proxy) => proxy.type === "vless").map(vlessShareLink);
  if (!links.length) throw new Error("该订阅暂无可用的 VLESS 节点，请使用 Clash 格式");
  return Buffer.from(links.join("\n") + "\n").toString("base64");
}

/** Readable, stable node names: flag + region + node name (selection survives reordering). */
export function proxyName(input: { countryCode?: string | null; region?: string | null; nodeName: string; nodeId: string }, used: Set<string>) {
  const code = (input.countryCode || "").toUpperCase();
  const flag = /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65)) : "";
  let name = [flag, input.region && input.region !== input.nodeName ? `${input.region} · ${input.nodeName}` : input.nodeName].filter(Boolean).join(" ");
  if (used.has(name)) name = `${name} · ${input.nodeId.slice(-4)}`;
  used.add(name);
  return name;
}
