import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { findNode } from "../../../../../server/db";
import { findControlNode } from "../../../../../server/control-db";
import { jsonError } from "../../../../../server/http";
import { getNodeConnectivity } from "../../../../../server/connectivity";
import { tcpReachable } from "../../../../../server/port-reach";
import { agentSupportsPortCheck, currentPortCheck, startPortCheck, type PortCheck, type PortCheckPort } from "../../../../../server/port-check";

export const runtime = "nodejs";

function view(check: PortCheck | undefined) {
  return check ? { id: check.id, status: check.status, startedAt: new Date(check.startedAt).toISOString(), results: check.results, error: check.error } : null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  return NextResponse.json({ check: view(currentPortCheck(id)) });
}

/** Re-tests the node's TCP ports now and starts the UDP check (Agent 2.16+). */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  const connectivity = await getNodeConnectivity(id);
  const ports = new Map<string, PortCheckPort>();
  for (const protocol of connectivity?.protocols || []) {
    if (!protocol.configured) continue;
    for (const item of protocol.ports) if (item.transport === "udp" || item.transport === "tcp") ports.set(`${item.transport}/${item.port}`, { transport: item.transport, port: item.port });
  }
  const host = (await findControlNode(id))?.public_endpoint || node.ip;
  await Promise.all([...ports.values()].filter((item) => item.transport === "tcp").map((item) => tcpReachable(host, item.port, { fresh: true })));
  const udp = [...ports.values()].filter((item) => item.transport === "udp");
  if (!udp.length) return NextResponse.json({ check: null, udp: "none" });
  if (!agentSupportsPortCheck(node.version)) return NextResponse.json({ check: null, udp: "agent-outdated" });
  try {
    return NextResponse.json({ check: view(await startPortCheck(id, udp)), udp: "checking" }, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Port check failed", 502);
  }
}
