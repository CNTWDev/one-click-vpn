import { getNodeReconcileStatus, listControlNodes } from "./control-db";

export type ConnectivityState = "healthy" | "attention" | "provisioning" | "unavailable" | "not_configured" | "unknown";

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

function protocolAssessment(protocol: "wireguard" | "openvpn", raw: unknown, intent: { configured: boolean; taskStatus?: string; lastError?: string }) {
  const rawObserved = record(raw);
  const observed = rawObserved as ProtocolObservation;
  const runtimeActive = protocol === "wireguard" ? observed.interfaceActive : observed.serviceActive;
  const state: ConnectivityState = !Object.keys(rawObserved).length ? "unknown"
    : !observed.installed ? "unavailable"
    : observed.listening === true && runtimeActive ? "healthy"
      : runtimeActive ? "attention"
        : intent.taskStatus === "pending" || intent.taskStatus === "running" ? "provisioning"
          : intent.configured ? "attention" : "not_configured";
  return {
    protocol,
    state,
    configured: intent.configured,
    taskStatus: intent.taskStatus || null,
    lastError: intent.lastError || "",
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
  const reconcile = await getNodeReconcileStatus(nodeId);
  const assessed = (["wireguard", "openvpn"] as const).map((protocol) => {
    const latestTask = reconcile.tasks.find((task) => task.protocol === protocol);
    const observed = reconcile.observed.find((item) => item.protocol === protocol);
    return protocolAssessment(protocol, protocols[protocol], {
      configured: reconcile.desired.some((desired) => desired.protocol === protocol),
      taskStatus: typeof latestTask?.status === "string" ? latestTask.status : undefined,
      lastError: typeof latestTask?.lastError === "string" && latestTask.lastError
        ? latestTask.lastError : typeof observed?.lastError === "string" ? observed.lastError : undefined,
    });
  }).map((item) => ({
    ...item,
    hostFirewall: managedRules[`${item.transport}/${item.port}`] === true ? "managed" : firewall.inputPolicy === "accept" ? "permissive" : "unknown",
    cloudFirewall: "unverified" as const,
  }));
  const heartbeatAt = node.last_heartbeat_at || null;
  const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : Number.NaN;
  const heartbeatFresh = Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime <= 90_000;
  const configuredStates = assessed.filter((item) => item.configured).map((item) => item.state);
  const status: ConnectivityState = !heartbeatFresh ? "attention"
    : configuredStates.includes("attention") || configuredStates.includes("unavailable") ? "attention"
      : configuredStates.includes("provisioning") ? "provisioning"
        : configuredStates.includes("healthy") ? "healthy" : "not_configured";
  return {
    status,
    agentChannel: heartbeatFresh ? "healthy" : "attention",
    lastAuthenticatedHeartbeat: heartbeatAt,
    firewall: { manager: typeof firewall.manager === "string" ? firewall.manager : "unknown", inputPolicy: typeof firewall.inputPolicy === "string" ? firewall.inputPolicy : "unknown" },
    protocols: assessed,
    note: "Cloud security groups and network ACLs cannot be inspected without a provider integration; keep their status unverified until an adapter is configured.",
  };
}
