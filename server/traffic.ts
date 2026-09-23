import { dbExec, dbQuery } from "./db";
import { X509Certificate } from "node:crypto";

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

function certificateFingerprint(pem: string): string {
  try { return new X509Certificate(pem).fingerprint256; } catch { return ""; }
}

export async function adminUserAccessSummaries() {
  const { from, to } = range({});
  const rows = await dbQuery<{
    user_id: string; device_count: string; active_device_count: string; profile_count: string; active_profile_count: string;
    certificate_count: string; active_certificate_count: string; upload_bytes: string; download_bytes: string; last_activity_at: string | null;
  }>(`SELECT u.id AS user_id,
      (SELECT COUNT(*)::text FROM devices d WHERE d.user_id = u.id) AS device_count,
      (SELECT COUNT(*)::text FROM devices d WHERE d.user_id = u.id AND d.status = 'active') AS active_device_count,
      (SELECT COUNT(*)::text FROM connection_profiles p INNER JOIN devices d ON d.id = p.device_id WHERE d.user_id = u.id) AS profile_count,
      (SELECT COUNT(*)::text FROM connection_profiles p INNER JOIN devices d ON d.id = p.device_id
        WHERE d.user_id = u.id AND p.status IN ('issued', 'active') AND p.expires_at > $3) AS active_profile_count,
      (SELECT COUNT(*)::text FROM certificate_issuances c INNER JOIN devices d ON d.id = c.device_id
        WHERE d.user_id = u.id AND c.purpose = 'client') AS certificate_count,
      (SELECT COUNT(*)::text FROM certificate_issuances c INNER JOIN devices d ON d.id = c.device_id
        WHERE d.user_id = u.id AND c.purpose = 'client' AND c.status = 'active' AND c.not_after > $3) AS active_certificate_count,
      (SELECT COALESCE(SUM(t.upload_bytes), 0)::text FROM traffic_daily t WHERE t.user_id = u.id AND t.day BETWEEN $1 AND $2) AS upload_bytes,
      (SELECT COALESCE(SUM(t.download_bytes), 0)::text FROM traffic_daily t WHERE t.user_id = u.id AND t.day BETWEEN $1 AND $2) AS download_bytes,
      (SELECT MAX(c.last_handshake_at) FROM traffic_counters c INNER JOIN devices d ON d.id = c.device_id WHERE d.user_id = u.id) AS last_activity_at
    FROM users u`, [from, to, now()]);
  return new Map(rows.map((row) => [row.user_id, {
    deviceCount: Number(row.device_count || 0), activeDeviceCount: Number(row.active_device_count || 0),
    profileCount: Number(row.profile_count || 0), activeProfileCount: Number(row.active_profile_count || 0),
    certificateCount: Number(row.certificate_count || 0), activeCertificateCount: Number(row.active_certificate_count || 0),
    lastActivityAt: row.last_activity_at, ...numbers(row),
  }]));
}

