export type ClientChoice = "hiddify" | "clash" | "wireguard" | "openvpn";
export const clientOptions: Array<{ id: ClientChoice; name: string; description: string }> = [
  { id: "hiddify", name: "Hiddify", description: "支持 WireGuard / REALITY 配置" },
  { id: "clash", name: "Clash", description: "Mihomo 内核客户端" },
  { id: "wireguard", name: "WireGuard", description: "WireGuard 官方客户端" },
  { id: "openvpn", name: "OpenVPN", description: "OpenVPN Connect 等客户端" },
];
export const clientProtocol = (client: ClientChoice) => client === "openvpn" ? "openvpn" : "wireguard";
export const clientFormat = (client: ClientChoice) => client === "clash" || client === "hiddify" ? "mihomo" : "native";
export const clientName = (client: ClientChoice) => clientOptions.find((item) => item.id === client)!.name;
export function usableCredential(item: { status: string; userDisabled: boolean; adminDisabled: boolean; accountStatus: string; expiresAt?: string | null }, now = Date.now()) {
  return item.status === "active" && !item.userDisabled && !item.adminDisabled && item.accountStatus === "active"
    && (!item.expiresAt || Date.parse(item.expiresAt) > now);
}

/** Client apps recommended by the Portal; links point at the official download pages. */
export type AppId = "clash" | "hiddify" | "shadowrocket" | "v2rayng" | "wireguard" | "openvpn";
export const apps: Record<AppId, { name: string; letter: string; platforms: string; url: string }> = {
  clash: { name: "Clash Verge", letter: "C", platforms: "Mac · Windows · Linux", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases" },
  hiddify: { name: "Hiddify", letter: "H", platforms: "iPhone · Android · Mac · Windows", url: "https://github.com/hiddify/hiddify-app/releases" },
  shadowrocket: { name: "Shadowrocket", letter: "S", platforms: "iPhone · iPad（App Store 付费）", url: "https://apps.apple.com/app/id932747118" },
  v2rayng: { name: "v2rayNG", letter: "V", platforms: "Android", url: "https://github.com/2dust/v2rayNG/releases" },
  wireguard: { name: "WireGuard", letter: "W", platforms: "全平台官方客户端", url: "https://www.wireguard.com/install/" },
  openvpn: { name: "OpenVPN Connect", letter: "O", platforms: "全平台官方客户端", url: "https://openvpn.net/client/" },
};
export const recommendedApps = (platform: string): AppId[] => platform === "ios" ? ["shadowrocket", "hiddify"] : platform === "android" ? ["hiddify", "v2rayng"] : ["clash", "hiddify"];
