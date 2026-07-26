import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../server/request-auth";
import { findNode } from "../../../../../server/db";
import { listNodeProtocols } from "../../../../../server/control-db";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestAdmin(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  return NextResponse.json({ node: {
    id: node.id,
    name: node.name,
    place: node.place,
    ip: node.ip,
    status: node.status,
    latency: node.latency,
    version: node.version,
    lastSeen: node.last_seen,
    capabilities: await listNodeProtocols(id),
  } });
}
