import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { addAudit, findNode, purgeStoredOperationalLogs } from "../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../server/http";
import { requestOperationalLogPurge } from "../../../../server/operational-logs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128) || undefined;
    if (nodeId && !(await findNode(nodeId))) return jsonError("Node not found", 404);
    const requiredConfirmation = nodeId ? "PURGE NODE LOGS" : "PURGE SYSTEM LOGS";
    if (cleanText(body.confirmation, 64) !== requiredConfirmation) return jsonError(`Type ${requiredConfirmation} to confirm this irreversible operation`, 409);
    await requestOperationalLogPurge(nodeId);
    await purgeStoredOperationalLogs(nodeId);
    await addAudit({ actorUserId: user.id, action: "operational_logs.purged", targetType: nodeId ? "node" : "system_logs", targetId: nodeId, metadata: { nodeId: nodeId || null, irreversible: true } });
    return NextResponse.json({ ok: true, physicalDeletion: "scheduled" });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to purge operational logs", 409);
  }
}
