import { NextResponse } from "next/server";
import { requestUser } from "../../../../../../server/request-auth";
import { findNode } from "../../../../../../server/db";
import { getNodeReconcileStatus } from "../../../../../../server/control-db";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  return NextResponse.json({ nodeId: id, status: node.status, lastSeen: node.last_seen, reconcile: await getNodeReconcileStatus(id) });
}
