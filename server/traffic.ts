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
    const device = snapshot.protocol === "wireguard"
      ? (await dbQuery<{ id: string; user_id: string }>(
        "SELECT id, user_id FROM devices WHERE public_key = $1 AND status = 'active' LIMIT 1", [identityKey],
      ))[0]
      : (await dbQuery<{ id: string; user_id: string }>(`SELECT d.id, d.user_id FROM certificate_issuances c
          INNER JOIN devices d ON d.id = c.device_id
          WHERE c.subject = $1 AND c.purpose = 'client' AND c.status = 'active' AND d.status = 'active'
          ORDER BY c.created_at DESC LIMIT 1`, [`CN=${identityKey}`]))[0];
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

export async function usageByCredentials(userId: string, input: { from?: string; to?: string }) {
  const { from, to } = range(input);
  const rows = await dbQuery<{
    profile_id: string; device_id: string; display_name: string; platform: string; profile_status: string;
    protocol: string; node_id: string; region_name: string | null; region_code: string | null;
    issued_at: string; credential_identity: string | null; upload_bytes: string; download_bytes: string;
    first_seen_at: string | null; last_seen_at: string | null; last_activity_at: string | null; observed_at: string | null;
  }>(`SELECT p.id AS profile_id, d.id AS device_id, d.display_name, d.platform, p.status AS profile_status,
      p.protocol, p.node_id, r.name AS region_name, r.code AS region_code, p.issued_at,
      CASE WHEN p.protocol = 'openvpn' THEN cert.serial ELSE d.public_key END AS credential_identity,
      COALESCE(usage.upload_bytes, 0)::text AS upload_bytes,
      COALESCE(usage.download_bytes, 0)::text AS download_bytes,
      usage.first_seen_at, usage.last_seen_at, counters.last_activity_at, counters.observed_at
    FROM connection_profiles p
    INNER JOIN devices d ON d.id = p.device_id
    INNER JOIN nodes n ON n.id = p.node_id
    LEFT JOIN regions r ON r.id = n.region_id
    LEFT JOIN LATERAL (
      SELECT SUM(t.upload_bytes) AS upload_bytes, SUM(t.download_bytes) AS download_bytes,
        MIN(t.first_seen_at) AS first_seen_at, MAX(t.last_seen_at) AS last_seen_at
      FROM traffic_daily t WHERE t.device_id = p.device_id AND (p.protocol = 'openvpn' OR t.node_id = p.node_id)
        AND t.protocol = p.protocol AND t.day BETWEEN $2 AND $3
    ) usage ON true
    LEFT JOIN LATERAL (
      SELECT MAX(c.last_handshake_at) AS last_activity_at, MAX(c.observed_at) AS observed_at
      FROM traffic_counters c WHERE c.device_id = p.device_id AND (p.protocol = 'openvpn' OR c.node_id = p.node_id) AND c.protocol = p.protocol
    ) counters ON true
    LEFT JOIN LATERAL (
      SELECT c.serial FROM certificate_issuances c WHERE c.device_id = p.device_id
        AND c.purpose = 'client' ORDER BY (c.status = 'active') DESC, c.created_at DESC LIMIT 1
    ) cert ON p.protocol = 'openvpn'
    WHERE d.user_id = $1 AND p.status IN ('issued', 'active')
    ORDER BY p.updated_at DESC`, [userId, from, to]);
  const onlineCutoff = Date.now() - 120_000;
  return {
    from, to, updatedAt: now(),
    credentials: rows.map((row) => {
      const activityTime = row.last_activity_at ? new Date(row.last_activity_at).getTime() : 0;
      const identity = row.credential_identity || "";
      return {
        profileId: row.profile_id, deviceId: row.device_id, displayName: row.display_name, platform: row.platform,
        profileStatus: row.profile_status, protocol: row.protocol, nodeId: row.node_id,
        regionName: row.region_name || "Unknown", regionCode: row.region_code || "",
        issuedAt: row.issued_at, credentialSuffix: identity ? identity.replaceAll(":", "").slice(-8) : "",
        online: activityTime >= onlineCutoff, lastActivityAt: row.last_activity_at,
        observedAt: row.observed_at, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
        ...numbers(row),
      };
    }),
  };
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
