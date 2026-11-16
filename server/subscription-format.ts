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

const APP_NAMES: Array<[RegExp, string]> = [
  [/shadowrocket/, "Shadowrocket"], [/hiddify/, "Hiddify"], [/v2rayng/, "v2rayNG"], [/v2rayn/, "v2rayN"], [/stash/, "Stash"],
  [/clash.?verge|verge/, "Clash Verge"], [/clashx/, "ClashX"], [/nekobox/, "NekoBox"], [/loon/, "Loon"], [/quantumult/, "Quantumult X"],
  [/mihomo|clash/, "Clash"],
];
/** The app behind a subscription refresh, by its User-Agent ("Shadowrocket"), or "" when unknown. */
export function subscriptionAppName(userAgent: string | null): string {
  const agent = (userAgent || "").toLowerCase();
  return APP_NAMES.find(([pattern]) => pattern.test(agent))?.[1] || "";
}

export function routingMode(requested: string | null): RoutingMode {
  return requested === "global" ? "global" : "smart";
}

/** One node of a subscription: its lines in fallback order (Hysteria2, REALITY, XHTTP) under the node's name. */
export type SubscriptionNode = { name: string; proxies: SubscriptionProxy[] };

/** Which of a node's extra lines the requesting client can use. REALITY is always sent. */
export type SubscriptionClient = { hysteria2: boolean; xhttp: boolean; sni?: boolean };

// mihomo dials VLESS over XHTTP from v1.19.22 on; an older core would try the line as plain TCP and fail.
const MIHOMO_XHTTP = [1, 19, 22];

/**
 * Clash YAML goes to mihomo cores, which pin the Hysteria2 certificate. Hiddify (no longer offered, but old
 * imports still refresh) reads Clash YAML into sing-box, whose pin and XHTTP support are unverified, so it
 * keeps REALITY only. Stash has its own core: it documents VLESS REALITY over XHTTP but no certificate pin
 * for Hysteria2, and names the REALITY server name `sni`, so it gets REALITY + XHTTP with `sni` set. Share links carry the pin
 * as pinSHA256, which only clients known to check it get (the user rule: no Hysteria2 without a pin).
 */
export function subscriptionClient(format: SubscriptionFormat, userAgent: string | null): SubscriptionClient {
  const agent = (userAgent || "").toLowerCase();
  if (format === "v2ray") return { hysteria2: /v2rayn/.test(agent), xhttp: true };
  if (/hiddify/.test(agent)) return { hysteria2: false, xhttp: false };
  if (/stash/.test(agent)) return { hysteria2: false, xhttp: true, sni: true };
  const version = /mihomo\/v?(\d+)\.(\d+)\.(\d+)/.exec(agent)?.slice(1).map(Number);
  const older = version ? version.findIndex((part, index) => part !== MIHOMO_XHTTP[index]) : -1;
  return { hysteria2: true, xhttp: !version || older === -1 || version[older] > MIHOMO_XHTTP[older] };
}

/**
 * Line names. Clash shows the node (a hidden fallback group) and keeps its lines out of sight; link-based
 * clients list every line, so the main line keeps the node's name and the others read as its backups.
 */
export function lineNames(node: string, count: number, format: SubscriptionFormat): string[] {
  if (count === 1) return [node];
  return Array.from({ length: count }, (_, index) => format === "clash" ? `${node} · 线路 ${index + 1}` : index ? `${node} · 备用 ${index}` : node);
}

/** Clash/Mihomo YAML shared by subscriptions and single-profile exports. */
export function renderSubscription(proxies: SubscriptionProxy[], options: { mode?: RoutingMode; group?: string; nodes?: Array<{ name: string; proxies: string[] }> } = {}): string {
  return renderMihomoConfig(proxies, options);
}

/** Standard share link understood by Shadowrocket, v2rayN/v2rayNG, NekoBox, Hiddify and sing-box importers. */
export function vlessShareLink(proxy: SubscriptionProxy): string {
  const reality = (proxy["reality-opts"] || {}) as Record<string, unknown>;
  const host = String(proxy.server);
  const xhttp = proxy.network === "xhttp" ? (proxy["xhttp-opts"] || {}) as Record<string, unknown> : null;
  const params = new URLSearchParams({
    encryption: "none", ...(xhttp ? {} : { flow: String(proxy.flow || "xtls-rprx-vision") }), security: "reality", sni: String(proxy.servername || ""),
    fp: String(proxy["client-fingerprint"] || "chrome"), pbk: String(reality["public-key"] || ""), sid: String(reality["short-id"] || ""),
    ...(xhttp ? { type: "xhttp", path: String(xhttp.path || "/"), mode: "auto" } : { type: "tcp", headerType: "none" }),
  });
  return `vless://${encodeURIComponent(String(proxy.uuid))}@${host.includes(":") ? `[${host}]` : host}:${Number(proxy.port)}?${params}#${encodeURIComponent(proxy.name)}`;
}

/** Hysteria2 URI (the official scheme): Salamander obfuscation, the node's self-signed certificate pinned. */
export function hysteria2ShareLink(proxy: SubscriptionProxy): string {
  const host = String(proxy.server);
  const params = new URLSearchParams({ sni: String(proxy.sni || ""), obfs: "salamander", "obfs-password": String(proxy["obfs-password"] || ""),
    insecure: "1", pinSHA256: String(proxy.fingerprint || "") });
  return `hysteria2://${encodeURIComponent(String(proxy.password))}@${host.includes(":") ? `[${host}]` : host}:${Number(proxy.port)}/?${params}#${encodeURIComponent(proxy.name)}`;
}

function shareLink(proxy: SubscriptionProxy): string | null {
  if (proxy.type === "hysteria2") return proxy.fingerprint ? hysteria2ShareLink(proxy) : null;
  return proxy.type === "vless" ? vlessShareLink(proxy) : null;
}

/** Base64 list of share links (the "v2ray" subscription format). VLESS and Hysteria2; WireGuard stays on Clash. */
export function renderV2raySubscription(proxies: SubscriptionProxy[]) {
  const links = proxies.map(shareLink).filter((link): link is string => Boolean(link));
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
