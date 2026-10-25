import { connect } from "node:net";
import { dbExec, dbQuery } from "./db";

/**
 * Whether a node's ports can be reached from outside, past cloud security groups and network ACLs
 * (which the Agent cannot see). TCP is tested from the control plane; UDP by the manual port check
 * (port-check.ts), or seen open once an app got an answer. An app that got none proves nothing: its
 * own network or carrier may block UDP, so failures never mark a port closed.
 */
export type CloudFirewall = "reachable" | "unreachable" | "unverified";

const tcpCache = new Map<string, { at: number; open: boolean }>();
const TCP_TTL = 5 * 60_000;

/** A plain TCP connect from the control plane, cached for 5 minutes per address. */
export async function tcpReachable(host: string, port: number, { timeoutMs = 3000, fresh = false } = {}): Promise<boolean> {
  const key = `${host}:${port}`, cached = tcpCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < TCP_TTL) return cached.open;
  const open = await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
  tcpCache.set(key, { at: Date.now(), open });
  return open;
}

/** App transport names and the node service port they use. */
export const appTransports: Record<string, { protocol: string; transport: "udp" | "tcp" }> = {
  wireguard: { protocol: "wireguard", transport: "udp" },
  hysteria2: { protocol: "stealth", transport: "udp" },
  reality: { protocol: "vless", transport: "tcp" },
  xhttp: { protocol: "stealth", transport: "tcp" },
};
const networkKey = /^[a-z]{2,8}:[0-9a-f]{12}$/;

/**
 * Records one app's first probe on a node: which transports answered from which network (a
 * one-way hash the app computes, never an address). Only sent when at least one transport
 * answered, so a dead network does not count against the node. Kept 7 days.
 */
export async function recordTransportProbe(nodeId: string, network: unknown, detail: string | null) {
  if (typeof network !== "string" || !networkKey.test(network) || !detail) return;
  for (const part of detail.split(",")) {
    const [name, result] = part.trim().split("=");
    if (!appTransports[name] || !["ok", "fail"].includes(result)) continue;
    await dbExec(`INSERT INTO node_transport_reach (node_id, transport, network, ok_at, failed_at)
      SELECT $1, $2, $3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN NULL ELSE now() END WHERE EXISTS (SELECT 1 FROM nodes WHERE id = $1)
      ON CONFLICT (node_id, transport, network) DO UPDATE SET
        ok_at = CASE WHEN $4 THEN now() ELSE node_transport_reach.ok_at END,
        failed_at = CASE WHEN $4 THEN node_transport_reach.failed_at ELSE now() END`, [nodeId, name, network, result === "ok"]);
  }
  await dbExec("DELETE FROM node_transport_reach WHERE GREATEST(COALESCE(ok_at, 'epoch'), COALESCE(failed_at, 'epoch')) < now() - interval '7 days'");
}

/**
 * UDP evidence for a node: app transports that got an answer in the last 7 days, and the latest
 * manual port check per "udp/<port>" (network "controller").
 */
export async function udpReach(nodeId: string) {
  const rows = await dbQuery<{ transport: string; network: string; ok_at: string | null; failed_at: string | null }>(`SELECT transport, network, ok_at, failed_at
    FROM node_transport_reach WHERE node_id = $1 AND (ok_at > now() - interval '7 days' OR (network = 'controller' AND failed_at > now() - interval '7 days'))`, [nodeId]);
  const apps: Record<string, number> = {}, checks: Record<string, { open: boolean; at: number }> = {};
  for (const row of rows) {
    if (row.network === "controller") {
      checks[row.transport] = row.ok_at ? { open: true, at: Date.parse(row.ok_at) } : { open: false, at: Date.parse(row.failed_at || "") };
    } else if (row.ok_at) apps[row.transport] = Math.max(apps[row.transport] || 0, Date.parse(row.ok_at));
  }
  return { apps, checks };
}

/** A UDP port's status: the manual check, unless an app got an answer after it said closed. */
export function udpStatus(reach: Awaited<ReturnType<typeof udpReach>>, app: string | undefined, port: number): { cloudFirewall: CloudFirewall; checkedAt: string | null } {
  const check = reach.checks[`udp/${port}`], appOk = app ? reach.apps[app] : undefined;
  if (check && (check.open || !appOk || appOk < check.at)) return { cloudFirewall: check.open ? "reachable" : "unreachable", checkedAt: new Date(check.at).toISOString() };
  return { cloudFirewall: appOk ? "reachable" : "unverified", checkedAt: null };
}
