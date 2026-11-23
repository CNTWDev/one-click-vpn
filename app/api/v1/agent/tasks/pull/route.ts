import { NextResponse } from "next/server";
import { cleanText, jsonError, readJson } from "../../../../../../server/http";
import { agentTokenFromRequest, authenticateAgent } from "../../../../../../server/agent";
import { listNativeLeasePeers, pullReconcileTasks } from "../../../../../../server/control-db";
import { takePortCheckFor } from "../../../../../../server/port-check";
import { waitForAgentWork } from "../../../../../../server/agent-wake";
import { takeSelfUpgradeFor } from "../../../../../../server/agent-self-upgrade";
import { takeSpeedTestFor } from "../../../../../../server/speed-test";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = agentTokenFromRequest(request, cleanText(body.token, 512));
    const node = await authenticateAgent(nodeId, token, request);
    if (!node) return jsonError("Invalid agent credentials", 401);
    const limit = Math.min(Math.max(Number(body.limit || 10), 1), 20);
    // Agent 2.17+ long-polls: with nothing to do the request is held (at most 25 s) until a task or a port check
    // for this node appears. Older Agents send no wait and poll every 5 s.
    const wait = Math.min(Math.max(Number(body.wait) || 0, 0), 25) * 1000;
    let tasks = await pullReconcileTasks(nodeId, limit);
    const take = () => ({ portCheck: body.portCheck === true ? takePortCheckFor(nodeId) : undefined, upgrade: body.selfUpgrade === true ? takeSelfUpgradeFor(nodeId) : undefined });
    // Agent 2.20+: a speed test of the node's own connection, run in the background (server/speed-test.ts).
    const speed = () => body.speedTest === true ? takeSpeedTestFor(nodeId, node.version) : Promise.resolve(undefined);
    let { portCheck, upgrade } = take();
    let speedTest = await speed();
    if (wait && !tasks.length && !portCheck && !upgrade && !speedTest) {
      await waitForAgentWork(nodeId, wait, request.signal);
      tasks = await pullReconcileTasks(nodeId, limit);
      ({ portCheck, upgrade } = take());
      speedTest = await speed();
    }
    // Deadlines are read after any wait, so renewals made meanwhile are included.
    const nativePeers = body.nativePeers === true ? { nativePeers: await listNativeLeasePeers(nodeId) } : {};
    return NextResponse.json({ ...nativePeers, ...(portCheck ? { portCheck } : {}), ...(upgrade ? { upgrade } : {}), ...(speedTest ? { speedTest } : {}), tasks: tasks.map((task) => ({
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
