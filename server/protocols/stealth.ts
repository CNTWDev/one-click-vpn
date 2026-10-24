import type { ProtocolAdapter } from "./types";

/** Hysteria2 + VLESS REALITY XHTTP for the TrackNothing apps; one mihomo process on the node (see server/stealth.ts). */
export const stealthAdapter: ProtocolAdapter = {
  id: "stealth",
  capability: { protocol: "stealth", transports: ["udp", "tcp"], platforms: ["android"],
    routing: ["full", "split"], ipv6: false, minClientVersion: "1.0.0", configSchemaVersion: 1, status: "enabled" },
  // Part of the standard policy; Hysteria2 uses the UDP port and XHTTP the TCP port with the same number.
  service: { standard: true, defaultTransport: "udp", defaultListenPort: 8443, defaultSubnet: "", defaultDns: ["1.1.1.1"],
    applyTask: "ApplyStealthServer", restartTask: "RestartStealth", disableTask: "DisableStealth" },
  buildProfile() {
    throw new Error("抗封锁通道只供 TrackNothing App 使用，不生成单独的配置文件");
  },
  buildDesiredState(input) {
    if (!input.stealth) throw new Error("请先启用 VLESS REALITY：抗封锁通道复用它的密钥和目标域名");
    return { schemaVersion: 1, ...input.stealth };
  },
};
