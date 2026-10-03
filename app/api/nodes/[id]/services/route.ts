import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { listVpnServices, type Protocol } from "../../../../../server/control-db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { configureVpnService } from "../../../../../server/vpn-services";
import { listProtocolAdapters } from "../../../../../server/protocols/registry";
import { configureReality, realitySettings } from "../../../../../server/reality";
import { realityDefaults } from "../../../../../server/reality-defaults";
import { selectTarget, targetAddresses } from "../../../../../server/reality-target-check.mjs";
import { dbQuery } from "../../../../../server/db";
import { lookup } from "node:dns/promises";
import { setNodeDeploymentPolicy } from "../../../../../server/deployment-policy";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  const id = (await params).id;
  const reality = await realitySettings(id);
  return NextResponse.json({ services: await listVpnServices(id), reality: reality ? { serverName: reality.server_name } : null });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const protocol = cleanText(body.protocol, 32) as Protocol;
    const action = cleanText(body.action, 32) as "enable" | "disable" | "restart" | "redeploy";
    const adapter = listProtocolAdapters().find((item) => item.id === protocol && item.capability.status === "enabled");
    if (!adapter) return jsonError("Unsupported VPN service protocol");
    if (!["enable", "disable", "restart", "redeploy"].includes(action)) return jsonError("Unsupported VPN service action");
    const transport = cleanText(body.transport, 16) || undefined;
    if (transport && !adapter.capability.transports.includes(transport)) return jsonError("Unsupported transport for this protocol");
    const requestedPort = body.listenPort === undefined ? undefined : Number(body.listenPort);
    if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535)) return jsonError("listenPort must be between 1 and 65535");
    const nodeId = (await params).id;
    if (protocol === "vless" && ["enable", "redeploy"].includes(action)) {
      const existing = await realitySettings(nodeId);
      const selected = selectTarget(cleanText(body.serverName, 253), existing?.server_name, (await realityDefaults()).serverName);
      // A management host can also be a VPN node, but never its own REALITY target on :443.
      const node = (await dbQuery<{ ip: string; public_endpoint: string | null }>("SELECT ip,public_endpoint FROM nodes WHERE id=$1", [nodeId]))[0];
      if (!node) return jsonError("Node not found", 404);
      const current = (await listVpnServices(nodeId)).find((service) => service.protocol === "vless");
      if ((requestedPort || current?.listen_port || 443) === 443) {
        const addresses = await targetAddresses(selected);
        const endpoints = [...new Set([node.ip, node.public_endpoint].filter((value): value is string => Boolean(value)))];
        const nodeAddresses = (await Promise.all(endpoints.map((host) => lookup(host, { all: true })))).flat().map((row) => row.address);
        if (nodeAddresses.some((address) => addresses.includes(address))) return jsonError("目标站点与节点是同一台服务器，不能同时使用 443。请使用独立 VPN 节点，或在高级设置中改用空闲端口。");
      }
      await configureReality(nodeId, selected);
    }
    const service = await configureVpnService({
      nodeId, protocol, action, actorUserId: user.id,
      transport,
      listenPort: requestedPort,
    });
    if (body.customize === true) await setNodeDeploymentPolicy(nodeId, "custom", 0);
    return NextResponse.json({ service });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to configure VPN service", 409);
  }
}
