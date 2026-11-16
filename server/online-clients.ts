import { dbQuery } from "./db";
import { writeOperationalLog } from "./operational-logs";

/**
 * Where an account's subscription is in use right now. Agents 2.18+ report, with every heartbeat, a short
 * hash of each source address connected to a subscription (by its identity key) over REALITY, Hysteria2 or
 * XHTTP. One address is one place: devices behind the same Wi-Fi count once, and a phone that moves from
 * Wi-Fi to mobile data counts twice until the old address has been quiet for {@link QUIET_MS}.
 *
 * Kept in memory only (never in Postgres): it is a few minutes of state, rebuilt by the next heartbeats
 * after a restart. Nothing is blocked on it yet; the Portal and Console show it, and accounts that stay
 * over their device limit are logged (account.online_over_limit) so sharing can be judged on real data.
 */
const QUIET_MS = 3 * 60_000;
const MAX_PER_IDENTITY = 64;
const seen = new Map<string, Map<string, number>>();

/** One Agent heartbeat's `onlineClients`: [{ identityKey, clients: [hash, ...] }]. Anything malformed is ignored. */
export function recordOnlineClients(value: unknown, at = Date.now()): void {
  if (!Array.isArray(value)) return;
  for (const entry of value.slice(0, 8192)) {
    if (!entry || typeof entry !== "object") continue;
    const { identityKey, clients } = entry as { identityKey?: unknown; clients?: unknown };
    if (typeof identityKey !== "string" || !/^[0-9a-f-]{36}$/.test(identityKey) || !Array.isArray(clients)) continue;
    const addresses = seen.get(identityKey) || new Map<string, number>();
    for (const client of clients.slice(0, MAX_PER_IDENTITY)) if (typeof client === "string" && /^[0-9a-f]{16}$/.test(client)) addresses.set(client, at);
    if (addresses.size) seen.set(identityKey, addresses);
  }
}

/** Distinct addresses using any of these identity keys within the last few minutes. */
export function onlineAddressCount(identityKeys: string[], at = Date.now()): number {
  const addresses = new Set<string>();
  for (const key of identityKeys) for (const [address, lastSeen] of seen.get(key) || []) if (at - lastSeen <= QUIET_MS) addresses.add(address);
  return addresses.size;
}

/** Drops addresses that have gone quiet; called from the minute jobs. */
export function pruneOnlineClients(at = Date.now()): void {
  for (const [key, addresses] of seen) {
    for (const [address, lastSeen] of addresses) if (at - lastSeen > QUIET_MS) addresses.delete(address);
    if (!addresses.size) seen.delete(key);
  }
}

/** How many places use the account at once: apps connected now plus places using its subscriptions. */
export async function accountOnline(userId: string): Promise<{ apps: number; subscription: number; total: number }> {
  const [row] = await dbQuery<{ apps: number; keys: string[] | null }>(`SELECT
      (SELECT count(DISTINCT l.enrollment_id) FROM native_leases l JOIN native_enrollments e ON e.id=l.enrollment_id
        WHERE e.user_id=$1 AND e.status='active' AND l.expires_at>now())::int AS apps,
      (SELECT array_agg(c.identity_key) FROM subscriptions s JOIN access_credentials c ON c.id=s.credential_id
        WHERE c.user_id=$1 AND c.deleted_at IS NULL) AS keys`, [userId]);
  const apps = Number(row?.apps || 0), subscription = onlineAddressCount(row?.keys || []);
  return { apps, subscription, total: apps + subscription };
}

const loggedAt = new Map<string, number>();

/** Minute job: accounts whose apps plus subscription places exceed the device limit, logged at most hourly each. */
export async function logAccountsOverLimit(at = Date.now()): Promise<void> {
  pruneOnlineClients(at);
  if (!seen.size) return;
  const rows = await dbQuery<{ user_id: string; email: string; device_limit: number; identity_key: string }>(`SELECT c.user_id,u.email,u.access_device_limit AS device_limit,c.identity_key
    FROM subscriptions s JOIN access_credentials c ON c.id=s.credential_id JOIN users u ON u.id=c.user_id
    WHERE c.identity_key=ANY($1::text[]) AND u.access_device_limit IS NOT NULL`, [[...seen.keys()]]);
  const accounts = new Map<string, { email: string; limit: number }>();
  for (const row of rows) accounts.set(row.user_id, { email: row.email, limit: Number(row.device_limit) });
  for (const [userId, account] of accounts) {
    if (at - (loggedAt.get(userId) || 0) < 3_600_000) continue;
    const online = await accountOnline(userId);
    if (online.total <= account.limit) continue;
    loggedAt.set(userId, at);
    await writeOperationalLog({ component: "controller", level: "warning", source: "system", action: "account.online_over_limit",
      message: `${account.email}: ${online.total} places online, device limit ${account.limit}`,
      target: { type: "user", id: userId }, fields: { online: online.total, apps: online.apps, subscription: online.subscription, limit: account.limit } });
  }
}
