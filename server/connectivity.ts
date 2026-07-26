import { listControlNodes } from "./control-db";

export type ConnectivityState = "healthy" | "attention" | "unavailable" | "not_configured" | "unknown";

type ProtocolObservation = {
  installed?: boolean;
  interfaceActive?: boolean;
  serviceActive?: boolean;
  listening?: boolean | null;
  port?: number;
  transport?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function protocolAssessment(protocol: "wireguard" | "openvpn", raw: unknown) {
  const rawObserved = record(raw);
  const observed = rawObserved as ProtocolObservation;
  const runtimeActive = protocol === "wireguard" ? observed.interfaceActive : observed.serviceActive;
  const state: ConnectivityState = !Object.keys(rawObserved).length ? "unknown"
    : !observed.installed ? "unavailable"
    : observed.listening === true && runtimeActive ? "healthy"
      : runtimeActive ? "attention" : "not_configured";
  return {
    protocol,
    state,
    transport: observed.transport || "udp",
    port: Number.isFinite(observed.port) ? observed.port : protocol === "wireguard" ? 51820 : 1194,
    installed: Boolean(observed.installed),
    runtimeActive: Boolean(runtimeActive),
    listening: observed.listening === true,
  };
}

export async function getNodeConnectivity(nodeId: string) {
  const node = (await listControlNodes()).find((item) => item.id === nodeId);
  if (!node) return undefined;
  const capabilities = record(node.capabilities);
  const snapshot = record(capabilities.connectivity);
  const firewall = record(snapshot.firewall);
  const managedRules = record(firewall.managedRules);
  const protocols = record(snapshot.protocols);
  const assessed = [
    protocolAssessment("wireguard", protocols.wireguard),
    protocolAssessment("openvpn", protocols.openvpn),
  ].map((item) => ({
    ...item,
    hostFirewall: managedRules[`${item.transport}/${item.port}`] === true ? "managed" : firewall.inputPolicy === "accept" ? "permissive" : "unknown",
    cloudFirewall: "unverified" as const,
  }));
  const heartbeatAt = node.last_heartbeat_at || null;
  const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : Number.NaN;
  const heartbeatFresh = Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime <= 90_000;
  const protocolStates = assessed.map((item) => item.state);
  const status: ConnectivityState = !heartbeatFresh ? "attention"
    : protocolStates.includes("attention") ? "attention"
      : protocolStates.includes("healthy") ? "healthy"
        : protocolStates.every((state) => state === "unavailable") ? "unavailable" : "not_configured";
  return {
    status,
    agentChannel: heartbeatFresh ? "healthy" : "attention",
    lastAuthenticatedHeartbeat: heartbeatAt,
    firewall: { manager: typeof firewall.manager === "string" ? firewall.manager : "unknown", inputPolicy: typeof firewall.inputPolicy === "string" ? firewall.inputPolicy : "unknown" },
    protocols: assessed,
    note: "Cloud security groups and network ACLs cannot be inspected without a provider integration; keep their status unverified until an adapter is configured.",
  };
}
