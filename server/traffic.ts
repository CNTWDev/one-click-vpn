import { dbExec, dbQuery } from "./db";

export type UsageSnapshot = {
  protocol: "wireguard" | "openvpn";
  identityKey: string;
  rxBytes: number;
  txBytes: number;
  lastHandshakeAt?: string | null;
  counterEpoch?: string;
};

function now(): string { return new Date().toISOString(); }

function validBytes(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function dayOf(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? now().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

export async function recordTrafficSnapshots(nodeId: string, snapshots: UsageSnapshot[]): Promise<void> {
  const observedAt = now();
  for (const snapshot of snapshots.slice(0, 10000)) {
    const identityKey = typeof snapshot.identityKey === "string" ? snapshot.identityKey.trim().slice(0, 512) : "";
    if (!identityKey || !["wireguard", "openvpn"].includes(snapshot.protocol)) continue;
    const rxBytes = validBytes(snapshot.rxBytes);
    const txBytes = validBytes(snapshot.txBytes);
    const epoch = (snapshot.counterEpoch || "").trim().slice(0, 128);
    const previous = (await dbQuery<{ device_id: string | null; counter_epoch: string; observed_rx_bytes: string; observed_tx_bytes: string; observed_at: string }>(
      "SELECT device_id, counter_epoch, observed_rx_bytes, observed_tx_bytes, observed_at FROM traffic_counters WHERE node_id = $1 AND protocol = $2 AND identity_key = $3",
      [nodeId, snapshot.protocol, identityKey],
    ))[0];
    if (previous && new Date(previous.observed_at).getTime() >= new Date(observedAt).getTime()) continue;
    const sameCounter = previous && previous.counter_epoch === epoch;
    const uploadDelta = sameCounter ? Math.max(0, rxBytes - Number(previous.observed_rx_bytes)) : rxBytes;
    const downloadDelta = sameCounter ? Math.max(0, txBytes - Number(previous.observed_tx_bytes)) : txBytes;
    const device = (await dbQuery<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM devices WHERE public_key = $1 AND status = 'active' LIMIT 1", [identityKey],
    ))[0];
    await dbExec(`INSERT INTO traffic_counters
      (node_id, protocol, identity_key, device_id, observed_rx_bytes, observed_tx_bytes, last_handshake_at, counter_epoch, observed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(node_id, protocol, identity_key) DO UPDATE SET
        device_id = excluded.device_id, observed_rx_bytes = excluded.observed_rx_bytes,
        observed_tx_bytes = excluded.observed_tx_bytes, last_handshake_at = excluded.last_handshake_at,
        counter_epoch = excluded.counter_epoch, observed_at = excluded.observed_at`, [
      nodeId, snapshot.protocol, identityKey, device?.id || null, String(rxBytes), String(txBytes), snapshot.lastHandshakeAt || null, epoch, observedAt,
    ]);
    if (!device || (uploadDelta <= 0 && downloadDelta <= 0)) continue;
    const day = dayOf(observedAt);
    await dbExec(`INSERT INTO traffic_daily
      (day, user_id, device_id, node_id, protocol, upload_bytes, download_bytes, first_seen_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
      ON CONFLICT(day, device_id, node_id, protocol) DO UPDATE SET
        upload_bytes = traffic_daily.upload_bytes + excluded.upload_bytes,
        download_bytes = traffic_daily.download_bytes + excluded.download_bytes,
        last_seen_at = excluded.last_seen_at`, [
      day, device.user_id, device.id, nodeId, snapshot.protocol, String(uploadDelta), String(downloadDelta), observedAt,
    ]);
  }
}

function range(input: { from?: string; to?: string }): { from: string; to: string } {
  const today = new Date();
  const to = input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : today.toISOString().slice(0, 10);
  const fallback = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : fallback;
  return from <= to ? { from, to } : { from: to, to: from };
}

function numbers(row: { upload_bytes: string | number; download_bytes: string | number }) {
  const uploadBytes = Number(row.upload_bytes || 0);
  const downloadBytes = Number(row.download_bytes || 0);
  return { uploadBytes, downloadBytes, totalBytes: uploadBytes + downloadBytes };
}

export async function usageSummary(userId: string, input: { from?: string; to?: string }) {
  const { from, to } = range(input);
  const totals = (await dbQuery<{ upload_bytes: string; download_bytes: string }>(
    "SELECT COALESCE(SUM(upload_bytes), 0)::text AS upload_bytes, COALESCE(SUM(download_bytes), 0)::text AS download_bytes FROM traffic_daily WHERE user_id = $1 AND day BETWEEN $2 AND $3", [userId, from, to],
  ))[0] || { upload_bytes: "0", download_bytes: "0" };
  const daily = await dbQuery<{ day: string; upload_bytes: string; download_bytes: string }>(
    "SELECT day, COALESCE(SUM(upload_bytes), 0)::text AS upload_bytes, COALESCE(SUM(download_bytes), 0)::text AS download_bytes FROM traffic_daily WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day ORDER BY day", [userId, from, to],
  );
  return { from, to, updatedAt: now(), totals: numbers(totals), daily: daily.map((row) => ({ day: row.day, ...numbers(row) })) };
}

export async function usageByDevices(userId: string, input: { from?: string; to?: string }) {
  const { from, to } = range(input);
  const rows = await dbQuery<{ device_id: string; display_name: string; platform: string; upload_bytes: string; download_bytes: string }>(
    `SELECT t.device_id, d.display_name, d.platform, COALESCE(SUM(t.upload_bytes), 0)::text AS upload_bytes,
      COALESCE(SUM(t.download_bytes), 0)::text AS download_bytes FROM traffic_daily t
      INNER JOIN devices d ON d.id = t.device_id WHERE t.user_id = $1 AND t.day BETWEEN $2 AND $3
      GROUP BY t.device_id, d.display_name, d.platform ORDER BY SUM(t.upload_bytes + t.download_bytes) DESC`, [userId, from, to],
  );
  return { from, to, devices: rows.map((row) => ({ deviceId: row.device_id, displayName: row.display_name, platform: row.platform, ...numbers(row) })) };
}

export async function usageByRegions(userId: string, input: { from?: string; to?: string }) {
  const { from, to } = range(input);
  const rows = await dbQuery<{ region_id: string | null; name: string | null; country: string | null; upload_bytes: string; download_bytes: string }>(
    `SELECT n.region_id, r.name, r.country, COALESCE(SUM(t.upload_bytes), 0)::text AS upload_bytes,
      COALESCE(SUM(t.download_bytes), 0)::text AS download_bytes FROM traffic_daily t
      INNER JOIN nodes n ON n.id = t.node_id LEFT JOIN regions r ON r.id = n.region_id
      WHERE t.user_id = $1 AND t.day BETWEEN $2 AND $3 GROUP BY n.region_id, r.name, r.country
      ORDER BY SUM(t.upload_bytes + t.download_bytes) DESC`, [userId, from, to],
  );
  return { from, to, regions: rows.map((row) => ({ regionId: row.region_id, name: row.name || "Unknown", country: row.country || "", ...numbers(row) })) };
}
