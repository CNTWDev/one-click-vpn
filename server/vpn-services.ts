import { addAudit } from "./db";
import {
  enqueueReconcileTask,
  findDesiredConfig,
  findVpnService,
  listNodeProtocols,
  listVpnServices,
  updateVpnServiceState,
  upsertVpnService,
  type Protocol,
  type VpnService,
} from "./control-db";
import { rebuildDesiredState } from "./control-plane";
import { getProtocolAdapter, listProtocolAdapters } from "./protocols/registry";
import { setNodeDeploymentPolicy, STANDARD_POLICY_VERSION } from "./deployment-policy";

export type DeploymentTemplate = "standard" | "wireguard" | "openvpn" | "agent-only";
export function protocolsForTemplate(template: DeploymentTemplate): Protocol[] {
  if (template === "wireguard") return ["wireguard"];
  if (template === "openvpn") return ["openvpn"];
  if (template === "agent-only") return [];
  return listProtocolAdapters().filter((adapter) => adapter.capability.status === "enabled" && adapter.service.standard).map((adapter) => adapter.id);
}

export async function initializeVpnServices(nodeId: string, template: DeploymentTemplate = "standard"): Promise<VpnService[]> {
  for (const protocol of protocolsForTemplate(template)) {
    const service = getProtocolAdapter(protocol).service;
    await upsertVpnService({
      nodeId, protocol, enabled: true, status: "pending", transport: service.defaultTransport,
      listenPort: service.defaultListenPort, subnet: service.defaultSubnet, dns: service.defaultDns,
    });
  }
  await setNodeDeploymentPolicy(nodeId, template === "standard" ? "standard" : template === "agent-only" ? "agent-only" : "custom", template === "standard" ? STANDARD_POLICY_VERSION : 0);
  return listVpnServices(nodeId);
}

export async function reconcileEnabledVpnServices(nodeId: string): Promise<void> {
  const capabilities = await listNodeProtocols(nodeId);
  for (const service of await listVpnServices(nodeId)) {
    if (!service.enabled) continue;
    if (service.status === "healthy" || service.status === "deploying" || service.status === "attention") continue;
    const capability = capabilities.find((item) => item.protocol === service.protocol);
    if (!capability || capability.status !== "enabled") {
      await updateVpnServiceState(nodeId, service.protocol, { status: "unsupported", lastError: "The Agent does not currently advertise this protocol runtime" });
      continue;
    }
    try {
      await updateVpnServiceState(nodeId, service.protocol, { status: "deploying" });
      await rebuildDesiredState(nodeId, service.protocol, { force: true });
    } catch (error) {
      await updateVpnServiceState(nodeId, service.protocol, { status: "attention", lastError: error instanceof Error ? error.message : String(error) });
    }
  }
}

export async function configureVpnService(input: {
  nodeId: string; protocol: Protocol; action: "enable" | "disable" | "restart" | "redeploy";
  actorUserId?: string; transport?: string; listenPort?: number;
}): Promise<VpnService> {
  const adapter = listProtocolAdapters().find((item) => item.id === input.protocol);
  if (!adapter) throw new Error("Unsupported VPN service protocol");
  if (adapter.capability.status !== "enabled") throw new Error(`${input.protocol} is not enabled`);
  const current = await findVpnService(input.nodeId, input.protocol);
  if (input.action === "restart") {
    if (!current?.enabled) throw new Error(`${input.protocol} service is not enabled on this node`);
    const desired = await findDesiredConfig(input.nodeId, input.protocol);
    if (!desired) throw new Error(`${input.protocol} service has no deployed configuration`);
    await updateVpnServiceState(input.nodeId, input.protocol, { status: "deploying" });
    await enqueueReconcileTask({
      nodeId: input.nodeId, protocol: input.protocol,
      taskType: adapter.service.restartTask,
      desiredRevision: desired.revision, payload: desired.payload,
    });
    await addAudit({ actorUserId: input.actorUserId, action: "vpn_service.restart", targetType: "node", targetId: input.nodeId, metadata: { protocol: input.protocol } });
    return (await findVpnService(input.nodeId, input.protocol))!;
  }
  if (input.action === "disable") {
    const service = await upsertVpnService({
      nodeId: input.nodeId, protocol: input.protocol, enabled: false,
      transport: input.transport || current?.transport, listenPort: input.listenPort || current?.listen_port,
      subnet: current?.subnet, dns: current?.dns, status: "deploying",
    });
    const desired = await findDesiredConfig(input.nodeId, input.protocol);
    await enqueueReconcileTask({
      nodeId: input.nodeId, protocol: input.protocol,
      taskType: adapter.service.disableTask,
      desiredRevision: desired?.revision || 0, payload: { disabled: true },
    });
    await addAudit({ actorUserId: input.actorUserId, action: "vpn_service.disable", targetType: "node", targetId: input.nodeId, metadata: { protocol: input.protocol } });
    await setNodeDeploymentPolicy(input.nodeId, "custom", 0);
    return service;
  }
  const service = await upsertVpnService({
    nodeId: input.nodeId, protocol: input.protocol, enabled: true,
    transport: input.transport || current?.transport, listenPort: input.listenPort || current?.listen_port,
    subnet: current?.subnet, dns: current?.dns, status: "deploying",
  });
  try {
    await rebuildDesiredState(input.nodeId, input.protocol, { force: true });
  } catch (error) {
    await updateVpnServiceState(input.nodeId, input.protocol, { status: "attention", lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  await addAudit({ actorUserId: input.actorUserId, action: `vpn_service.${input.action}`, targetType: "node", targetId: input.nodeId, metadata: { protocol: input.protocol } });
  if (input.action === "enable") {
    const enabled = (await listVpnServices(input.nodeId)).filter((item) => item.enabled).map((item) => item.protocol).sort();
    const standard = protocolsForTemplate("standard").sort();
    const followsStandard = enabled.length === standard.length && enabled.every((protocol, index) => protocol === standard[index]);
    await setNodeDeploymentPolicy(input.nodeId, followsStandard ? "standard" : "custom", followsStandard ? STANDARD_POLICY_VERSION : 0);
  }
  return service;
}
