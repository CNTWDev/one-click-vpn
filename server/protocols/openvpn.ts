import type { ProtocolAdapter } from "./types";

export const openvpnAdapter: ProtocolAdapter = {
  id: "openvpn",
  capability: {
    protocol: "openvpn",
    transports: ["udp", "tcp"],
    platforms: ["macos", "ios", "android"],
    routing: ["full", "split"],
    ipv6: true,
    minClientVersion: "0.1.0",
    configSchemaVersion: 1,
    status: "planned",
  },
  buildProfile() {
    throw new Error("OpenVPN adapter is registered but not enabled until the CA lifecycle is configured");
  },
  buildDesiredState() {
    throw new Error("OpenVPN reconcile is not enabled until the CA lifecycle is configured");
  },
};

