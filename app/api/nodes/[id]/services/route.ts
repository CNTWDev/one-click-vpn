import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { listVpnServices, type Protocol } from "../../../../../server/control-db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { configureVpnService } from "../../../../../server/vpn-services";
import { listProtocolAdapters } from "../../../../../server/protocols/registry";
import { configureReality, realitySettings } from "../../../../../server/reality";
import { selectTarget } from "../../../../../server/reality-target-check.mjs";
import { assertTargetNotOnNode, defaultRealityTarget } from "../../../../../server/service-prerequisites";

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
      const explicit = cleanText(body.serverName, 253);
      const fallback = explicit || existing ? undefined : await defaultRealityTarget(nodeId);
      if (fallback && !fallback.serverName) return jsonError(fallback.reason || "REALITY 目标暂不可用", 409);
      const selected = selectTarget(explicit, existing?.server_name, fallback?.serverName);
      const current = (await listVpnServices(nodeId)).find((service) => service.protocol === "vless");
      await assertTargetNotOnNode(nodeId, selected, requestedPort || current?.listen_port || 443);
      await configureReality(nodeId, selected);
    }
    const service = await configureVpnService({
      nodeId, protocol, action, actorUserId: user.id,
      transport,
      listenPort: requestedPort,
    });
    // Per-protocol overrides (port/target) keep the node on the standard policy.
    return NextResponse.json({ service });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to configure VPN service", 409);
  }
}
