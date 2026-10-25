import { NextResponse } from "next/server";
import { cleanText, jsonError, readJson } from "../../../../../../server/http";
import { agentTokenFromRequest, authenticateAgent } from "../../../../../../server/agent";
import { listNativeLeasePeers, pullReconcileTasks } from "../../../../../../server/control-db";
import { takePortCheckFor } from "../../../../../../server/port-check";
import { waitForAgentWork } from "../../../../../../server/agent-wake";
import { takeSelfUpgradeFor } from "../../../../../../server/agent-self-upgrade";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = agentTokenFromRequest(request, cleanText(body.token, 512));
    if (!(await authenticateAgent(nodeId, token, request))) return jsonError("Invalid agent credentials", 401);
    const limit = Math.min(Math.max(Number(body.limit || 10), 1), 20);
    // Agent 2.17+ long-polls: with nothing to do the request is held (at most 25 s) until a task or a port check
    // for this node appears. Older Agents send no wait and poll every 5 s.
    const wait = Math.min(Math.max(Number(body.wait) || 0, 0), 25) * 1000;
    let tasks = await pullReconcileTasks(nodeId, limit);
    const take = () => ({ portCheck: body.portCheck === true ? takePortCheckFor(nodeId) : undefined, upgrade: body.selfUpgrade === true ? takeSelfUpgradeFor(nodeId) : undefined });
    let { portCheck, upgrade } = take();
    if (wait && !tasks.length && !portCheck && !upgrade) {
      await waitForAgentWork(nodeId, wait, request.signal);
      tasks = await pullReconcileTasks(nodeId, limit);
      ({ portCheck, upgrade } = take());
    }
    // Deadlines are read after any wait, so renewals made meanwhile are included.
    const nativePeers = body.nativePeers === true ? { nativePeers: await listNativeLeasePeers(nodeId) } : {};
    return NextResponse.json({ ...nativePeers, ...(portCheck ? { portCheck } : {}), ...(upgrade ? { upgrade } : {}), tasks: tasks.map((task) => ({
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
