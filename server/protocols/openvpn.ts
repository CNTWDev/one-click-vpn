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
    status: "enabled",
  },
  buildProfile(input) {
    if (!input.clientAddress) throw new Error("OpenVPN client address is not allocated");
    if (!input.openvpn) throw new Error("OpenVPN client credentials are not available");
    if (input.transport !== "udp" && input.transport !== "tcp") throw new Error("OpenVPN transport must be udp or tcp");
    return {
      transport: input.transport,
      dns: input.dns,
      allowedIps: input.allowedIps,
      protocolPayload: {
        clientAddress: input.clientAddress,
        clientCertificate: input.openvpn.clientCertificate,
        clientKeySecretId: input.openvpn.clientKeySecretId,
        caCertificate: input.openvpn.caCertificate,
        tlsCryptSecretId: input.openvpn.tlsCryptSecretId,
      },
    };
  },
  buildDesiredState(input) {
    if (!input.openvpn) throw new Error("OpenVPN server credentials are not available");
    return {
      schemaVersion: 1,
      interface: "northstar-openvpn",
      serverBundleSecretId: input.openvpn.serverBundleSecretId,
      revokedSerials: input.openvpn.revokedSerials,
      transport: input.openvpn.transport,
      subnet: input.openvpn.subnet,
      listenPort: input.openvpn.listenPort,
      dns: input.openvpn.dns,
    };
  },
};
