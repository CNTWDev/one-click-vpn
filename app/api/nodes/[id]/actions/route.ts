import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { countRunningNodeActions, findNode } from "../../../../../server/db";
import { jsonError } from "../../../../../server/http";
import { queueNodeAction } from "../../../../../server/bootstrap";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = body.action === "restart-agent" || body.action === "status-agent" ? body.action : null;
  if (!action) return jsonError("Unsupported node action");
  try {
    if (!(await findNode(id))) return jsonError("Node not found", 404);
    if (await countRunningNodeActions(id) > 0) return jsonError("This node already has a queued or running action. Wait for it to finish.", 409);
    const actionId = await queueNodeAction(id, action, user.id);
    return NextResponse.json({ ok: true, actionId, status: "queued" }, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Node action failed", 502);
  }
}
