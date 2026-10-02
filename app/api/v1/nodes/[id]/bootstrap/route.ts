import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../../server/request-auth";
import { addAudit, countRunningNodeActions, NodeBusyError, findNode } from "../../../../../../server/db";
import { queueNodeBootstrap } from "../../../../../../server/bootstrap";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestAdmin(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  if (!(await findNode(id))) return jsonError("Node not found", 404);
  if (await countRunningNodeActions(id) > 0) return jsonError(new NodeBusyError().message, 409);
  let actionId: string;
  try {
    actionId = await queueNodeBootstrap(id, user.id);
  } catch (error) {
    // Another request queued an action between the check above and this insert.
    if (error instanceof NodeBusyError) return jsonError(error.message, 409);
    throw error;
  }
  await addAudit({ actorUserId: user.id, action: "node.bootstrap.queued", targetType: "node", targetId: id });
  return NextResponse.json({ ok: true, actionId, status: "queued" }, { status: 202 });
}
