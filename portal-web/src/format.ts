/** Pure formatting helpers shared by the Portal views (zh-CN everywhere, independent of the OS locale). */
export const protocolLabel = (value: string) => value === "wireguard" ? "WireGuard" : value === "openvpn" ? "OpenVPN" : value === "vless" ? "VLESS + REALITY" : value;
export const protocolBadge = (value: string, subscription = false) => subscription ? "订阅" : value === "wireguard" ? "WG" : value === "openvpn" ? "OVPN" : value === "vless" ? "VLESS" : value.toUpperCase();

export function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

const absolute = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const dayOnly = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const relative = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
const parse = (value?: string | null) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; };

/** "2026年10月3日 14:04" */
export const dateLabel = (value?: string | null, fallback = "尚无记录") => { const date = parse(value); return date ? absolute.format(date) : value ? "时间未知" : fallback; };
/** "2026年10月3日" */
export const dayLabel = (value?: string | null, fallback = "长期有效") => { const date = parse(value); return date ? dayOnly.format(date) : fallback; };
/** "3 分钟前" / "2 天后" */
export function relativeLabel(value?: string | null, fallback = "尚无记录", now = Date.now()) {
  const date = parse(value);
  if (!date) return value ? "时间未知" : fallback;
  const seconds = Math.round((date.getTime() - now) / 1000);
  if (Math.abs(seconds) < 45) return "刚刚";
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [["minute", 60], ["hour", 3600], ["day", 86400], ["month", 2592000], ["year", 31536000]];
  let unit: [Intl.RelativeTimeFormatUnit, number] = steps[0];
  for (const step of steps) if (Math.abs(seconds) >= step[1]) unit = step;
  return relative.format(Math.round(seconds / unit[1]), unit[0]);
}

/** Subscription URL builder; the server defaults to format=clash and mode=smart, so only non-defaults are added. */
export type SubscriptionFormat = "clash" | "v2ray";
export type RoutingMode = "smart" | "global";
export function subscriptionLink(token: string, options: { format?: SubscriptionFormat; mode?: RoutingMode } = {}, origin = window.location.origin) {
  const query = new URLSearchParams({ token });
  if (options.format === "v2ray") query.set("format", "v2ray");
  if (options.mode === "global") query.set("mode", "global");
  return `${origin}/api/subscription?${query.toString()}`;
}
const base64Url = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const importUrls = {
  clash: (link: string) => `clash://install-config?url=${encodeURIComponent(link)}&name=Northstar`,
  hiddify: (link: string) => `hiddify://import/${encodeURIComponent(link)}#Northstar`,
  shadowrocket: (link: string) => `shadowrocket://add/sub://${base64Url(link)}?remark=Northstar`,
};

export type Platform = "ios" | "android" | "mac" | "windows" | "linux";
export function detectPlatform(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "mac";
  if (/Windows/i.test(userAgent)) return "windows";
  return "linux";
}
export const platformName: Record<Platform, string> = { ios: "iPhone / iPad", android: "Android", mac: "Mac", windows: "Windows", linux: "Linux" };
