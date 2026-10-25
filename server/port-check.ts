import { randomBytes, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { findControlNode } from "./control-db";
import { dbExec } from "./db";
import { writeOperationalLog } from "./operational-logs";

/**
 * Manual "检测端口" from the Console: the Controller sends marker UDP packets to a node over the
 * public internet while the node's Agent (2.16+) counts them before its own firewall. Packets that
 * arrive prove the cloud security group lets the port through; none means it is closed somewhere
 * between the Controller and the node. TCP needs no Agent: a fresh connect from the Controller.
 *
 * One check per node at a time, held in memory (shared across route bundles via globalThis); the
 * outcome is kept per port in node_transport_reach under network "controller".
 */
export type PortCheckPort = { transport: "udp" | "tcp"; port: number };
export type PortCheckResult = PortCheckPort & { open: boolean };
export type PortCheck = {
  id: string;
  nodeId: string;
  ports: PortCheckPort[];
  payloadLength: number;
  status: "waiting" | "counting" | "done" | "failed";
  startedAt: number;
  results: PortCheckResult[];
  error: string;
};

const MIN_AGENT = [2, 16, 0];
const SEND_FOR_MS = 45_000;
const SEND_EVERY_MS = 400;
export const CONTROLLER_NETWORK = "controller";

const store: Map<string, PortCheck> = (globalThis as { __portChecks?: Map<string, PortCheck> }).__portChecks ??= new Map();

export function agentSupportsPortCheck(version: string | null | undefined): boolean {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(version || "")?.slice(1).map(Number);
  if (!parts) return false;
  for (let index = 0; index < 3; index += 1) if (parts[index] !== MIN_AGENT[index]) return parts[index] > MIN_AGENT[index];
  return true;
}

export function currentPortCheck(nodeId: string): PortCheck | undefined {
  return store.get(nodeId);
}

/** Starts a check of the node's UDP ports; the caller probes TCP ports itself. */
export async function startPortCheck(nodeId: string, ports: PortCheckPort[]): Promise<PortCheck> {
  const running = store.get(nodeId);
  if (running && (running.status === "waiting" || running.status === "counting")) return running;
  const node = await findControlNode(nodeId);
  if (!node) throw new Error("Node not found");
  const host = node.public_endpoint || node.ip;
  const udp = ports.filter((item) => item.transport === "udp");
  const check: PortCheck = {
    id: randomUUID(), nodeId, ports: udp, status: "waiting", startedAt: Date.now(), results: [], error: "",
    // A length nobody else is likely to send to these ports in the same few seconds.
    payloadLength: 700 + Math.floor(Math.random() * 400),
  };
  store.set(nodeId, check);
  if (!udp.length) return finish(check, []);
  const { address, family } = await lookup(host);
  const socket = createSocket(family === 6 ? "udp6" : "udp4");
  socket.on("error", () => undefined);
  const timer = setInterval(() => {
    if (check.status === "done" || check.status === "failed" || Date.now() - check.startedAt > SEND_FOR_MS) {
      clearInterval(timer);
      socket.close();
      if (check.status === "waiting" || check.status === "counting") fail(check, "agent did not answer");
      return;
    }
    const payload = randomBytes(check.payloadLength);
    for (const item of udp) socket.send(payload, item.port, address);
  }, SEND_EVERY_MS);
  return check;
}

/** What the Agent receives with its next task pull, once. */
export function takePortCheckFor(nodeId: string) {
  const check = store.get(nodeId);
  if (!check || check.status !== "waiting") return undefined;
  check.status = "counting";
  return { id: check.id, ports: check.ports, length4: check.payloadLength + 28, length6: check.payloadLength + 48, seconds: 8 };
}

export async function recordPortCheck(nodeId: string, id: string, results: unknown, error: string) {
  const check = store.get(nodeId);
  if (!check || check.id !== id || check.status !== "counting") return false;
  if (error) { fail(check, error); return true; }
  const reported = (Array.isArray(results) ? results : []) as Array<{ transport?: unknown; port?: unknown; packets?: unknown }>;
  const counted = new Map(reported.map((item) => [`${item?.transport}/${item?.port}`, Number(item?.packets) > 0]));
  const outcome = check.ports.filter((item) => counted.has(`${item.transport}/${item.port}`))
    .map((item) => ({ ...item, open: counted.get(`${item.transport}/${item.port}`) === true }));
  for (const item of outcome) await saveControllerReach(nodeId, item);
  finish(check, outcome);
  return true;
}

export async function saveControllerReach(nodeId: string, item: PortCheckResult) {
  await dbExec(`INSERT INTO node_transport_reach (node_id, transport, network, ok_at, failed_at)
    SELECT $1, $2, $3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN NULL ELSE now() END WHERE EXISTS (SELECT 1 FROM nodes WHERE id = $1)
    ON CONFLICT (node_id, transport, network) DO UPDATE SET
      ok_at = CASE WHEN $4 THEN now() ELSE NULL END, failed_at = CASE WHEN $4 THEN NULL ELSE now() END`,
  [nodeId, `${item.transport}/${item.port}`, CONTROLLER_NETWORK, item.open]);
}

function finish(check: PortCheck, results: PortCheckResult[]) {
  check.status = "done";
  check.results = results;
  void writeOperationalLog({ nodeId: check.nodeId, component: "controller", level: results.some((item) => !item.open) ? "warning" : "info",
    action: "node.port_check", message: `Port check: ${results.map((item) => `${item.transport}/${item.port} ${item.open ? "open" : "closed"}`).join(", ") || "no UDP ports"}`,
    fields: { checkId: check.id } });
  return check;
}

function fail(check: PortCheck, error: string) {
  check.status = "failed";
  check.error = error;
  void writeOperationalLog({ nodeId: check.nodeId, component: "controller", level: "warning", action: "node.port_check",
    message: `Port check failed: ${error}`, fields: { checkId: check.id } });
}
