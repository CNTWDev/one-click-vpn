export type ClientChoice = "clash" | "wireguard" | "openvpn";
export const clientOptions: Array<{ id: ClientChoice; name: string; description: string }> = [
  { id: "clash", name: "Clash", description: "Mihomo 内核客户端" },
  { id: "wireguard", name: "WireGuard", description: "WireGuard 官方客户端" },
  { id: "openvpn", name: "OpenVPN", description: "OpenVPN Connect 等客户端" },
];
export const clientProtocol = (client: ClientChoice) => client === "openvpn" ? "openvpn" : "wireguard";
export const clientFormat = (client: ClientChoice) => client === "clash" ? "mihomo" : "native";
export const clientName = (client: ClientChoice) => clientOptions.find((item) => item.id === client)!.name;
export function usableCredential(item: { status: string; userDisabled: boolean; adminDisabled: boolean; accountStatus: string; expiresAt?: string | null }, now = Date.now()) {
  return item.status === "active" && !item.userDisabled && !item.adminDisabled && item.accountStatus === "active"
    && (!item.expiresAt || Date.parse(item.expiresAt) > now);
}
