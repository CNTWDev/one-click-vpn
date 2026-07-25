import { NextResponse } from "next/server";
import { addAudit, updateNode } from "../../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { authenticateAgent } from "../../../../../server/agent";
import { finishReconcileTask } from "../../../../../server/control-db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = cleanText(body.token, 512);
    if (!authenticateAgent(nodeId, token)) return jsonError("Invalid agent credentials", 401);
    const taskId = cleanText(body.taskId, 128);
    const status = body.status === "succeeded" ? "succeeded" : body.status === "failed" ? "failed" : null;
    if (!taskId || !status) return jsonError("taskId and status are required");
    const error = cleanText(body.error, 4000);
    finishReconcileTask({
      taskId,
      nodeId,
      status,
      error,
      observedRevision: Number.isInteger(body.observedRevision) ? Number(body.observedRevision) : undefined,
      observedHash: cleanText(body.observedHash, 128) || undefined,
      observedStatus: cleanText(body.observedStatus, 64) || undefined,
    });
    updateNode(nodeId, { status: status === "succeeded" ? "online" : "attention", last_seen: "now", latency: "connected" });
    addAudit({ action: `agent.reconcile.${status}`, targetType: "node", targetId: nodeId, metadata: { taskId, error } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to record reconcile result");
  }
}
