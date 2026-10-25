import type { Protocol } from "../control-db";
import { ikev2Adapter } from "./ikev2";
import { openvpnAdapter } from "./openvpn";
import { wireguardAdapter } from "./wireguard";
import { vlessAdapter } from "./vless";
import { stealthAdapter } from "./stealth";
import type { ProtocolAdapter } from "./types";

const adapters: Record<Protocol, ProtocolAdapter> = {
  wireguard: wireguardAdapter,
  openvpn: openvpnAdapter,
  ikev2: ikev2Adapter,
  vless: vlessAdapter,
  stealth: stealthAdapter,
};

export function getProtocolAdapter(protocol: Protocol): ProtocolAdapter {
  return adapters[protocol];
}

export function listProtocolAdapters(): ProtocolAdapter[] {
  return Object.values(adapters);
}
