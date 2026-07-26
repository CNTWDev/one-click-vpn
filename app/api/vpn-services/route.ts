import { NextResponse } from "next/server";
import { currentUser } from "../../../server/auth";
import { listVpnServices } from "../../../server/control-db";
import { jsonError } from "../../../server/http";
import { getNodeConnectivity } from "../../../server/connectivity";

export const runtime = "nodejs";

export async function GET() {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  const services = await listVpnServices();
  const connectivity = new Map<string, Awaited<ReturnType<typeof getNodeConnectivity>>>();
  await Promise.all([...new Set(services.map((service) => service.node_id))].map(async (nodeId) => {
    connectivity.set(nodeId, await getNodeConnectivity(nodeId));
  }));
  return NextResponse.json({ services: services.map((service) => {
    if (!service.enabled || service.status !== "healthy") return service;
    const node = connectivity.get(service.node_id);
    const runtime = node?.protocols.find((item) => item.protocol === service.protocol);
    const status = node?.agentChannel !== "healthy" ? "attention" : runtime?.state === "healthy" ? "healthy" : runtime?.state || "attention";
    return { ...service, status, last_error: service.last_error || runtime?.lastError || "" };
  }) });
}
