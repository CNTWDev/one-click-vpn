import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { addAudit, countRunningNodeActions, findNode } from "../../../../server/db";
import { queueNodeAction, queueNodeBootstrap } from "../../../../server/bootstrap";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

const allowedActions = new Set(["status-agent", "restart-agent", "bootstrap"]);

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const action = cleanText(body.action, 32);
    const rawNodeIds = Array.isArray(body.nodeIds) ? body.nodeIds : [];
    const nodeIds = [...new Set(rawNodeIds.map((id) => cleanText(id, 128)).filter(Boolean))].slice(0, 100);
    if (!allowedActions.has(action) || !nodeIds.length) return jsonError("Select at least one node and a supported action");

    const accepted: string[] = [];
    const skipped: string[] = [];
    for (const nodeId of nodeIds) {
      if (!(await findNode(nodeId)) || await countRunningNodeActions(nodeId) > 0) {
        skipped.push(nodeId);
        continue;
      }
      if (action === "bootstrap") await queueNodeBootstrap(nodeId, user.id);
      else await queueNodeAction(nodeId, action as "status-agent" | "restart-agent", user.id);
      accepted.push(nodeId);
    }
    await addAudit({ actorUserId: user.id, action: `nodes.batch.${action}.queued`, targetType: "node_fleet", metadata: { accepted, skipped } });
    return NextResponse.json({ accepted, skipped, queued: accepted.length });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to queue fleet operation");
  }
}
