import { dbQuery } from "./db";
import { accessByUser, accessSql } from "./entitlements";
import { billingMonth } from "./node-traffic";

/** Console overview: accounts warned this many days before their access runs out. */
export const EXPIRY_NOTICE_DAYS = 7;
/** Console overview: metered accounts warned once they have used this share of their data. */
export const QUOTA_NOTICE_RATIO = 0.8;
const LIST_LIMIT = 5;

export type OverviewAccount = { userId: string; displayName: string; email: string; expiresAt: string | null; usedBytes: number; quotaBytes: number };
type Access = { state: string; quotaBytes: number | null; usedBytes: number };

/** The month before `now`, as billingMonth spells it. */
export function previousBillingMonth(now = new Date()): string {
  return billingMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/** Usable metered accounts at or past the notice ratio, fullest first. */
export function nearQuota(access: Map<string, Access>, limit = LIST_LIMIT): { userId: string; usedBytes: number; quotaBytes: number }[] {
  return [...access].filter(([, item]) => item.state === "active" && item.quotaBytes && item.usedBytes >= item.quotaBytes * QUOTA_NOTICE_RATIO)
    .map(([userId, item]) => ({ userId, usedBytes: item.usedBytes, quotaBytes: item.quotaBytes! }))
    .sort((left, right) => right.usedBytes / right.quotaBytes - left.usedBytes / left.quotaBytes).slice(0, limit);
}

async function onlineNow() {
  // Same presence rules as the account access view: fresh node heartbeat, plus a live session per protocol.
  const recent = new Date(Date.now() - 90_000).toISOString();
  const handshake = new Date(Date.now() - 180_000).toISOString();
  const row = (await dbQuery<{ users: number; devices: number }>(`SELECT COUNT(DISTINCT COALESCE(d.user_id, c.user_id))::int AS users,
      COUNT(DISTINCT COALESCE(tc.device_id, tc.credential_id, tc.identity_key))::int AS devices
    FROM traffic_counters tc JOIN nodes n ON n.id = tc.node_id
    LEFT JOIN devices d ON d.id = tc.device_id LEFT JOIN access_credentials c ON c.id = tc.credential_id
    WHERE n.last_heartbeat_at > $1 AND COALESCE(d.user_id, c.user_id) IS NOT NULL AND (
      (tc.protocol = 'openvpn' AND tc.connected = 1 AND tc.observed_at > $1) OR
      (tc.protocol = 'wireguard' AND (tc.last_handshake_at > $2 OR tc.last_traffic_at > $1)) OR
      (tc.protocol NOT IN ('openvpn', 'wireguard') AND tc.last_traffic_at > $1))`, [recent, handshake]))[0];
  return { users: row?.users ?? 0, devices: row?.devices ?? 0 };
}

async function lastMonth() {
  const row = (await dbQuery<{ tx: string | null; rx: string | null }>(
    "SELECT SUM(tx_bytes)::text AS tx, SUM(rx_bytes)::text AS rx FROM node_traffic_monthly WHERE month = $1", [previousBillingMonth()]))[0];
  return row?.tx === null || row?.tx === undefined ? null : { txBytes: Number(row.tx), rxBytes: Number(row.rx) };
}

async function accounts(ids: string[]) {
  if (!ids.length) return new Map<string, { display_name: string; email: string }>();
  const rows = await dbQuery<{ id: string; display_name: string; email: string }>("SELECT id, display_name, email FROM users WHERE id = ANY($1)", [ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Accounts that may be near their quota: a total at or past the notice ratio needs at least one grant past it. */
async function quotaCandidates(): Promise<string[]> {
  return (await dbQuery<{ user_id: string }>(`SELECT DISTINCT g.user_id FROM access_grants g INNER JOIN users u ON u.id = g.user_id
    WHERE ${accessSql("u")} AND g.status = 'active' AND g.quota_bytes IS NOT NULL AND g.used_bytes >= g.quota_bytes * $1::numeric`, [QUOTA_NOTICE_RATIO])).map((row) => row.user_id);
}

async function computeOverviewStats() {
  const [online, previous, expiringRows, access] = await Promise.all([
    onlineNow(), lastMonth(),
    dbQuery<{ id: string; display_name: string; email: string; access_until: Date }>(`SELECT id, display_name, email, access_until FROM users u
      WHERE ${accessSql("u")} AND u.access_until IS NOT NULL AND u.access_until <= now() + make_interval(days => $1)
      ORDER BY u.access_until LIMIT ${LIST_LIMIT}`, [EXPIRY_NOTICE_DAYS]),
    quotaCandidates().then(accessByUser),
  ]);
  const full = nearQuota(access);
  const names = await accounts(full.map((item) => item.userId));
  return {
    online, lastMonth: previous,
    expiring: expiringRows.map((row): OverviewAccount => ({ userId: row.id, displayName: row.display_name, email: row.email,
      expiresAt: new Date(row.access_until).toISOString(), usedBytes: 0, quotaBytes: 0 })),
    nearQuota: full.filter((item) => names.has(item.userId)).map((item): OverviewAccount => ({ userId: item.userId,
      displayName: names.get(item.userId)!.display_name, email: names.get(item.userId)!.email, expiresAt: null, usedBytes: item.usedBytes, quotaBytes: item.quotaBytes })),
  };
}

/** Every open Console asks for these figures; within this window they share one computation. */
export const OVERVIEW_CACHE_MS = 15_000;
type OverviewStats = Awaited<ReturnType<typeof computeOverviewStats>>;
let cached: { at: number; value: Promise<OverviewStats> } | null = null;

/** Overview figures, at most {@link OVERVIEW_CACHE_MS} old; `fresh` (the Console's refresh button) recomputes them. */
export function overviewStats({ fresh = false } = {}): Promise<OverviewStats> {
  if (!fresh && cached && Date.now() - cached.at < OVERVIEW_CACHE_MS) return cached.value;
  const entry = { at: Date.now(), value: computeOverviewStats() };
  cached = entry;
  // A failed computation is not kept: the next request tries again.
  entry.value.catch(() => { if (cached === entry) cached = null; });
  return entry.value;
}
