import { dbQuery, withTransaction } from "./db";

/** Interface counters reported by Agent 2.11+ for the node's default-route (public) interface. */
export type WanCounters = { interface: string; counterEpoch: string; rxBytes: number; txBytes: number };

export type NodeMonthlyTraffic = { month: string; rxBytes: number; txBytes: number; trackedSince: string };

type PreviousSample = { interface: string; counter_epoch: string; rx_bytes: string | number; tx_bytes: string | number };

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Billing months follow UTC, like most cloud providers' invoices. */
export function billingMonth(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function wanCountersFromMetrics(metrics: unknown): WanCounters | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const network = (metrics as Record<string, unknown>).network;
  if (!network || typeof network !== "object" || Array.isArray(network)) return null;
  const value = network as Record<string, unknown>;
  const rxBytes = counter(value.wanRxBytes);
  const txBytes = counter(value.wanTxBytes);
  const iface = typeof value.wanInterface === "string" ? value.wanInterface.trim().slice(0, 32) : "";
  const epoch = typeof value.counterEpoch === "string" ? value.counterEpoch.trim().slice(0, 128) : "";
  if (rxBytes === null || txBytes === null || !iface) return null;
  return { interface: iface, counterEpoch: epoch, rxBytes, txBytes };
}

/** Bytes moved since the previous sample; a reboot or counter reset restarts from zero. */
export function counterDelta(previous: PreviousSample | undefined, current: WanCounters): { rx: number; tx: number } {
  if (!previous || previous.interface !== current.interface) return { rx: 0, tx: 0 };
  const rebooted = previous.counter_epoch !== current.counterEpoch;
  const step = (before: number, after: number) => rebooted || after < before ? after : after - before;
  return { rx: step(Number(previous.rx_bytes), current.rxBytes), tx: step(Number(previous.tx_bytes), current.txBytes) };
}

export async function recordNodeNetworkCounters(nodeId: string, metrics: unknown, observedAt = new Date()): Promise<void> {
  const current = wanCountersFromMetrics(metrics);
  if (!current) return;
  const month = billingMonth(observedAt);
  const timestamp = observedAt.toISOString();
  await withTransaction(async (exec, query) => {
    const previous = (await query<PreviousSample>(
      "SELECT interface, counter_epoch, rx_bytes, tx_bytes FROM node_network_counters WHERE node_id = $1 FOR UPDATE", [nodeId],
    ))[0];
    const delta = counterDelta(previous, current);
    await exec(`INSERT INTO node_network_counters (node_id, interface, counter_epoch, rx_bytes, tx_bytes, observed_at)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (node_id) DO UPDATE SET interface = EXCLUDED.interface,
      counter_epoch = EXCLUDED.counter_epoch, rx_bytes = EXCLUDED.rx_bytes, tx_bytes = EXCLUDED.tx_bytes, observed_at = EXCLUDED.observed_at`,
    [nodeId, current.interface, current.counterEpoch, current.rxBytes, current.txBytes, timestamp]);
    await exec(`INSERT INTO node_traffic_monthly (node_id, month, rx_bytes, tx_bytes, tracked_since, updated_at)
      VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (node_id, month) DO UPDATE SET
      rx_bytes = node_traffic_monthly.rx_bytes + EXCLUDED.rx_bytes, tx_bytes = node_traffic_monthly.tx_bytes + EXCLUDED.tx_bytes,
      updated_at = EXCLUDED.updated_at`, [nodeId, month, delta.rx, delta.tx, timestamp]);
  });
}

export async function currentMonthTrafficByNode(now = new Date()): Promise<Map<string, NodeMonthlyTraffic>> {
  const month = billingMonth(now);
  const rows = await dbQuery<{ node_id: string; rx_bytes: string | number; tx_bytes: string | number; tracked_since: Date | string }>(
    "SELECT node_id, rx_bytes, tx_bytes, tracked_since FROM node_traffic_monthly WHERE month = $1", [month],
  );
  return new Map(rows.map((row) => [row.node_id, {
    month, rxBytes: Number(row.rx_bytes), txBytes: Number(row.tx_bytes), trackedSince: new Date(row.tracked_since).toISOString(),
  }]));
}
