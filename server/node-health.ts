import { dbExec, dbQuery } from "./db";
import { listControlNodes, listVpnServices } from "./control-db";
import { writeOperationalLog } from "./operational-logs";
import { tcpReachable } from "./port-reach";
import { decide, FLAP_WINDOW_MS, USER_EVIDENCE_MINUTES, type HealthAction, type HealthNode } from "./node-health-rules";

/**
 * Automatic removal of nodes nobody can reach, and their return.
 *
 * Reachability differs by carrier, region and hour, so the Controller only acts on the clear case: its own
 * outside check of the node's TCP lines fails 3 minutes in a row AND no app on any network reached the node in
 * the last 15 minutes (TRANSPORT_PROBE, node_transport_reach). A node only some networks cannot reach is left to
 * the apps, which already measure and fall back per network. A removed node keeps running: like a paused one it
 * is no longer offered to new connections (apps, subscriptions, "automatic"), and devices already on it renew.
 *
 * Safety limits: never more than half the nodes removed automatically (more looks like the Controller's own
 * network), never the last serving node of a region, and a node removed 3 times in 6 hours stays removed until
 * someone restores it. Counters live in memory (a restart starts them again); the state is on the node row.
 */

type Counter = { fails: number; oks: number };
const counters: Map<string, Counter> = (globalThis as { __nodeHealth?: Map<string, Counter> }).__nodeHealth ??= new Map();
/** Nodes the safety limits kept serving, for the alert list (alerts.ts). */
export const heldNodes: Map<string, "fleet" | "region"> = (globalThis as { __nodeHealthHeld?: Map<string, "fleet" | "region"> }).__nodeHealthHeld ??= new Map();
let running = false;

/** One outside check of every node's TCP lines (REALITY and the stealth TCP port), then the decisions. Run once a minute. */
export async function runNodeHealth(): Promise<HealthAction[]> {
  if (running) return [];
  running = true;
  try {
    const [nodes, services, evidence] = await Promise.all([
      listControlNodes(),
      listVpnServices(),
      dbQuery<{ node_id: string }>(`SELECT DISTINCT node_id FROM node_transport_reach WHERE network <> 'controller' AND ok_at > now() - interval '${USER_EVIDENCE_MINUTES} minutes'`),
    ]);
    const reached = new Set(evidence.map((row) => row.node_id));
    const now = Date.now();
    const health: HealthNode[] = [];
    await Promise.all(nodes.filter((node) => node.agent_token_hash).map(async (node) => {
      const host = node.public_endpoint || node.ip;
      const ports = services.filter((service) => service.node_id === node.id && service.enabled && (service.protocol === "vless" || service.protocol === "stealth"))
        .map((service) => service.listen_port).filter((port): port is number => Number.isInteger(port) && port > 0);
      const heartbeat = node.last_heartbeat_at ? now - new Date(node.last_heartbeat_at).getTime() : Infinity;
      const online = node.status === "online" && heartbeat < 90_000;
      // Nothing to check (no TCP line, or the Agent is silent: heartbeats already keep it out of every list).
      if (!host || !ports.length || !online) { counters.delete(node.id); return; }
      const open = (await Promise.all(ports.map((port) => tcpReachable(host, port, { timeoutMs: 4000, fresh: true })))).some(Boolean);
      const counter = counters.get(node.id) || { fails: 0, oks: 0 };
      if (open) { counter.oks++; counter.fails = 0; } else { counter.fails++; counter.oks = 0; }
      counters.set(node.id, counter);
      const row = node as typeof node & { drained_at?: string | null; drain_locked?: number; auto_drain?: number; drain_history?: string };
      health.push({ id: node.id, name: node.name, regionId: node.region_id, serving: !node.paused_at && !row.drained_at, drained: !!row.drained_at,
        locked: !!row.drain_locked, autoDrain: row.auto_drain !== 0, fails: counter.fails, oks: counter.oks, reachedByUsers: reached.has(node.id),
        history: (row.drain_history || "").split(",").filter(Boolean).map(Date.parse).filter(Number.isFinite) });
    }));
    const actions = decide(health, now);
    heldNodes.clear();
    for (const action of actions) {
      const node = health.find((item) => item.id === action.id)!;
      if (action.kind === "held") { heldNodes.set(node.id, action.why); continue; }
      if (action.kind === "drain") {
        const history = [...node.history.filter((at) => now - at < FLAP_WINDOW_MS), now].map((at) => new Date(at).toISOString()).join(",");
        await dbExec("UPDATE nodes SET drained_at = $2, drain_reason = 'unreachable', drain_history = $3, drain_locked = $4, updated_at = $2 WHERE id = $1 AND drained_at IS NULL",
          [node.id, new Date(now).toISOString(), history, action.lock ? 1 : 0]);
      } else {
        await dbExec("UPDATE nodes SET drained_at = NULL, drain_reason = '', updated_at = $2 WHERE id = $1 AND drain_locked = 0", [node.id, new Date(now).toISOString()]);
      }
      await writeOperationalLog({ component: "controller", nodeId: node.id, level: action.kind === "drain" ? "warning" : "info", source: "system",
        action: action.kind === "drain" ? "node.auto_drained" : "node.auto_restored",
        message: action.kind === "drain" ? `Node ${node.name} removed from new connections: outside check failed ${node.fails} min, no app reached it in ${USER_EVIDENCE_MINUTES} min`
          : `Node ${node.name} back in service: outside check passed ${node.oks} min`,
        fields: { fails: node.fails, oks: node.oks, locked: action.kind === "drain" ? action.lock : undefined } }).catch(() => undefined);
    }
    return actions;
  } finally { running = false; }
}

/** Console 「立即恢复」: back in service now, the removal history and lock cleared. */
export async function restoreNode(id: string): Promise<boolean> {
  counters.delete(id);
  return (await dbExec("UPDATE nodes SET drained_at = NULL, drain_reason = '', drain_locked = 0, drain_history = '', updated_at = $2 WHERE id = $1", [id, new Date().toISOString()])) === 1;
}

/** Console 「不自动摘除」 for a node kept for experiments; turning it off also restores the node. */
export async function setAutoDrain(id: string, on: boolean): Promise<boolean> {
  if (!on) await restoreNode(id);
  return (await dbExec("UPDATE nodes SET auto_drain = $2, updated_at = $3 WHERE id = $1", [id, on ? 1 : 0, new Date().toISOString()])) === 1;
}
