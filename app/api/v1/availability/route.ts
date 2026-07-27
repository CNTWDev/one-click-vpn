import { NextResponse } from "next/server";
import { listRegions } from "../../../../server/db";
import { listControlNodes, listNodeProtocols, listVpnServices } from "../../../../server/control-db";
import { requestUser } from "../../../../server/request-auth";
import { jsonError } from "../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Active user authentication required", 403);
  const [regions, nodes, services] = await Promise.all([listRegions(), listControlNodes(), listVpnServices()]);
  const onlineNodes = nodes.filter((node) => node.status === "online" && node.last_heartbeat_at && Date.now() - new Date(node.last_heartbeat_at).getTime() < 90_000);
  const available = [];
  for (const region of regions) {
    const regionNodes = onlineNodes.filter((node) => node.region_id === region.id);
    const protocols = new Set<string>();
    const healthyNodeIds = new Set<string>();
    const protocolNodeIds = new Map<string, Set<string>>();
    for (const node of regionNodes) {
      const healthy = services.filter((service) => service.node_id === node.id && service.enabled && service.status === "healthy");
      for (const service of healthy) {
        const capability = (await listNodeProtocols(node.id)).find((item) => item.protocol === service.protocol);
        const connectivity = node.capabilities.connectivity as { protocols?: Record<string, { runtimeActive?: boolean; interfaceActive?: boolean; serviceActive?: boolean; listening?: boolean }> } | undefined;
        const observed = connectivity?.protocols?.[service.protocol];
        const active = observed?.runtimeActive ?? observed?.interfaceActive ?? observed?.serviceActive;
        if (capability?.status === "enabled" && active === true && observed?.listening === true) {
          protocols.add(service.protocol);
          healthyNodeIds.add(node.id);
          const nodeIds = protocolNodeIds.get(service.protocol) || new Set<string>();
          nodeIds.add(node.id);
          protocolNodeIds.set(service.protocol, nodeIds);
        }
      }
    }
    available.push({
      id: region.id,
      name: region.name,
      country: region.country,
      code: region.code,
      protocols: [...protocols].sort(),
      status: protocols.size ? "available" : "unavailable",
      onlineNodeCount: regionNodes.length,
      healthyNodeCount: healthyNodeIds.size,
      protocolNodeCounts: Object.fromEntries([...protocolNodeIds].map(([protocol, nodeIds]) => [protocol, nodeIds.size])),
    });
  }
  return NextResponse.json({ regions: available });
}
