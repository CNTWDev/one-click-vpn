import { NextResponse } from "next/server";
import { requestUser } from "../../../../../server/request-auth";
import { findNode } from "../../../../../server/db";
import { listNodeProtocols } from "../../../../../server/control-db";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = findNode(id);
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
    capabilities: listNodeProtocols(id),
  } });
}

