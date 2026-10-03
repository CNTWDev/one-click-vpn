import type { ProtocolAdapter } from "./types";

export const vlessAdapter: ProtocolAdapter = {
  id: "vless",
  capability: { protocol: "vless", transports: ["tcp"], platforms: ["web", "macos", "ios", "android", "windows", "linux"],
    routing: ["full", "split"], ipv6: false, minClientVersion: "1.0.0", configSchemaVersion: 1, status: "enabled" },
  // Installed through the same standard policy as the other supported protocols.
  // Agent-side port/target checks never displace an existing listener.
  service: { standard: true, defaultTransport: "tcp", defaultListenPort: 443, defaultSubnet: "", defaultDns: ["1.1.1.1"],
    applyTask: "ApplyVlessServer", restartTask: "RestartVless", disableTask: "DisableVless" },
  buildProfile(input) {
    if (!input.reality) throw new Error("请先配置节点的 REALITY 服务");
    return { transport: "tcp", dns: input.dns, allowedIps: input.allowedIps,
      protocolPayload: { ...input.reality, flow: "xtls-rprx-vision" } };
  },
  buildDesiredState(input) {
    if (!input.reality) throw new Error("请先配置节点的 REALITY 服务");
    return { schemaVersion: 1, listenPort: input.listenPort || 443, ...input.reality };
  },
};
