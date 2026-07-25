import type { ProtocolAdapter, ProtocolCapability } from "./types";

const baseCapability: ProtocolCapability = {
  protocol: "wireguard" as const,
  transports: ["udp"],
  platforms: ["macos", "ios", "android"],
  routing: ["full", "split"],
  ipv6: false,
  minClientVersion: "0.1.0",
  configSchemaVersion: 1,
  status: "enabled" as const,
};

export const wireguardAdapter: ProtocolAdapter = {
  id: "wireguard",
  capability: baseCapability,
  buildProfile(input) {
    if (!input.serverPublicKey) throw new Error("WireGuard server public key is not available");
    if (!input.clientAddress) throw new Error("WireGuard client address is not allocated");
    if (input.transport !== "udp") throw new Error("WireGuard only supports the udp transport in this adapter");
    return {
      transport: "udp",
      dns: input.dns,
      allowedIps: input.allowedIps,
      protocolPayload: {
        serverPublicKey: input.serverPublicKey,
        clientPublicKey: input.devicePublicKey,
        clientAddress: input.clientAddress,
        persistentKeepaliveSeconds: 25,
      },
    };
  },
  buildDesiredState(input) {
    return {
      schemaVersion: 1,
      interface: "northstar",
      listenPort: input.listenPort || 51820,
      serverPublicKey: input.serverPublicKey || null,
      peers: input.peers.map((peer) => ({
        publicKey: peer.publicKey,
        allowedIps: peer.allowedIps,
        persistentKeepaliveSeconds: peer.persistentKeepaliveSeconds || 25,
      })),
    };
  },
};
