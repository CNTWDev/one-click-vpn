import { NextResponse } from "next/server";
import { cleanText, jsonError, readJson } from "../../../../../../server/http";
import { authenticateAgent } from "../../../../../../server/agent";
import { pullReconcileTasks } from "../../../../../../server/control-db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = cleanText(body.token, 512);
    if (!(await authenticateAgent(nodeId, token))) return jsonError("Invalid agent credentials", 401);
    const limit = Math.min(Math.max(Number(body.limit || 10), 1), 20);
    const tasks = await pullReconcileTasks(nodeId, limit);
    return NextResponse.json({ tasks: tasks.map((task) => ({
      id: task.id,
      protocol: task.protocol,
      taskType: task.task_type,
      desiredRevision: task.desired_revision,
      payload: task.payload,
    })) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to pull tasks");
  }
}
