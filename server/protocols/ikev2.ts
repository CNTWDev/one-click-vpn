import type { ProtocolAdapter } from "./types";

export const ikev2Adapter: ProtocolAdapter = {
  id: "ikev2",
  capability: {
    protocol: "ikev2",
    transports: ["udp"],
    platforms: ["macos", "ios", "android"],
    routing: ["full", "split"],
    ipv6: true,
    minClientVersion: "0.1.0",
    configSchemaVersion: 1,
    status: "planned",
  },
  service: {
    standard: false, defaultTransport: "udp", defaultListenPort: 500,
    defaultSubnet: "10.72.0.0/24", defaultDns: ["1.1.1.1"],
    applyTask: "ApplyIkev2Server", restartTask: "RestartIkev2", disableTask: "DisableIkev2",
  },
  buildProfile() {
    throw new Error("IKEv2 adapter is registered but not enabled until the certificate lifecycle is configured");
  },
  buildDesiredState() {
    throw new Error("IKEv2 reconcile is not enabled until the certificate lifecycle is configured");
  },
};
