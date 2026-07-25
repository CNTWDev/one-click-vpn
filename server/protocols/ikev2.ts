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
  buildProfile() {
    throw new Error("IKEv2 adapter is registered but not enabled until the certificate lifecycle is configured");
  },
  buildDesiredState() {
    throw new Error("IKEv2 reconcile is not enabled until the certificate lifecycle is configured");
  },
};

