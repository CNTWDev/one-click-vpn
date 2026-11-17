import { dbExec, dbQuery } from "./db";
import { altTcpPort, HOP_RANGE, HOP_UDP_KEY, reportedHop, type HopReach } from "./hop-ports";

/** Outside checks of the hop ports (hop-ports.ts), kept in node_transport_reach under network "controller". */
const NETWORK = "controller";

/** The Controller's latest outside checks of the node's hop ports, by "udp/20000-29999" and "tcp/<port>". */
export async function hopReach(nodeId: string): Promise<Record<string, HopReach>> {
  const rows = await dbQuery<{ transport: string; ok_at: string | null; failed_at: string | null }>(
    "SELECT transport, ok_at, failed_at FROM node_transport_reach WHERE node_id = $1 AND network = $2 AND (transport = $3 OR transport = $4)",
    [nodeId, NETWORK, HOP_UDP_KEY, `tcp/${altTcpPort(nodeId)}`]);
  const result: Record<string, HopReach> = {};
  for (const row of rows) result[row.transport] = row.ok_at ? { open: true, at: Date.parse(row.ok_at) } : { open: false, at: Date.parse(row.failed_at || "") };
  return result;
}

export async function saveHopReach(nodeId: string, key: string, open: boolean) {
  await dbExec(`INSERT INTO node_transport_reach (node_id, transport, network, ok_at, failed_at)
    SELECT $1, $2, $3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN NULL ELSE now() END WHERE EXISTS (SELECT 1 FROM nodes WHERE id = $1)
    ON CONFLICT (node_id, transport, network) DO UPDATE SET
      ok_at = CASE WHEN $4 THEN now() ELSE NULL END, failed_at = CASE WHEN $4 THEN NULL ELSE now() END`, [nodeId, key, NETWORK, open]);
}

// An open result is trusted for a week (checks repeat every 12 h); a closed one is retried hourly so a
// security group rule added by hand shows up within the hour.
const TRUST_OPEN_MS = 7 * 86400_000;

/** The extra lines a node can offer right now: live on the node and seen open from outside. */
export async function hopLines(node: { id: string; capabilities?: Record<string, unknown> }): Promise<{ udpPorts: string | null; tcpPort: number | null }> {
  const reported = reportedHop(node.capabilities);
  if (!reported || (!reported.udp && !reported.tcp)) return { udpPorts: null, tcpPort: null };
  const reach = await hopReach(node.id);
  const open = (key: string) => Boolean(reach[key]?.open && Date.now() - reach[key].at < TRUST_OPEN_MS);
  const tcp = altTcpPort(node.id);
  return {
    udpPorts: reported.udp === HOP_RANGE && open(HOP_UDP_KEY) ? HOP_RANGE : null,
    tcpPort: reported.tcp === tcp && open(`tcp/${tcp}`) ? tcp : null,
  };
}

