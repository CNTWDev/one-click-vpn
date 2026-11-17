import { createHash } from "node:crypto";

/**
 * Extra ports per node for networks that block or throttle one port (Agent 2.19+, agent.py ensure_hop_rules):
 * - Hysteria2 port hopping: the whole UDP range is redirected to the stealth port, and mihomo clients hop
 *   between ports every ~30 s, so blocking or slowing one UDP port no longer stops the line.
 * - A spare TCP port in the same range, redirected to REALITY: a second REALITY line for networks that block
 *   the node's 443 only.
 * Same range on every node, so one cloud security group rule (TCP+UDP 20000-29999) covers the fleet. It stays
 * below Linux's ephemeral ports (32768+). The redirect runs before the host firewall, so only the cloud rule
 * has to be set by hand.
 *
 * A line is only offered once the Controller saw the port open from outside (hop-check.ts): a node whose
 * security group was not changed keeps today's lines and nothing breaks.
 */
export const HOP_FROM = 20000;
export const HOP_TO = 29999;
export const HOP_RANGE = `${HOP_FROM}-${HOP_TO}`;
export const HOP_UDP_KEY = `udp/${HOP_RANGE}`;
/** Seconds between hops, a random value in this range each time (mihomo's `hop-interval`, a string). */
export const HOP_INTERVAL = "20-40";

/** The node's spare REALITY port: fixed per node (from its id), somewhere in the range. */
export function altTcpPort(nodeId: string): number {
  return HOP_FROM + createHash("sha256").update(nodeId).digest().readUInt32BE(0) % (HOP_TO - HOP_FROM + 1);
}

/** What goes to the Agent with the stealth desired state. */
export function hopDesired(nodeId: string, stealthPort: number, realityPort: number | undefined) {
  return { udpFrom: HOP_FROM, udpTo: HOP_TO, udpTarget: stealthPort, ...(realityPort ? { tcpPort: altTcpPort(nodeId), tcpTarget: realityPort } : {}) };
}

/** Which redirects the Agent reports as live (capabilities.connectivity.hop); absent before Agent 2.19. */
export function reportedHop(capabilities: Record<string, unknown> | undefined): { udp: string | null; tcp: number | null } | null {
  const connectivity = capabilities?.connectivity as { hop?: { udp?: unknown; tcp?: unknown } } | undefined;
  const hop = connectivity?.hop;
  if (!hop || typeof hop !== "object") return null;
  return { udp: typeof hop.udp === "string" ? hop.udp : null, tcp: typeof hop.tcp === "number" ? hop.tcp : null };
}

export type HopReach = { open: boolean; at: number };

/** Hysteria2 with hopping: the main port stays in the list, so a client never depends on the range alone. */
export function withHopping<T extends Record<string, unknown>>(proxy: T, udpPorts: string | null): T {
  return udpPorts ? { ...proxy, ports: `${proxy.port},${udpPorts}`, "hop-interval": HOP_INTERVAL } : proxy;
}

/** Due for another outside check: never checked, open for 12 h, or closed for an hour. */
export function hopCheckDue(reach: HopReach | undefined, now = Date.now()): boolean {
  if (!reach || !Number.isFinite(reach.at)) return true;
  return now - reach.at >= (reach.open ? 12 : 1) * 3600_000;
}

/** A few ports from the range for one UDP check; packets reaching any of them prove the rule is there. */
export function hopSamples(count = 3): number[] {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(HOP_FROM + Math.floor(Math.random() * (HOP_TO - HOP_FROM + 1)));
  return [...ports];
}
