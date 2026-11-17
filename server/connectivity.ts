import { getNodeReconcileStatus, findControlNode, listVpnServices, type Protocol, type VpnService } from "./control-db";
import { appTransports, tcpReachable, udpReach, udpStatus, type CloudFirewall } from "./port-reach";
import { altTcpPort, HOP_FROM, HOP_RANGE, HOP_UDP_KEY, reportedHop } from "./hop-ports";
import { hopReach } from "./hop-reach";

export type ConnectivityState = "healthy" | "attention" | "provisioning" | "unavailable" | "not_configured" | "unknown";

type ProtocolObservation = {
  installed?: boolean;
  interfaceActive?: boolean;
  serviceActive?: boolean;
  runtimeActive?: boolean;
  listening?: boolean | null;
  port?: number;
  transport?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function protocolAssessment(protocol: Protocol, raw: unknown, service: VpnService, intent: { taskStatus?: string; lastError?: string }) {
  const rawObserved = record(raw);
  const observed = rawObserved as ProtocolObservation;
  const runtimeActive = observed.runtimeActive ?? observed.interfaceActive ?? observed.serviceActive;
  const configured = service.enabled;
  const state: ConnectivityState = service.status === "deploying" || service.status === "pending" ? "provisioning"
    : !configured ? "not_configured"
    : service.status === "unsupported" ? "unavailable"
    : service.status === "attention" ? "attention"
    : !Object.keys(rawObserved).length ? "unknown"
    : !observed.installed ? "unavailable"
    : observed.listening === true && runtimeActive ? "healthy"
      : runtimeActive ? "attention"
        : intent.taskStatus === "pending" || intent.taskStatus === "running" ? "provisioning" : "attention";
  return {
    protocol,
    state,
    configured,
    taskStatus: intent.taskStatus || null,
    lastError: intent.lastError || "",
    transport: observed.transport || service.transport,
    port: Number.isFinite(observed.port) ? observed.port : service.listen_port,
    installed: Boolean(observed.installed),
    runtimeActive: Boolean(runtimeActive),
    listening: observed.listening === true,
  };
}

export async function getNodeConnectivity(nodeId: string) {
  const node = await findControlNode(nodeId);
  if (!node) return undefined;
  const capabilities = record(node.capabilities);
  const snapshot = record(capabilities.connectivity);
  const firewall = record(snapshot.firewall);
  const managedRules = record(firewall.managedRules);
  const protocols = record(snapshot.protocols);
  const reconcile = await getNodeReconcileStatus(nodeId);
  const services = await listVpnServices(nodeId);
  const assessed = services.map((service) => {
    const protocol = service.protocol;
    const latestTask = reconcile.tasks.find((task) => task.protocol === protocol);
    const observed = reconcile.observed.find((item) => item.protocol === protocol);
    return protocolAssessment(protocol, protocols[protocol], service, {
      taskStatus: typeof latestTask?.status === "string" ? latestTask.status : undefined,
      lastError: service?.last_error || (typeof latestTask?.lastError === "string" && latestTask.lastError
        ? latestTask.lastError : typeof observed?.lastError === "string" ? observed.lastError : undefined),
    });
  });
  const host = node.public_endpoint || node.ip;
  const udp = await udpReach(nodeId);
  const hop = reportedHop(capabilities), reach = hop ? await hopReach(nodeId) : {};
  const hostFirewall = (transport: string, port: number) => managedRules[`${transport}/${port}`] === true ? "managed"
    : managedRules[`${transport}/${port}`] === false ? "attention" : firewall.inputPolicy === "accept" ? "permissive" : "unknown";
  // Every port a protocol listens on (stealth: Hysteria2 on UDP and XHTTP on TCP with the same number).
  const withPorts = await Promise.all(assessed.map(async (item) => {
    const transports = item.protocol === "stealth" ? ["udp", "tcp"] : [item.transport];
    const port = Number(item.port);
    const ports = await Promise.all(transports.map(async (transport) => {
      const app = Object.entries(appTransports).find(([, value]) => value.protocol === item.protocol && value.transport === transport)?.[0];
      if (transport === "udp") return { transport, port, hostFirewall: hostFirewall(transport, port), ...udpStatus(udp, app, port) };
      const cloudFirewall: CloudFirewall = !item.configured || !item.listening ? "unverified" : await tcpReachable(host, port) ? "reachable" : "unreachable";
      return { transport, port, hostFirewall: hostFirewall(transport, port), cloudFirewall, checkedAt: null };
    }));
    // Extra ports in front of the listener (Agent 2.19+): the UDP hop range for Hysteria2, the spare REALITY port.
    // The redirect needs no host firewall rule; the cloud status is the Controller's last outside check.
    const extra: Array<{ transport: string; port: number; range?: string; role: "hop" | "spare"; hostFirewall: string; cloudFirewall: CloudFirewall; checkedAt: string | null }> = [];
    if (hop && item.configured && item.protocol === "stealth") {
      const check = reach[HOP_UDP_KEY];
      extra.push({ transport: "udp", port: HOP_FROM, range: HOP_RANGE, role: "hop", hostFirewall: hop.udp === HOP_RANGE ? "managed" : "attention",
        cloudFirewall: check ? (check.open ? "reachable" : "unreachable") : "unverified", checkedAt: check ? new Date(check.at).toISOString() : null });
    }
    if (hop && item.configured && item.protocol === "vless") {
      const spare = altTcpPort(nodeId), check = reach[`tcp/${spare}`];
      extra.push({ transport: "tcp", port: spare, role: "spare", hostFirewall: hop.tcp === spare ? "managed" : "attention",
        cloudFirewall: check ? (check.open ? "reachable" : "unreachable") : "unverified", checkedAt: check ? new Date(check.at).toISOString() : null });
    }
    // Kept for older Console builds: the first port's status.
    return { ...item, ports: [...ports, ...extra], hostFirewall: ports[0].hostFirewall, cloudFirewall: ports[0].cloudFirewall };
  }));
  const heartbeatAt = node.last_heartbeat_at || null;
  const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : Number.NaN;
  const heartbeatFresh = Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime <= 90_000;
  const configuredStates = withPorts.filter((item) => item.configured).map((item) => item.state);
  const status: ConnectivityState = !heartbeatFresh ? "attention"
    : configuredStates.includes("attention") || configuredStates.includes("unavailable") ? "attention"
      : configuredStates.includes("provisioning") ? "provisioning"
        : configuredStates.includes("healthy") ? "healthy" : "not_configured";
  return {
    status,
    agentChannel: heartbeatFresh ? "healthy" : "attention",
    lastAuthenticatedHeartbeat: heartbeatAt,
    firewall: { manager: typeof firewall.manager === "string" ? firewall.manager : "unknown", inputPolicy: typeof firewall.inputPolicy === "string" ? firewall.inputPolicy : "unknown" },
    protocols: withPorts,
    note: "Cloud firewall: TCP ports are tested from the control plane every 5 minutes; UDP ports by Check ports (the control plane sends packets, the Agent counts them), or open once an app got an answer.",
  };
}
