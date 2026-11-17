import { listControlNodes } from "./control-db";
import { agentSupportsPortCheck, currentPortCheck, startPortCheck } from "./port-check";
import { tcpReachable } from "./port-reach";
import { altTcpPort, hopCheckDue, hopSamples, HOP_RANGE, HOP_UDP_KEY, reportedHop } from "./hop-ports";
import { hopReach, saveHopReach } from "./hop-reach";

const MAX_UDP_CHECKS_PER_RUN = 2;

/**
 * Minute job: tests each node's hop ports from outside, as the Console's 检测端口 does, so a security group
 * rule added (or forgotten) by hand is noticed without anyone pressing a button. TCP: a connect from here.
 * UDP: marker packets to a few ports of the range that the Agent counts. Results feed hopLines().
 */
export async function runHopChecks(): Promise<void> {
  let udpStarted = 0;
  for (const node of await listControlNodes()) {
    const reported = reportedHop(node.capabilities);
    if (!reported || node.status !== "online" || !node.last_heartbeat_at || Date.now() - new Date(node.last_heartbeat_at).getTime() >= 90_000) continue;
    const host = node.public_endpoint || node.ip;
    const reach = await hopReach(node.id);
    const tcp = altTcpPort(node.id);
    if (reported.tcp === tcp && hopCheckDue(reach[`tcp/${tcp}`])) await saveHopReach(node.id, `tcp/${tcp}`, await tcpReachable(host, tcp, { fresh: true }));
    if (reported.udp !== HOP_RANGE || !hopCheckDue(reach[HOP_UDP_KEY]) || udpStarted >= MAX_UDP_CHECKS_PER_RUN || !agentSupportsPortCheck(node.version)) continue;
    const running = currentPortCheck(node.id);
    if (running && (running.status === "waiting" || running.status === "counting")) continue;
    udpStarted += 1;
    await startPortCheck(node.id, [], hopSamples()).catch(() => undefined);
  }
}
