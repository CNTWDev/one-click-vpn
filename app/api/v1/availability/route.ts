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
    for (const node of regionNodes) {
      const healthy = services.filter((service) => service.node_id === node.id && service.enabled && service.status === "healthy");
      for (const service of healthy) {
        const capability = (await listNodeProtocols(node.id)).find((item) => item.protocol === service.protocol);
        if (capability?.status === "enabled") {
          protocols.add(service.protocol);
          healthyNodeIds.add(node.id);
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
    });
  }
  return NextResponse.json({ regions: available });
}
