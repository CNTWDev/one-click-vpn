import type { ProtocolAdapter, ProtocolCapability } from "./types";

// Fits mobile/PPPoE paths that cannot carry 1420-byte tunnel packets without fragmentation.
export const WIREGUARD_CLIENT_MTU = 1280;

/**
 * The tunnel is IPv4-only, but a full-tunnel profile must still claim ::/0. Otherwise Android
 * (and any dual-stack network) sends IPv6 straight out of the carrier, so YouTube sees a different
 * country than the IPv4 tunnel and refuses playback. Claiming ::/0 without an IPv6 address makes
 * IPv6 fail fast and apps fall back to IPv4 inside the tunnel. Applied at render time so profiles
 * that were already issued are fixed on their next download.
 */
export function nativeWireGuardAllowedIps(allowedIps: string[]): string[] {
  return allowedIps.includes("0.0.0.0/0") && !allowedIps.includes("::/0") ? [...allowedIps, "::/0"] : allowedIps;
}

const baseCapability: ProtocolCapability = {
  protocol: "wireguard" as const,
  transports: ["udp"],
  platforms: ["web", "macos", "ios", "android", "windows", "linux"],
  routing: ["full", "split"],
  ipv6: false,
  minClientVersion: "0.1.0",
  configSchemaVersion: 1,
  status: "enabled" as const,
};

export const wireguardAdapter: ProtocolAdapter = {
  id: "wireguard",
  capability: baseCapability,
  service: {
    standard: true, defaultTransport: "udp", defaultListenPort: 51820,
    defaultSubnet: "10.70.0.0/20", defaultDns: ["1.1.1.1"],
    applyTask: "ApplyWireGuardPeers", restartTask: "RestartWireGuard", disableTask: "DisableWireGuard",
  },
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
      subnet: input.subnet || "10.70.0.0/20",
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
