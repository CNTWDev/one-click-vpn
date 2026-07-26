import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { listVpnServices, type Protocol } from "../../../../../server/control-db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { configureVpnService } from "../../../../../server/vpn-services";
import { listProtocolAdapters } from "../../../../../server/protocols/registry";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  return NextResponse.json({ services: await listVpnServices((await params).id) });
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
    const service = await configureVpnService({
      nodeId: (await params).id, protocol, action, actorUserId: user.id,
      transport,
      listenPort: requestedPort,
    });
    return NextResponse.json({ service });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to configure VPN service", 409);
  }
}
