import type { Platform, Protocol } from "../control-db";

export type ProtocolCapability = {
  protocol: Protocol;
  transports: string[];
  platforms: Platform[];
  routing: string[];
  ipv6: boolean;
  minClientVersion: string;
  configSchemaVersion: number;
  status: "enabled" | "planned";
};

export type ProfileBuildInput = {
  deviceId: string;
  devicePublicKey: string;
  nodeId: string;
  endpoint: { host: string; port: number };
  serverPublicKey?: string | null;
  clientAddress?: string | null;
  transport: string;
  dns: string[];
  allowedIps: string[];
  reality?: { clientUuidSecretId: string; publicKey: string; serverName: string; shortId: string };
  openvpn?: {
    clientCertificate: string;
    clientKeySecretId: string;
    caCertificate: string;
    tlsCryptSecretId: string;
  };
};

export type PeerState = {
  expiresAt?: number;
  publicKey: string;
  allowedIps: string[];
  persistentKeepaliveSeconds?: number;
};

export type DesiredStateInput = {
  subnet?: string;
  reality?: { serverBundleSecretId: string; usersSecretId: string; serverName?: string };
  nodeId: string;
  serverPublicKey?: string | null;
  listenPort?: number;
  peers: PeerState[];
  openvpn?: {
    serverBundleSecretId: string;
    revokedSerials: string[];
    transport: string;
    subnet: string;
    listenPort: number;
    dns: string[];
  };
};

export type ProtocolAdapter = {
  id: Protocol;
  capability: ProtocolCapability;
  service: {
    standard: boolean;
    defaultTransport: string;
    defaultListenPort: number;
    defaultSubnet: string;
    defaultDns: string[];
    applyTask: string;
    restartTask: string;
    disableTask: string;
  };
  buildProfile(input: ProfileBuildInput): {
    transport: string;
    dns: string[];
    allowedIps: string[];
    protocolPayload: Record<string, unknown>;
  };
  buildDesiredState(input: DesiredStateInput): Record<string, unknown>;
};
