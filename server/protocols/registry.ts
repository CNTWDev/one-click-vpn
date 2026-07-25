import type { Protocol } from "../control-db";
import { ikev2Adapter } from "./ikev2";
import { openvpnAdapter } from "./openvpn";
import { wireguardAdapter } from "./wireguard";
import type { ProtocolAdapter } from "./types";

const adapters: Record<Protocol, ProtocolAdapter> = {
  wireguard: wireguardAdapter,
  openvpn: openvpnAdapter,
  ikev2: ikev2Adapter,
};

export function getProtocolAdapter(protocol: Protocol): ProtocolAdapter {
  return adapters[protocol];
}

export function listProtocolCapabilities() {
  return Object.values(adapters).map((adapter) => adapter.capability);
}