export async function adminUserAccessOverview(userId: string, input: { from?: string; to?: string }) {
  const { from, to } = range(input);
  const currentTime = now();
  const devices = await dbQuery<{
    id: string; display_name: string; platform: string; app_version: string; public_key: string; status: string;
    created_at: string; updated_at: string; last_seen_at: string | null; upload_bytes: string; download_bytes: string; last_activity_at: string | null;
  }>(`SELECT d.id, d.display_name, d.platform, d.app_version, d.public_key, d.status, d.created_at, d.updated_at, d.last_seen_at,
      COALESCE(usage.upload_bytes, 0)::text AS upload_bytes, COALESCE(usage.download_bytes, 0)::text AS download_bytes,
      counters.last_activity_at
    FROM devices d
    LEFT JOIN LATERAL (
      SELECT SUM(t.upload_bytes) AS upload_bytes, SUM(t.download_bytes) AS download_bytes
      FROM traffic_daily t WHERE t.device_id = d.id AND t.day BETWEEN $2 AND $3
    ) usage ON true
    LEFT JOIN LATERAL (
      SELECT MAX(c.last_handshake_at) AS last_activity_at FROM traffic_counters c WHERE c.device_id = d.id
    ) counters ON true
    WHERE d.user_id = $1 ORDER BY d.created_at DESC`, [userId, from, to]);

  const profiles = await dbQuery<{
    id: string; device_id: string; protocol: string; node_id: string; node_name: string; region_name: string | null; region_code: string | null;
    transport: string; revision: number; profile_status: string; client_address: string | null; issued_at: string; expires_at: string; updated_at: string;
    credential_identity: string | null; upload_bytes: string; download_bytes: string; last_activity_at: string | null;
  }>(`SELECT p.id, p.device_id, p.protocol, p.node_id, n.name AS node_name, r.name AS region_name, r.code AS region_code,
      p.transport, p.revision, CASE WHEN p.status IN ('issued', 'active') AND p.expires_at <= $4 THEN 'expired' ELSE p.status END AS profile_status,
      p.client_address, p.issued_at, p.expires_at, p.updated_at,
      CASE WHEN p.protocol = 'openvpn' THEN cert.serial ELSE d.public_key END AS credential_identity,
      COALESCE(usage.upload_bytes, 0)::text AS upload_bytes, COALESCE(usage.download_bytes, 0)::text AS download_bytes,
      counters.last_activity_at
    FROM connection_profiles p
    INNER JOIN devices d ON d.id = p.device_id
    INNER JOIN nodes n ON n.id = p.node_id
    LEFT JOIN regions r ON r.id = n.region_id
    LEFT JOIN LATERAL (
      SELECT c.serial FROM certificate_issuances c WHERE c.device_id = p.device_id AND c.purpose = 'client'
        AND c.not_before <= p.issued_at AND c.not_after >= p.issued_at
        AND (c.revoked_at IS NULL OR c.revoked_at >= p.issued_at)
        ORDER BY c.created_at DESC LIMIT 1
    ) cert ON p.protocol = 'openvpn'
    LEFT JOIN LATERAL (
      SELECT SUM(t.upload_bytes) AS upload_bytes, SUM(t.download_bytes) AS download_bytes
      FROM traffic_daily t WHERE t.device_id = p.device_id AND t.protocol = p.protocol
        AND t.day BETWEEN GREATEST($2, LEFT(p.issued_at, 10)) AND LEAST($3, LEFT(p.expires_at, 10))
        AND (t.node_id = p.node_id OR (p.protocol = 'openvpn' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p.protocol_payload_json::jsonb->'regionalEndpoints', '[]'::jsonb)) AS endpoint(value)
          WHERE endpoint.value->>'nodeId' = t.node_id)))
    ) usage ON true
    LEFT JOIN LATERAL (
      SELECT MAX(c.last_handshake_at) AS last_activity_at FROM traffic_counters c
      WHERE c.device_id = p.device_id AND c.protocol = p.protocol
        AND (c.node_id = p.node_id OR (p.protocol = 'openvpn' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p.protocol_payload_json::jsonb->'regionalEndpoints', '[]'::jsonb)) AS endpoint(value)
          WHERE endpoint.value->>'nodeId' = c.node_id)))
    ) counters ON true
    WHERE d.user_id = $1 ORDER BY p.updated_at DESC`, [userId, from, to, currentTime]);

  const certificates = await dbQuery<{
    id: string; authority_id: string; device_id: string; serial: string; subject: string; certificate_pem: string;
    certificate_status: string; not_before: string; not_after: string; revoked_at: string | null; created_at: string; updated_at: string;
    authority_realm: string; authority_status: string; upload_bytes: string; download_bytes: string; last_activity_at: string | null;
  }>(`SELECT c.id, c.authority_id, c.device_id, c.serial, c.subject, c.certificate_pem,
      CASE WHEN c.status = 'active' AND c.not_after <= $4 THEN 'expired' ELSE c.status END AS certificate_status,
      c.not_before, c.not_after, c.revoked_at, c.created_at, c.updated_at,
      a.realm AS authority_realm, a.status AS authority_status,
      COALESCE(usage.upload_bytes, 0)::text AS upload_bytes, COALESCE(usage.download_bytes, 0)::text AS download_bytes,
      CASE WHEN c.status = 'active' AND c.not_after > $4 THEN counters.last_activity_at ELSE NULL END AS last_activity_at
    FROM certificate_issuances c
    INNER JOIN credential_authorities a ON a.id = c.authority_id
    INNER JOIN devices d ON d.id = c.device_id
    LEFT JOIN LATERAL (
      SELECT SUM(t.upload_bytes) AS upload_bytes, SUM(t.download_bytes) AS download_bytes
      FROM traffic_daily t WHERE t.device_id = c.device_id AND t.protocol = 'openvpn'
        AND t.day BETWEEN GREATEST($2, LEFT(c.not_before, 10)) AND LEAST($3, LEFT(COALESCE(c.revoked_at, c.not_after), 10))
    ) usage ON true
    LEFT JOIN LATERAL (
      SELECT MAX(tc.last_handshake_at) AS last_activity_at FROM traffic_counters tc
      WHERE tc.device_id = c.device_id AND tc.protocol = 'openvpn' AND tc.identity_key = REPLACE(c.subject, 'CN=', '')
    ) counters ON true
    WHERE d.user_id = $1 AND c.purpose = 'client' ORDER BY c.created_at DESC`, [userId, from, to, currentTime]);

  const totals = (await dbQuery<{ upload_bytes: string; download_bytes: string }>(
    `SELECT COALESCE(SUM(upload_bytes), 0)::text AS upload_bytes, COALESCE(SUM(download_bytes), 0)::text AS download_bytes
     FROM traffic_daily WHERE user_id = $1 AND day BETWEEN $2 AND $3`, [userId, from, to],
  ))[0] || { upload_bytes: "0", download_bytes: "0" };

  const mappedDevices = devices.map((row) => ({
    deviceId: row.id, displayName: row.display_name, platform: row.platform, appVersion: row.app_version,
    publicKey: row.public_key, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at, lastActivityAt: row.last_activity_at, ...numbers(row),
  }));
  const mappedProfiles = profiles.map((row) => ({
    profileId: row.id, deviceId: row.device_id, protocol: row.protocol, nodeId: row.node_id, nodeName: row.node_name,
    regionName: row.region_name || "Unknown", regionCode: row.region_code || "", transport: row.transport,
    revision: row.revision, status: row.profile_status, clientAddress: row.client_address, issuedAt: row.issued_at,
    expiresAt: row.expires_at, updatedAt: row.updated_at, credentialIdentity: row.credential_identity || "",
    lastActivityAt: row.last_activity_at, trafficAttribution: "profile-validity-window", ...numbers(row),
  }));
  const mappedCertificates = certificates.map((row) => ({
    certificateId: row.id, authorityId: row.authority_id, deviceId: row.device_id, serial: row.serial, subject: row.subject,
    certificatePem: row.certificate_pem, fingerprint: certificateFingerprint(row.certificate_pem), status: row.certificate_status,
    notBefore: row.not_before, notAfter: row.not_after, revokedAt: row.revoked_at, createdAt: row.created_at,
    updatedAt: row.updated_at, authorityRealm: row.authority_realm, authorityStatus: row.authority_status,
    lastActivityAt: row.last_activity_at, trafficAttribution: "certificate-validity-window", ...numbers(row),
  }));
  return {
    from, to, updatedAt: currentTime, totals: numbers(totals),
    summary: {
      deviceCount: mappedDevices.length, activeDeviceCount: mappedDevices.filter((item) => item.status === "active").length,
      profileCount: mappedProfiles.length, activeProfileCount: mappedProfiles.filter((item) => ["issued", "active"].includes(item.status)).length,
      certificateCount: mappedCertificates.length, activeCertificateCount: mappedCertificates.filter((item) => item.status === "active").length,
    },
    devices: mappedDevices, profiles: mappedProfiles, certificates: mappedCertificates,
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
