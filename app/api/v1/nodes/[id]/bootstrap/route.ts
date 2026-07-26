import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../../server/request-auth";
import { addAudit, countRunningNodeActions, findNode, updateNode } from "../../../../../../server/db";
import { queueNodeBootstrap } from "../../../../../../server/bootstrap";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestAdmin(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  if (!(await findNode(id))) return jsonError("Node not found", 404);
  if (await countRunningNodeActions(id) > 0) return jsonError("This node already has a queued or running action. Wait for it to finish.", 409);
  await updateNode(id, { status: "provisioning", version: "bootstrap queued" });
  await addAudit({ actorUserId: user.id, action: "node.bootstrap.queued", targetType: "node", targetId: id });
  const actionId = await queueNodeBootstrap(id, user.id);
  return NextResponse.json({ ok: true, actionId, status: "queued" }, { status: 202 });
}
