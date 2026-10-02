import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { addAudit, countRunningNodeActions, findNode, NodeBusyError } from "../../../../server/db";
import { queueNodeAction, queueNodeBootstrap } from "../../../../server/bootstrap";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

const allowedActions = new Set(["status-agent", "restart-agent", "upgrade-agent", "bootstrap"]);

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const action = cleanText(body.action, 32);
    const rawNodeIds = Array.isArray(body.nodeIds) ? body.nodeIds : [];
    const nodeIds = [...new Set(rawNodeIds.map((id) => cleanText(id, 128)).filter(Boolean))];
    if (nodeIds.length > 100) return jsonError("每批最多操作 100 个节点，请减少选择后重试。");
    if (!allowedActions.has(action) || !nodeIds.length) return jsonError("Select at least one node and a supported action");

    const accepted: string[] = [];
    const skipped: string[] = [];
    const results: Array<{ nodeId: string; status: string; actionId?: string; reason?: string }> = [];
    for (const nodeId of nodeIds) {
      try {
        if (!(await findNode(nodeId))) {
          skipped.push(nodeId);
          results.push({ nodeId, status: "failed", reason: "节点不存在或已删除。" });
          continue;
        }
        if (await countRunningNodeActions(nodeId) > 0) throw new NodeBusyError();
        const actionId = action === "bootstrap" ? await queueNodeBootstrap(nodeId, user.id)
          : await queueNodeAction(nodeId, action as "status-agent" | "restart-agent" | "upgrade-agent", user.id);
        results.push({ nodeId, status: "queued", actionId });
      } catch (error) {
        skipped.push(nodeId);
        results.push({ nodeId, status: error instanceof NodeBusyError ? "busy" : "failed", reason: error instanceof NodeBusyError ? error.message : "提交失败，请刷新并检查节点任务状态后重试。" });
        continue;
      }
      accepted.push(nodeId);
    }
    await addAudit({ actorUserId: user.id, action: `nodes.batch.${action}.queued`, targetType: "node_fleet", metadata: { accepted, skipped } });
    return NextResponse.json({ accepted, skipped, queued: accepted.length, results });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to queue fleet operation");
  }
}
